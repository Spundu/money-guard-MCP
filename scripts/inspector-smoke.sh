#!/usr/bin/env bash
# The official MCP Inspector CLI against the built server (dist/), in both protocol eras (SPEC.md §7):
# tools/list with --strict must report no schema-portability findings at all, every tool must answer
# on the demo project, and a path outside the project must come back as a tool error (exit 5).
set -euo pipefail

INSPECTOR="@modelcontextprotocol/inspector@2.11.0"
KEY="k1=$(node -e "process.stdout.write('6b'.repeat(32))")" # the published TEST key of fixtures/shop
export MCP_INSPECTOR_SECRET_STORE=memory
MCP_STORAGE_DIR="$(mktemp -d)"
export MCP_STORAGE_DIR
export MCP_INSPECTOR_OAUTH_STATE_PATH="$MCP_STORAGE_DIR/oauth.json"
trap 'rm -rf "$MCP_STORAGE_DIR"' EXIT

inspect() {
  npx --yes "$INSPECTOR" --cli --format json --connect-timeout 60000 \
    -e MONEY_GUARD_ROOT=fixtures/shop -e "MONEY_GUARD_AUDIT_KEYS=$KEY" "$@" -- node dist/index.js
}

# Reads one Inspector JSON envelope on stdin and checks it with a JavaScript expression over `r`, in Node
# (no jq needed). The expression travels in an environment variable, so its quotes cannot break the script.
check() {
  CONDITION="$1" node -e "
    let s = '';
    process.stdin.on('data', (d) => (s += d)).on('end', () => {
      const r = JSON.parse(s);
      if (!new Function('r', 'return (' + process.env.CONDITION + ');')(r)) {
        console.error('FAILED: ' + process.env.CONDITION);
        console.error(s.slice(0, 2000));
        process.exit(1);
      }
    });"
}

for era in modern legacy; do
  inspect --protocol-era "$era" --method tools/list --strict |
    check "r.result.tools.map(t=>t.name).join()==='money_lint_schema,money_check_double_entry,audit_verify_chain' && !r.schemaFindings"
  inspect --protocol-era "$era" --method tools/call --tool-name money_lint_schema \
    --tool-args-json '{"migrations":"db/migrations"}' |
    check "r.result.structuredContent.error_count===1 && r.result.structuredContent.warning_count===1"
  inspect --protocol-era "$era" --method tools/call --tool-name money_check_double_entry \
    --tool-args-json '{"file":"exports/journal.csv","columns":{"transaction_id":"txn_id","amount":"amount_pence","currency":"currency"}}' |
    check "r.result.structuredContent.balanced===false && r.result.structuredContent.total_findings===4"
  inspect --protocol-era "$era" --method tools/call --tool-name audit_verify_chain \
    --tool-args-json '{"file":"logs/audit-tampered.jsonl"}' |
    check "r.result.structuredContent.break.code==='CONTENT_TAMPERED'"

  status=0
  inspect --protocol-era "$era" --method tools/call --tool-name money_check_double_entry \
    --tool-args-json '{"file":"../outside.csv","columns":{"transaction_id":"t","amount":"a"}}' > /dev/null 2>&1 || status=$?
  if [ "$status" -ne 5 ]; then
    echo "FAILED: a path outside the project should be a tool error (exit 5), got exit $status"
    exit 1
  fi
  echo "ok: $era era"
done
echo "Inspector smoke OK"
