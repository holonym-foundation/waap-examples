import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RecipeError } from "./errors.js";
import { assertHeld, type HeldLock } from "./lock.js";

/**
 * submitting   written (and fsynced) before waap-cli starts; outcome unknown until updated
 * pending      WaaP's outcome is unknown (timeout, crash, no confirmation)
 * unreconciled WaaP confirmed, but the chain readback has not yet shown the intended effect
 * mismatch     the chain shows something other than the intended effect (e.g. another signer)
 * reconciled   the intended effect was read back from chain (the only success state)
 * confirmed    legacy (first attempt): WaaP confirmed, never reconciled; kept closed for history
 */
export type JournalState =
  | "submitting"
  | "pending"
  | "unreconciled"
  | "mismatch"
  | "reconciled"
  | "confirmed"
  | "failed"
  | "rejected"
  | "acknowledged";

const STATES = new Set<JournalState>([
  "submitting",
  "pending",
  "unreconciled",
  "mismatch",
  "reconciled",
  "confirmed",
  "failed",
  "rejected",
  "acknowledged",
]);
export const OPEN_STATES: JournalState[] = ["submitting", "pending", "unreconciled", "mismatch"];

/** Everything needed to reconcile a submission later, from a fresh process. Bigints as strings. */
export interface ReconcileContext {
  obligationIdsBefore: string[];
  /** Existing obligation targeted (absent for a supply that creates one). */
  obligationId?: string;
  ctokensBefore?: string;
  amountMist?: string;
  expectedCtokens?: string;
  withdrawCtokens?: string;
  withdrawAll?: boolean;
  estimatedMist?: string;
  /** SHA-256 (hex) of the exact kind bytes handed to waap-cli; binds a user-supplied digest to this action. */
  kindSha256?: string;
  /** Node checkpoint height read just before the record was opened; the transaction must be later. */
  checkpointBefore?: string;
  /** "nonce-v1": the kind bytes carry a random per-submission nonce, so kindSha256 is unique (follow-up 3). */
  identity?: "nonce-v1";
}

export interface JournalRecord {
  id: string;
  at: string;
  state: JournalState;
  action?: "supply" | "withdraw";
  address?: string;
  summary?: string;
  digest?: string;
  note?: string;
  context?: ReconcileContext;
  report?: Record<string, unknown>;
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SUILEND_WAAP_STATE_DIR || path.join(os.homedir(), ".suilend-waap");
}

function validate(rec: unknown): rec is JournalRecord {
  const r = rec as JournalRecord;
  return (
    !!r &&
    typeof r === "object" &&
    typeof r.id === "string" &&
    r.id.length > 0 &&
    typeof r.at === "string" &&
    STATES.has(r.state) &&
    (r.digest === undefined || typeof r.digest === "string") &&
    (r.address === undefined || typeof r.address === "string") &&
    (r.action === undefined || r.action === "supply" || r.action === "withdraw")
  );
}

/**
 * Append-only log of submissions. A record stays open from just before waap-cli is started
 * until the intended effect is read back from chain (or a human acknowledges it), so a re-run
 * after a crash, timeout or delayed readback cannot blindly submit a second deposit/withdraw.
 * A file that cannot be fully parsed is unknown state: every reader fails closed.
 */
export class Journal {
  readonly file: string;
  constructor(readonly dir: string) {
    this.file = path.join(dir, "journal.jsonl");
  }

  /** fsync'd append; the directory is created on first write only (read-only commands leave no trace). */
  private append(rec: JournalRecord) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(this.file, "a", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(rec) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Bad lines: line number (1-based) and raw text. A missing final newline counts as truncated. */
  problems(): { line: number; raw: string }[] {
    if (!fs.existsSync(this.file)) return [];
    const lines = fs.readFileSync(this.file, "utf8").split("\n");
    const bad: { line: number; raw: string }[] = [];
    lines.forEach((raw, i) => {
      const last = i === lines.length - 1;
      if (last && raw === "") return;
      if (last) return void bad.push({ line: i + 1, raw }); // no trailing newline: interrupted write
      try {
        if (!validate(JSON.parse(raw))) bad.push({ line: i + 1, raw });
      } catch {
        bad.push({ line: i + 1, raw });
      }
    });
    return bad;
  }

  all(): JournalRecord[] {
    const bad = this.problems();
    if (bad.length > 0) {
      throw new RecipeError(
        "STATE_UNREADABLE",
        `The submission journal ${this.file} has ${bad.length} unreadable line(s) (${bad.map((b) => b.line).join(", ")}). ` +
          `Its open submissions are unknown, so nothing will be sent. Inspect the file; "journal repair" keeps a backup ` +
          `and replaces each bad line with an open record that still blocks until you check it and "journal ack" it.`,
        { file: this.file, lines: bad.map((b) => b.line) },
      );
    }
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as JournalRecord);
  }

  /** Latest record per id, merged with the fields of earlier records. */
  latest(): JournalRecord[] {
    const byId = new Map<string, JournalRecord>();
    for (const r of this.all()) byId.set(r.id, { ...byId.get(r.id), ...r });
    return [...byId.values()];
  }

  open(address?: string): JournalRecord[] {
    return this.latest().filter(
      (r) => OPEN_STATES.includes(r.state) && (!address || !r.address || r.address.toLowerCase() === address.toLowerCase()),
    );
  }

  /** Writes below require the held mutation lock of this state directory (`assertHeld`). */
  start(lock: HeldLock, fields: Omit<JournalRecord, "id" | "at" | "state">): string {
    assertHeld(this.dir, lock);
    const id = randomUUID();
    this.append({ id, at: new Date().toISOString(), state: "submitting", ...fields });
    return id;
  }

  update(lock: HeldLock, id: string, state: JournalState, fields: Partial<JournalRecord> = {}) {
    assertHeld(this.dir, lock);
    this.append({ ...fields, id, at: new Date().toISOString(), state });
  }

  /**
   * Replace unreadable lines with open placeholder records (raw text kept in `note`), after
   * saving a byte-for-byte backup. Never yields an empty journal that silently permits sending.
   */
  repair(lock: HeldLock): { backup?: string; replaced: number[] } {
    assertHeld(this.dir, lock);
    const bad = this.problems();
    if (bad.length === 0) return { replaced: [] };
    const backup = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(this.file, backup, fs.constants.COPYFILE_EXCL);
    const badLines = new Map(bad.map((b) => [b.line, b.raw]));
    const lines = fs.readFileSync(this.file, "utf8").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const out = lines.map((raw, i) =>
      badLines.has(i + 1)
        ? JSON.stringify({
            id: `corrupt-line-${i + 1}-${randomUUID()}`,
            at: new Date().toISOString(),
            state: "pending",
            note: `replaced unreadable journal line ${i + 1}; outcome unknown. raw: ${raw.slice(0, 2000)}`,
          } satisfies JournalRecord)
        : raw,
    );
    const tmp = `${this.file}.repair-${process.pid}`;
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeSync(fd, out.join("\n") + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
    return { backup, replaced: [...badLines.keys()] };
  }
}
