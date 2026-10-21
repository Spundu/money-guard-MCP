"""Summarize Inspect logs as a Markdown table: pass rate, recall, false alarms, tool calls, tokens,
cost and time per model. Run: python eval/summarize.py <log dir or files...>"""

import math
import sys
from pathlib import Path

from inspect_ai.log import read_eval_log
from inspect_ai.model import ChatMessageAssistant

# First-party API prices, US$ per million tokens (input, output), October 2026. Cache writes cost
# 1.25 times input, cache reads 0.1 times input.
PRICES = {
    "claude-opus-5-5": (4.00, 20.00),
    "claude-sonnet-5-5": (2.00, 10.00),
    "claude-haiku-5-5": (0.10, 0.50),
}


def cost(model: str, u) -> float:
    price_in, price_out = PRICES[model.split("/")[-1]]
    inp = (u.input_tokens or 0) + 1.25 * (u.input_tokens_cache_write or 0) + 0.1 * (u.input_tokens_cache_read or 0)
    return (inp * price_in + (u.output_tokens or 0) * price_out) / 1e6


def files(args: list[str]) -> list[Path]:
    out: list[Path] = []
    for a in args:
        p = Path(a)
        out += sorted(p.rglob("*.eval")) if p.is_dir() else [p]
    return out


rows = []
for f in files(sys.argv[1:]):
    log = read_eval_log(str(f))
    # A run cut off by a limit before it wrote a report is a harness failure, not a wrong answer:
    # it is counted apart and left out of the scores.
    cut = [s for s in log.samples or [] if s.limit and not s.output.completion]
    samples = [s for s in log.samples or [] if s.scores and s not in cut]
    if not samples:
        continue
    model = log.eval.model
    values = [next(iter(s.scores.values())).value for s in samples]
    n = len(values)
    passed = sum(v["pass"] for v in values) / n
    se = math.sqrt(passed * (1 - passed) / n) if n > 1 else 0.0
    calls = sum(len(m.tool_calls or []) for s in samples for m in s.messages if isinstance(m, ChatMessageAssistant))
    total_cost = sum(cost(model, u) for u in log.stats.model_usage.values())
    seconds = sum((s.working_time or 0) for s in samples)
    rows.append((
        model.split("/")[-1], n, f"{passed:.0%} ± {se:.0%}",
        f"{sum(v['recall'] for v in values) / n:.0%}",
        f"{sum(v['false_alarms'] for v in values) / n:.2f}",
        f"{calls / n:.1f}", f"${total_cost / n:.4f}", f"{seconds / n:.0f} s", f"${total_cost:.2f}", len(cut),
    ))

print("| Model | Runs | Pass | Recall | False alarms/run | Tool calls/run | Cost/run | Time/run | Total cost | Cut off |")
print("|---|---|---|---|---|---|---|---|---|---|")
for r in rows:
    print("| " + " | ".join(str(x) for x in r) + " |")
