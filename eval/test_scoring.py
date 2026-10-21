"""The eval's grader, checked without a model: a perfect report passes every case, an empty one
passes only the clean cases, and decoys or a missing PROBLEMS line fail. Run: pytest eval"""

import json
from pathlib import Path

import pytest

from money_guard_eval import grade, normalize, reported_items

CASES = json.loads((Path(__file__).parent / "cases.json").read_text(encoding="utf-8"))
IDS = [c["id"] for c in CASES]


def report(items: list[str]) -> str:
    return "Here is what I found.\n\nPROBLEMS: " + ("; ".join(items) if items else "none")


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_the_planted_problems_pass(case):
    assert grade(report(case["expected"]), case["expected"], case["decoys"]).value["pass"] == 1


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_an_empty_report_passes_only_clean_cases(case):
    value = grade(report([]), case["expected"], case["decoys"]).value
    assert value["pass"] == (1 if not case["expected"] else 0)


@pytest.mark.parametrize("case", [c for c in CASES if c["decoys"]], ids=[c["id"] for c in CASES if c["decoys"]])
def test_flagging_a_decoy_fails(case):
    value = grade(report(case["expected"] + case["decoys"][:1]), case["expected"], case["decoys"]).value
    assert value["pass"] == 0 and value["false_alarms"] == 1 and value["decoys_flagged"] == 1


def test_a_report_without_a_problems_line_fails():
    value = grade("invoices.total is a float.", ["invoices.total"], []).value
    assert value == {"pass": 0, "recall": 0, "false_alarms": 0, "decoys_flagged": 0}


def test_a_partial_report_gets_partial_recall():
    value = grade(report(["invoices.total"]), ["invoices.total", "txn:J101"], []).value
    assert value["pass"] == 0 and value["recall"] == 0.5


def test_the_last_problems_line_counts():
    answer = "PROBLEMS: invoices.total\n...on reflection...\nPROBLEMS: none"
    assert reported_items(answer) == []


@pytest.mark.parametrize(
    ("raw", "want"),
    [
        ("`public.invoices.total`", "invoices.total"),
        ("Invoices.Total.", "invoices.total"),
        ("logs/audit.jsonl#2", "audit.jsonl#2"),
        ("audit.jsonl #2", "audit.jsonl#2"),
        ("txn:J101", "txn:j101"),
    ],
)
def test_items_are_normalized(raw, want):
    assert normalize(raw) == want


def test_a_transaction_without_its_prefix_counts():
    assert grade(report(["J101"]), ["txn:J101"], []).value["pass"] == 1


@pytest.mark.parametrize(
    "line",
    [
        "invoices.total (double precision; should be bigint minor units); refunds.refund_amount (numeric); txn:J101 (legs net to 99; not 0)",
        "invoices.total stored as float8, should be bigint (fix via a new migration after 001_init.sql); refunds.refund_amount; J101",
        "public.invoices.total, refunds.refund_amount, txn:J101",
    ],
)
def test_explanations_after_each_item_are_ignored(line):
    value = grade("PROBLEMS: " + line, ["invoices.total", "refunds.refund_amount", "txn:J101"], ["invoices.vat_rate"]).value
    assert value == {"pass": 1, "recall": 1.0, "false_alarms": 0, "decoys_flagged": 0}


def test_a_file_name_in_an_explanation_is_not_an_item():
    # Haiku, run 1: the migration file in brackets was counted as a second finding.
    answer = "PROBLEMS: products.price (money type, migrations/0001_products.sql)"
    assert reported_items(answer) == ["products.price"]
    assert reported_items("PROBLEMS: invoices.total (see 001_init.sql)") == ["invoices.total"]


def test_an_extra_column_in_an_explained_list_is_a_false_alarm():
    value = grade("PROBLEMS: invoices.total (float); invoices.vat_rate (numeric)", ["invoices.total"], ["invoices.vat_rate"]).value
    assert value["pass"] == 0 and value["decoys_flagged"] == 1


def test_markdown_bold_problems_line_is_read():
    assert reported_items("**PROBLEMS:** invoices.total") == ["invoices.total"]
