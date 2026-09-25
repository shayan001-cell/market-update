"""Vendored, unmodified calculation engines from the open-source Agentic Trading Desk
(https://github.com/Oft3r/agentic-trading-desk, MIT License, Copyright (c) 2026 Oft3r).

OneView uses only the deterministic maths: the indicator stack, the three-pillar
scorecard and the macro-sentiment pillar. The project's broker link, autonomous
execution mandate and order hooks are deliberately NOT included: OneView shows the
scorecard as information and never places orders.
"""
from .indicators import compute as compute_indicators  # noqa: F401
from .macro_pillar import score_macro  # noqa: F401
from .score import score_symbol, score_trend, score_momentum, decide  # noqa: F401
