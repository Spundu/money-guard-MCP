# The eval's 16 cases

Each case is a small project in `cases/<id>/`, built by `build_cases.mjs`. **Planted** problems must be
reported; **decoys** look suspicious but are fine, and reporting one counts as a false alarm.
`check_cases.mjs` confirms that money-guard, called with the right arguments, reports every planted
problem and nothing on the clean cases.

| Case | Request (shortened) | Planted problems | Decoys |
|---|---|---|---|
| schema-float | Check this project for money problems | `invoices.total` is float8 | `vat_rate numeric(5,4)` (a rate) |
| schema-money-type | Are my migrations storing prices safely? | `products.price` uses the money type | `weight_kg real` (a weight) |
| schema-alter-later | Check this project | `payments.amount_pence` made double precision by a later ALTER | — |
| schema-clean | Check this project | none | `tax_rate numeric(5,4)` |
| schema-numeric | Do any money columns need changing? | `refunds.refund_amount` and `fees.fee` are numeric | `exchange_rate numeric(12,6)` |
| schema-dbmate | Check this project | `subscriptions.monthly_price` is real (dbmate up/down file) | — |
| ledger-unbalanced | Does the ledger in exports/ balance? | J101 is off by 99p | J100, J102 |
| ledger-clean | Does the ledger in exports/ balance? | none (one 3-leg transaction) | J200, J201 |
| ledger-json-fraction | Check data/ledger.json | P2 has fractional cents (10.5) | P1 |
| ledger-odd-headers | Is the bank export balanced? | T7 (headers "Txn Ref", "Ccy Amt") | T6 |
| ledger-currency | Check this project | X1 nets to zero only by mixing GBP and EUR | X2 |
| audit-tampered | Has anyone edited our audit log? | entry 2 edited after sealing | — |
| audit-intact | Has anyone edited our audit log? | none | — |
| mixed-ship | About to ship: check migrations and the export | `invoices.total`, `refunds.refund_amount`, J101 | `vat_rate` |
| mixed-clean | Anything wrong with how this app handles money? | none (schema, ledger and audit log all fine) | `discount_rate`, L1 |
| mixed-vague | Anything wrong with how this app handles money? | `wallets.balance` is double precision, W2 is off by 45p | W1 |

**Scoring.** A case **passes** when the report lists every planted problem and nothing else. Also
recorded: recall (share of planted problems found), false alarms, decoys flagged, tool calls, tokens,
cost and time. The model works as an MCP host runs it: only money-guard's tools, its server
instructions in the system prompt, no way to read files itself.
