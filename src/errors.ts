// Tool errors: the failures a model can act on. Each one reaches the client as an `isError: true`
// result whose text is `CODE: what went wrong. Fix: what to do.` (SPEC.md §2.5). The codes are public
// API (SPEC.md §2.9): never rename or remove one in a minor version; add new ones instead.

export type ErrorCode =
  // Shared by all tools (SPEC.md §2.5).
  | 'ROOT_INVALID'
  | 'PATH_INVALID'
  | 'PATH_OUTSIDE_ROOT'
  | 'PATH_NOT_FOUND'
  | 'NOT_A_FILE'
  | 'NOT_A_DIRECTORY'
  | 'FILE_TYPE_NOT_ALLOWED'
  | 'SENSITIVE_PATH'
  | 'FILE_TOO_LARGE'
  | 'FILE_UNREADABLE'
  | 'BUSY'
  | 'INTERNAL_ERROR'
  // money_lint_schema (SPEC.md §3.8).
  | 'MIGRATION_FAILED'
  | 'SETUP_FAILED'
  | 'NO_SQL_FILES'
  | 'TOO_MANY_FILES'
  | 'FILE_NOT_IN_FOLDER'
  | 'BAD_COLUMN_NAME'
  | 'TIMEOUT'
  // money_check_double_entry (SPEC.md §4.7).
  | 'PARSE_ERROR'
  | 'COLUMN_NOT_FOUND'
  | 'COLUMN_AMBIGUOUS'
  | 'MAPPING_INVALID'
  | 'RECORDS_NOT_ARRAY'
  | 'TOO_MANY_ROWS'
  // audit_verify_chain (SPEC.md §5.6).
  | 'KEYS_NOT_CONFIGURED'
  | 'KEYS_INVALID';

export class ToolError extends Error {
  override name = 'ToolError';

  /**
   * @param message what went wrong, as one or two plain sentences ending in a full stop. It may quote
   *   file content only through `clip` (echo.ts), never a key.
   * @param fix what the model (or the person) should do next, as plain sentences.
   */
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fix: string,
  ) {
    super(message);
  }

  /** The one text block the model reads. The code comes first so a program can read it too. */
  toText(): string {
    return `${this.code}: ${this.message} Fix: ${this.fix}`;
  }
}
