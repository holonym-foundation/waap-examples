/** Stable codes an agent can branch on; each maps to one process exit code. */
export const EXIT_CODES = {
  OK: 0,
  UNEXPECTED: 1,
  INVALID_INPUT: 2,
  PREFLIGHT_REFUSED: 3,
  SIMULATION_FAILED: 4,
  WAAP_REJECTED: 5,
  ONCHAIN_FAILED: 6,
  PENDING_UNKNOWN: 7,
  BLOCKED_BY_PENDING: 8,
  /** Another process holds this state directory's mutation lock (or a dead one left it). */
  LOCKED: 9,
  /** The local journal cannot be fully read: open submissions are unknown. */
  STATE_UNREADABLE: 10,
  /** The chain shows something other than the intended effect (e.g. another signer). */
  RECONCILE_FAILED: 11,
} as const;

export type RecipeErrorCode = Exclude<keyof typeof EXIT_CODES, "OK">;

export class RecipeError extends Error {
  constructor(
    readonly code: RecipeErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RecipeError";
  }
}
