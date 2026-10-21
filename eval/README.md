# Agent evaluation: does Claude use money-guard well?

The tests prove that the tools give the right answers. This eval asks a different question: given only
money-guard's tools and a developer's request, does a model find the money problems planted in a
project, and nothing else?

It is built with [Inspect](https://inspect.aisi.org.uk), the UK AI Security Institute's evaluation
framework.

## Results (run 1, 21 October 2026)

16 cases, each run twice per model. A case **passes** only when the final report lists every planted
problem and nothing else.

| Model | Pass | Planted problems found | False alarms per run | Tool calls per run | Cost per run | Working time per run |
|---|---|---|---|---|---|---|
| Claude Opus 5.5 | 32 / 32 | 100% | 0 | 3.2 | $0.037 | 16 s |
| Claude Sonnet 5.5 | 32 / 32 | 100% | 0 | 3.9 | $0.018 | 12 s |
| Claude Haiku 5.5 | 29 / 32 | 94% | 0 | 3.0 | $0.001 | 9 s |

The whole run cost $1.79 at first-party API prices. Models ran at their default settings. The logs are
in `logs/run1/`: open them with `inspect view --log-dir eval/logs/run1` to read every transcript.

**What the misses show.** Haiku's three failures were all about finding the data, not reading it:

- Twice, on `mixed-vague`, it found the float `wallets.balance` but never looked inside `exports/`.
  It said it could not list the folder. It could have: money-guard lists a folder's contents when a
  path is wrong, and the bigger models used that.
- Once, on `ledger-currency`, it got a `COLUMN_NOT_FOUND` that named the file's fields (`id`,
  `amount_minor`, `currency`) and asked the developer instead of mapping them.

No model reported a decoy, such as a VAT rate stored as `numeric`, or the `weight_kg` float that
money-guard itself lists as "check that none holds money".

**Limits.** These are 16 small projects written for the eval, not real ones, so a perfect score means
"no failure seen here", not "never fails". With 32 runs per model, one more failure moves the pass
rate by about 3 points. The model must end its report with a `PROBLEMS:` line so that grading is
exact; real hosts don't ask for one. The scorer reads only that line, so advice quality is not graded.

## The cases

[CASES.md](CASES.md) lists all 16, each with its planted problems and decoys. They cover the three tools
(schema, ledger, audit log), clean projects where the right answer is "no problems", and mixed projects
with vague requests. `build_cases.mjs` writes them to `cases/`.

## How a run works

For each case, `money_guard_eval.py` starts money-guard over stdio on the case's project folder, as an
MCP host would. It puts the server's own instructions in the system prompt and gives the model only
money-guard's three tools: it cannot read files itself, like a user of Claude Desktop. The model
works until it submits a report. The scorer compares the identifiers on the report's last line with
the planted problems.

## The checks that need no model

CI runs these on every push:

- `node eval/build_cases.mjs` rewrites the cases, and CI fails if they differ from the committed ones.
- `node eval/check_cases.mjs` calls money-guard itself on every case with the right arguments, and
  fails unless it reports exactly the planted problems. So every case can be solved with the tools,
  and the clean ones come back clean.
- `pytest eval` tests the scorer. A perfect report passes every case, and "none" passes only the clean
  ones. A decoy, a missing `PROBLEMS:` line or a partial list fails. Explanations after each item are
  ignored.

Building it also found two bugs in the scorer, both now tested. The first trial counted explanations
as findings, and the full run counted a file name in brackets as one.

## Running it

You need Python 3.12, an Anthropic API key in `ANTHROPIC_API_KEY`, and `npm run build` done first.

```sh
python -m venv eval/.venv
eval/.venv/Scripts/python -m pip install -r eval/requirements.txt   # bin/ instead of Scripts/ on Linux and macOS
eval/.venv/Scripts/inspect eval eval/money_guard_eval.py --model anthropic/claude-sonnet-5-5 --epochs 2 --max-samples 4
eval/.venv/Scripts/python eval/summarize.py eval/logs
```

Keep `--max-samples` low. With many cases at once, each starting its own database thread, the first
attempt hit rate limits and most runs ran out of time before answering. The eval now limits working
time, not waiting time, and `summarize.py` counts a run cut off before its report as "cut off", not
as a failure.
