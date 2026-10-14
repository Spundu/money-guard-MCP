// The size budget of a result (SPEC.md §2.4). Caps on list lengths keep a result small with ordinary
// names; long identifiers, deep folders or long locations can still push it over, so a tool shortens
// its least important lists until the JSON fits, and flags what it cut.

/** At most this many characters of JSON per result: well under what MCP clients show inline. */
export const MAX_RESULT_CHARS = 20_000;

/** True while `result`, as the JSON text the client receives, is over the budget. */
export function overBudget(result: object): boolean {
  return JSON.stringify(result).length > MAX_RESULT_CHARS;
}
