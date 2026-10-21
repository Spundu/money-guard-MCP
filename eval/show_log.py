"""Print each sample of an Inspect log: the tool calls, the scores and the report's last lines.
Run: python eval/show_log.py <log file> [--full]"""

import sys

from inspect_ai.log import read_eval_log
from inspect_ai.model import ChatMessageAssistant, ChatMessageTool

log = read_eval_log(sys.argv[1])
full = "--full" in sys.argv
print(log.eval.model, log.status)
for s in log.samples or []:
    print(f"\n=== {s.id} (epoch {s.epoch})")
    for m in s.messages:
        if isinstance(m, ChatMessageAssistant):
            for call in m.tool_calls or []:
                print(f"  call {call.function} {call.arguments}")
        elif isinstance(m, ChatMessageTool) and full:
            print(f"  -> {str(m.text)[:600]}")
    for name, score in (s.scores or {}).items():
        print(f"  score {score.value}  answer: {score.answer}  ({score.explanation})")
    tail = (s.output.completion or "").strip().splitlines()[-4:]
    print("  report ends:", " | ".join(tail))
    if s.error:
        print("  ERROR", s.error.message[:300])
