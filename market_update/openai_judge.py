"""Any OpenAI-compatible model as the judge: DeepSeek, Qwen, Kimi, GLM and others, called directly
(DeepSeek, Alibaba Model Studio, Moonshot, Zhipu) or through a host (AWS Bedrock, Azure AI Foundry,
Google Vertex, OpenRouter, Groq, Together, Fireworks).

Same contract as claude_judge.ClaudeClient: the question sets in judgments.py, one call per state, a
probability for every option, answers in TypeSafe's shape. The model is asked through a forced function
call; hosts or models that ignore tools get one retry asking for plain JSON instead.

Settings (env):
  MU_AI_PROVIDER    deepseek | openai            (openai = any compatible host, set the three below)
  MU_OPENAI_BASE_URL  e.g. https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1
  MU_OPENAI_API_KEY   the host's key (DEEPSEEK_API_KEY is read for the deepseek preset)
  MU_OPENAI_MODEL     the host's model id
"""
from __future__ import annotations

import json
import os
import re
from typing import Any

from . import config
from .claude_judge import SYSTEM, describe, to_answers, tool_schema

PRESETS = {   # provider -> (base_url, key env, default model)
    "deepseek": ("https://api.deepseek.com", "DEEPSEEK_API_KEY", "deepseek-flash"),
}


def settings() -> tuple[str, str, str]:
    base, key_env, model = PRESETS.get(config.AI_PROVIDER, ("", "MU_OPENAI_API_KEY", ""))
    base = os.environ.get("MU_OPENAI_BASE_URL") or base
    key = os.environ.get("MU_OPENAI_API_KEY") or os.environ.get(key_env) or ""
    model = os.environ.get("MU_OPENAI_MODEL") or model
    return base, key, model


def _json_from_text(text: str) -> dict[str, Any]:
    text = re.sub(r"^```(?:json)?|```$", "", (text or "").strip(), flags=re.M).strip()
    try:
        return json.loads(text)
    except ValueError:
        m = re.search(r"\{.*\}", text, flags=re.S)
        return json.loads(m.group(0)) if m else {}


class OpenAICompatClient:
    def __init__(self) -> None:
        import openai
        self._openai = openai
        self.base_url, key, self.model = settings()
        if not (self.base_url and key and self.model):
            raise RuntimeError("set MU_OPENAI_BASE_URL, MU_OPENAI_API_KEY and MU_OPENAI_MODEL (or DEEPSEEK_API_KEY for the deepseek preset)")
        self.client = openai.AsyncOpenAI(base_url=self.base_url, api_key=key, max_retries=2, timeout=90)
        self._prep: dict[int, tuple[str, dict[str, Any]]] = {}
        self.tools_ok = True                   # flips to False once a host shows it ignores tools

    def _prepared(self, questions: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        k = id(questions)
        if k not in self._prep:
            t = tool_schema(questions)
            self._prep[k] = (describe(questions), {"type": "function", "function": {
                "name": t["name"], "description": t["description"], "parameters": t["input_schema"]}})
        return self._prep[k]

    async def ask(self, state: dict[str, Any], questions: dict[str, Any]) -> tuple[dict[str, Any], int, int]:
        qtext, tool = self._prepared(questions)
        msgs = [{"role": "system", "content": SYSTEM + "\n\nQuestions:\n" + qtext},
                {"role": "user", "content": "State:\n" + json.dumps(state, ensure_ascii=False, default=str)}]
        tin = tout = 0
        raw: dict[str, Any] = {}
        if self.tools_ok:
            try:
                r = await self.client.chat.completions.create(
                    model=self.model, messages=msgs, tools=[tool], max_tokens=config.CLAUDE_MAX_TOKENS,
                    tool_choice={"type": "function", "function": {"name": "answer"}})
                tin, tout = self._usage(r)
                calls = r.choices[0].message.tool_calls or []
                if calls:
                    raw = json.loads(calls[0].function.arguments or "{}")
                else:
                    raw = _json_from_text(r.choices[0].message.content or "")
            except self._openai.BadRequestError as e:
                if "tool" not in str(e).lower():
                    raise
                self.tools_ok = False         # this host or model has no function calling: JSON from here on
        if not raw:
            schema = json.dumps(tool["function"]["parameters"]["properties"], ensure_ascii=False)
            r = await self.client.chat.completions.create(
                model=self.model, max_tokens=config.CLAUDE_MAX_TOKENS,
                messages=msgs + [{"role": "user", "content": "Reply with only one JSON object, no prose, in this shape (one entry per question):\n" + schema}])
            a, b = self._usage(r)
            tin, tout = tin + a, tout + b
            raw = _json_from_text(r.choices[0].message.content or "")
        ans = to_answers(questions, raw)
        for v in ans.values():
            v["engine"] = config.AI_PROVIDER
        return ans, tin, tout

    @staticmethod
    def _usage(r: Any) -> tuple[int, int]:
        u = getattr(r, "usage", None)
        return (int(getattr(u, "prompt_tokens", 0) or 0), int(getattr(u, "completion_tokens", 0) or 0)) if u else (0, 0)

    def is_billing_error(self, e: Exception) -> bool:
        m = str(e).lower()
        return getattr(e, "status_code", None) == 402 or "insufficient balance" in m or "insufficient_quota" in m or "credit" in m
