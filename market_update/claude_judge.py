"""Claude as the model behind every judgment (a drop-in for TypeSafe's `system_one`).

The question sets in `judgments.py` stay exactly as they are: Choice, Noul and Score objects with
instructions and criteria. This module shows Claude the state and the questions, makes it answer every
question in one forced tool call with a probability for each option, and turns those probabilities into
the same answer shape `analyze._answers_to_dict` produces from TypeSafe:

  choice -> {"type": "choice", "choice", "confidence", "probabilities"}
  score  -> {"type": "score",  "score",  "confidence", "probabilities"}   (keys "0".."n-1")
  noul   -> {"type": "noul",   "p"}

so nothing downstream knows which engine answered. Answers carry "engine": "claude".
"""
from __future__ import annotations

import json
import os
from typing import Any

from . import config

SYSTEM = (
    "You are the judgment engine of OneView, a market desk for US day traders, swing traders and long-term "
    "investors. You receive one `state` (facts about a stock, a headline, the market, an options chain or a post) "
    "and a set of questions. Answer every question from the state alone: do not invent prices, news or events "
    "that are not in it, and when the state is thin, spread your probabilities instead of guessing.\n\n"
    "Question types:\n"
    "- choice: pick among the named options; give a probability for EVERY option (they must sum to 1).\n"
    "- score: an ordered rubric, level 0 is the first criterion; give a probability for EVERY level (sum to 1).\n"
    "- noul: the probability (0 to 1) that the `true` condition holds rather than the `false` one.\n\n"
    "Probabilities are your honest uncertainty: 0.9 means you would be right about nine times in ten. "
    "Answer only through the `answer` tool."
)


def _text(x: Any) -> Any:
    """JSONContent (str, list, dict) -> something json.dumps can print."""
    return x if isinstance(x, (str, int, float, list, dict)) or x is None else str(x)


def _qtype(q: Any) -> str:
    return getattr(q, "type", None) or type(q).__name__.lower()


def _options(q: Any) -> list[str]:
    c = getattr(q, "criteria", None)
    return list(c.keys()) if isinstance(c, dict) else []


def describe(questions: dict[str, Any]) -> str:
    """The question set as plain JSON for the prompt (stable per set, so it caches well)."""
    out: dict[str, Any] = {}
    for k, q in questions.items():
        t = _qtype(q)
        d: dict[str, Any] = {"type": t}
        if getattr(q, "instructions", None):
            d["instructions"] = _text(q.instructions)
        crit = getattr(q, "criteria", None)
        if t == "choice":
            d["options"] = {o: _text(v) for o, v in (crit or {}).items()}
        elif t == "score":
            d["levels"] = {str(i): _text(v) for i, v in enumerate(crit or [])}
        elif t == "noul" and crit:
            d["criteria"] = {kk: _text(vv) for kk, vv in dict(crit).items()}
        out[k] = d
    return json.dumps(out, ensure_ascii=False, indent=1)


def tool_schema(questions: dict[str, Any]) -> dict[str, Any]:
    props: dict[str, Any] = {}
    for k, q in questions.items():
        t = _qtype(q)
        if t == "noul":
            props[k] = {"type": "object", "properties": {"p_true": {"type": "number", "minimum": 0, "maximum": 1}}, "required": ["p_true"]}
        else:
            keys = _options(q) if t == "choice" else [str(i) for i in range(len(getattr(q, "criteria", None) or []))]
            props[k] = {"type": "object", "properties": {"probabilities": {
                "type": "object", "properties": {o: {"type": "number", "minimum": 0, "maximum": 1} for o in keys}, "required": keys}},
                "required": ["probabilities"]}
    return {"name": "answer", "description": "Answer every question in the set.",
            "input_schema": {"type": "object", "properties": props, "required": list(props)}}


def _norm(probs: dict[str, Any], keys: list[str]) -> dict[str, float]:
    vals = {k: max(0.0, float(probs.get(k, 0) or 0)) for k in keys}
    tot = sum(vals.values())
    if tot <= 0:
        return {k: round(1 / len(keys), 4) for k in keys}
    return {k: round(v / tot, 4) for k, v in vals.items()}


def to_answers(questions: dict[str, Any], raw: dict[str, Any]) -> dict[str, Any]:
    """Tool input -> TypeSafe-shaped answers. A question the model skipped is simply absent (rules fill it)."""
    out: dict[str, Any] = {}
    for k, q in questions.items():
        a = raw.get(k)
        if not isinstance(a, dict):
            continue
        t = _qtype(q)
        try:
            if t == "noul":
                out[k] = {"type": "noul", "p": round(min(1.0, max(0.0, float(a["p_true"]))), 4), "engine": "claude"}
            elif t == "choice":
                keys = _options(q)
                p = _norm(a.get("probabilities") or {}, keys)
                pick = max(p, key=p.get)
                out[k] = {"type": "choice", "choice": pick, "confidence": p[pick], "probabilities": p, "engine": "claude"}
            elif t == "score":
                keys = [str(i) for i in range(len(q.criteria))]
                p = _norm(a.get("probabilities") or {}, keys)
                out[k] = {"type": "score", "score": round(sum(int(i) * v for i, v in p.items()), 4),
                          "confidence": max(p.values()), "probabilities": p, "engine": "claude"}
        except (KeyError, TypeError, ValueError):
            continue
    return out


class ClaudeClient:
    """One shared async client. `ask` returns (answers, input_tokens, output_tokens)."""

    def __init__(self) -> None:
        import anthropic  # imported here so a TypeSafe-only install never needs it
        self._anthropic = anthropic
        self.client = anthropic.AsyncAnthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"), max_retries=2, timeout=60)
        self._schemas: dict[int, tuple[str, dict[str, Any]]] = {}

    def _prepared(self, questions: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        key = id(questions)                 # the question sets are module-level constants
        if key not in self._schemas:
            self._schemas[key] = (describe(questions), tool_schema(questions))
        return self._schemas[key]

    async def ask(self, state: dict[str, Any], questions: dict[str, Any]) -> tuple[dict[str, Any], int, int]:
        qtext, tool = self._prepared(questions)
        msg = await self.client.messages.create(
            model=config.CLAUDE_MODEL,
            max_tokens=config.CLAUDE_MAX_TOKENS,
            system=[{"type": "text", "text": SYSTEM},
                    {"type": "text", "text": "Questions:\n" + qtext, "cache_control": {"type": "ephemeral"}}],
            tools=[tool],
            tool_choice={"type": "tool", "name": "answer"},
            messages=[{"role": "user", "content": "State:\n" + json.dumps(state, ensure_ascii=False, default=str)}],
        )
        raw = next((b.input for b in msg.content if getattr(b, "type", "") == "tool_use"), {}) or {}
        u = msg.usage
        tin = int(getattr(u, "input_tokens", 0) or 0) + int(getattr(u, "cache_read_input_tokens", 0) or 0) + int(getattr(u, "cache_creation_input_tokens", 0) or 0)
        return to_answers(questions, raw), tin, int(getattr(u, "output_tokens", 0) or 0)

    def is_billing_error(self, e: Exception) -> bool:
        m = str(e).lower()
        return "credit balance" in m or "billing" in m or getattr(e, "status_code", None) == 402

    def is_api_error(self, e: Exception) -> bool:
        return isinstance(e, self._anthropic.AnthropicError)

    async def close(self) -> None:
        await self.client.close()
