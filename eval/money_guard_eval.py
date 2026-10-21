"""Does a Claude model, given only money-guard's tools and a developer's request, find the money
problems planted in a project, and only those?

Each case in cases.json is a small project (cases/<id>/) with problems planted on purpose
(`expected`) and things that look suspicious but are fine (`decoys`, such as a VAT rate stored as
numeric). The model works as an MCP host would run it: money-guard is started over stdio on that
project, its server instructions go in the system prompt, and the model can only call its three
tools. It ends with a report whose last line lists what it found; the scorer compares that list
with the planted problems.

Run (needs ANTHROPIC_API_KEY and `npm run build` first):
    inspect eval eval/money_guard_eval.py --model anthropic/claude-sonnet-5-5 --epochs 2
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

from inspect_ai import Task, task
from inspect_ai.agent import AgentSubmit, as_solver, react
from inspect_ai.dataset import Sample
from inspect_ai.scorer import Score, Target, mean, scorer, stderr
from inspect_ai.solver import Generate, Solver, TaskState, solver
from inspect_ai.tool import mcp_server_stdio, mcp_tools

HERE = Path(__file__).resolve().parent
SERVER = HERE.parent / "dist" / "index.js"
# The published TEST key of scripts/fixtures.mts, which also sealed the eval's audit logs.
AUDIT_KEYS = "k1=" + "6b" * 32

REPORT_RULES = """When you have finished, call submit with your report to the developer. Write the report as you
normally would, then end it with one last line in exactly this form, listing every money problem you
found in the project:
PROBLEMS: <item>; <item>
Write a database column as table.column, a ledger transaction as txn:<transaction id>, and an audit
log entry as <file name>#<entry number>, with no explanation on that line. If you found no problems,
write: PROBLEMS: none"""


def server_instructions() -> str:
    """The instructions money-guard sends at initialize, which an MCP host shows the model."""
    script = "import('./dist/text.js').then((m) => process.stdout.write(m.INSTRUCTIONS))"
    node = shutil.which("node") or "node"
    return subprocess.run([node, "-e", script], cwd=HERE.parent, capture_output=True, text=True, check=True).stdout


def system_prompt() -> str:
    return (
        "You are a coding assistant helping a developer with the project in the current folder. "
        "You cannot read or edit files yourself: the only tools you have are those of the money-guard "
        "MCP server, whose paths are relative to the project folder.\n\n"
        f"The money-guard server's instructions:\n{server_instructions()}\n\n{REPORT_RULES}"
    )


def load_cases() -> list[Sample]:
    cases = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))
    return [
        Sample(
            id=c["id"],
            input=c["prompt"],
            target=c["expected"],
            metadata={"expected": c["expected"], "decoys": c["decoys"], "tags": c["tags"]},
        )
        for c in cases
    ]


@solver
def money_guard_agent(prompt: str) -> Solver:
    """A ReAct agent whose only tools are a money-guard server started on the case's project."""

    async def solve(state: TaskState, generate: Generate) -> TaskState:
        server = mcp_server_stdio(
            name="money-guard",
            command=shutil.which("node") or "node",
            args=[str(SERVER)],
            env={"MONEY_GUARD_ROOT": str(HERE / "cases" / str(state.sample_id)), "MONEY_GUARD_AUDIT_KEYS": AUDIT_KEYS},
        )
        agent = react(prompt=prompt, tools=[mcp_tools(server)], submit=AgentSubmit(answer_only=True))
        return await as_solver(agent)(state, generate)

    return solve


PROBLEMS_LINE = re.compile(r"^\s*\**\s*PROBLEMS\s*:\**\s*(.*)$", re.IGNORECASE | re.MULTILINE)


def normalize(item: str) -> str:
    """One reported item in the form the cases use: lower case, no quotes, no schema or folder."""
    item = item.strip().strip("`'\"*. ").lower()
    item = re.sub(r"^public\.", "", item)
    if "#" in item:
        name, _, entry = item.partition("#")
        return f"{name.rsplit('/', 1)[-1].strip()}#{entry.strip()}"
    return item


# A transaction, an audit entry, or a table.column (an optional schema in front).
IDENTIFIER = re.compile(
    r"txn:[^\s;,()]+|[\w.-]+\s*#\s*\d+|\b(?:[A-Za-z_]\w*\.)?[A-Za-z_]\w*\.[A-Za-z_]\w*\b", re.IGNORECASE
)
FILE_NAME = re.compile(r"\.(sql|csv|jsonl?|md|txt)$", re.IGNORECASE)


def reported_items(answer: str) -> list[str] | None:
    """The identifiers on the report's last PROBLEMS line, whatever explanation follows each one;
    None when there is no such line. A part with no identifier counts only if it is one bare word
    (a transaction id written without txn:), so explanations never become items."""
    lines = PROBLEMS_LINE.findall(answer)
    if not lines:
        return None
    body = lines[-1].strip()
    if body.lower().strip(" .") in ("none", ""):
        return []
    items: list[str] = []
    for part in re.split(r";" if ";" in body else r",", body):
        found = [i for i in IDENTIFIER.findall(part) if "#" in i or not FILE_NAME.search(i.rstrip(").,"))]
        if found:
            items += [normalize(i) for i in found]
        elif re.fullmatch(r"[\w-]+", part.strip().strip("`'\"*. ")):
            items.append(normalize(part))
    return list(dict.fromkeys(items))


def matches(item: str, wanted: str) -> bool:
    """A transaction may be written without its txn: prefix."""
    return item == wanted or (wanted.startswith("txn:") and item == wanted[4:])


@scorer(metrics={"pass": [mean(), stderr()], "recall": [mean()], "false_alarms": [mean()], "decoys_flagged": [mean()]})
def found_planted_problems():
    """pass = every planted problem reported and nothing else; recall over the planted problems;
    false_alarms = reported items that are not planted problems (decoys included)."""

    async def score(state: TaskState, target: Target) -> Score:
        return grade(state.output.completion, state.metadata["expected"], state.metadata["decoys"])

    return score


def grade(answer: str, expected: list[str], decoys: list[str]) -> Score:
    """The score of one report against a case's planted problems and decoys."""
    expected = [e.lower() for e in expected]
    decoys = [d.lower() for d in decoys]
    items = reported_items(answer)
    if items is None:
        return Score(
            value={"pass": 0, "recall": 0, "false_alarms": 0, "decoys_flagged": 0},
            answer=answer[-300:],
            explanation="no PROBLEMS line in the report",
        )
    found = [e for e in expected if any(matches(i, e) for i in items)]
    extra = [i for i in items if not any(matches(i, e) for e in expected)]
    flagged = [d for d in decoys if any(matches(i, d) for i in items)]
    recall = len(found) / len(expected) if expected else 1.0
    ok = len(found) == len(expected) and not extra
    return Score(
        value={"pass": int(ok), "recall": recall, "false_alarms": len(extra), "decoys_flagged": len(flagged)},
        answer="; ".join(items) or "none",
        explanation=f"missed: {sorted(set(expected) - set(found)) or 'nothing'}; extra: {extra or 'nothing'}",
    )


@task
def money_guard() -> Task:
    if not SERVER.exists():
        raise FileNotFoundError("dist/index.js is missing: run `npm run build` first")
    return Task(
        dataset=load_cases(),
        solver=money_guard_agent(system_prompt()),
        scorer=found_planted_problems(),
        message_limit=40,
        working_limit=300,
    )
