import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";
import { WAAP_CHAIN } from "./constants.js";
import { RecipeError } from "./errors.js";

export interface WaapEvent {
  event: string;
  [k: string]: unknown;
}

export interface WaapRun {
  exitCode: number;
  events: WaapEvent[];
  stdoutText: string[];
}

export interface WaapOptions {
  /** Command + leading args. Default: the pinned @human.tech/waap-cli in node_modules, run with this Node. */
  command?: string[];
  env?: NodeJS.ProcessEnv;
  /** Called for every NDJSON event as soon as its line arrives (used to surface 2FA links promptly). */
  onEvent?: (e: WaapEvent) => void;
  onStderr?: (line: string) => void;
  /** Non-JSON stdout lines (e.g. waap-cli's interactive prompts); never silently dropped. */
  onText?: (line: string) => void;
  /**
   * What the child's stdin is when no stdin text is given. waap-cli reads a phone-2FA code from
   * its own stdin, so a human at a terminal must be connected to it. Default: the parent's
   * stdin when it is a TTY, otherwise nothing.
   */
  childStdin?: "inherit" | "ignore" | { text: string };
}

export function defaultWaapCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.WAAP_CLI_BIN) return [env.WAAP_CLI_BIN];
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve("@human.tech/waap-cli/package.json");
  return [process.execPath, path.join(path.dirname(pkgJson), "dist", "index.js")];
}

/**
 * Run waap-cli, streaming stdout line by line. Never kills the child: waap-cli owns its own
 * timeouts (2FA expiry, 90 s confirmation wait), and killing mid-broadcast would turn a
 * known outcome into an unknown one.
 */
export function runWaap(args: string[], stdin: string | undefined, opts: WaapOptions = {}): Promise<WaapRun> {
  const [cmd, ...pre] = opts.command ?? defaultWaapCommand(opts.env);
  return new Promise((resolve, reject) => {
    const stdinMode = stdin !== undefined ? { text: stdin } : (opts.childStdin ?? (process.stdin.isTTY ? "inherit" : "ignore"));
    const child = spawn(cmd, [...pre, ...args], {
      env: opts.env ?? process.env,
      stdio: [typeof stdinMode === "string" ? stdinMode : "pipe", "pipe", "pipe"],
    });
    const events: WaapEvent[] = [];
    const stdoutText: string[] = [];
    let closedStreams = 0;
    let exitCode: number | null = null;
    const finish = () => {
      if (closedStreams === 2 && exitCode !== null) resolve({ exitCode, events, stdoutText });
    };
    child.on("error", (err) =>
      reject(new RecipeError("UNEXPECTED", `Could not start waap-cli (${cmd}): ${err.message}`)),
    );
    createInterface({ input: child.stdout! })
      .on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object" && typeof parsed.event === "string") {
            events.push(parsed);
            opts.onEvent?.(parsed);
            return;
          }
        } catch {
          /* not NDJSON: keep as text */
        }
        stdoutText.push(trimmed);
        opts.onText?.(trimmed);
      })
      .on("close", () => {
        closedStreams++;
        finish();
      });
    createInterface({ input: child.stderr! })
      .on("line", (line) => opts.onStderr?.(line))
      .on("close", () => {
        closedStreams++;
        finish();
      });
    child.on("exit", (code, signal) => {
      exitCode = code ?? (signal ? 128 : 1);
      finish();
    });
    if (child.stdin) {
      child.stdin.on("error", () => {
        /* child may exit before reading stdin; its exit code reports why */
      });
      child.stdin.end(typeof stdinMode === "object" ? stdinMode.text : undefined);
    }
  });
}

const errorEvent = (run: WaapRun) => [...run.events].reverse().find((e) => e.event === "error");
const resultEvent = (run: WaapRun) => [...run.events].reverse().find((e) => e.event === "result");

export async function waapVersion(opts: WaapOptions = {}): Promise<string> {
  const run = await runWaap(["--version"], undefined, opts);
  const v = run.stdoutText.find((l) => /^\d+\.\d+\.\d+/.test(l));
  if (run.exitCode !== 0 || !v) throw new RecipeError("UNEXPECTED", "Could not read the waap-cli version");
  return v;
}

/** The Sui address of the logged-in WaaP account (standard-mode t1 key). */
export async function waapSuiAddress(opts: WaapOptions = {}): Promise<string> {
  const run = await runWaap(["whoami", "--json"], undefined, opts);
  const err = errorEvent(run);
  if (run.exitCode !== 0 || err) {
    const code = String(err?.code ?? "UNKNOWN");
    const hint = code === "NO_SESSION" ? " Log in first: waap-cli login --email <email> --password-stdin" : "";
    throw new RecipeError("WAAP_REJECTED", `waap-cli whoami failed (${code}): ${err?.message ?? "no details"}.${hint}`, {
      waapCode: code,
    });
  }
  const addr = resultEvent(run)?.suiWalletAddress;
  if (typeof addr !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(addr)) {
    throw new RecipeError("WAAP_REJECTED", "waap-cli whoami returned no Sui address for this account");
  }
  return addr;
}

/** waap-cli error codes that mean the transaction was certainly not executed. */
const NOT_EXECUTED_CODES = new Set([
  "NO_SESSION",
  "INVALID_PARAMS",
  "POLICY_REJECTED",
  "TWO_FA_TIMEOUT",
  "INSUFFICIENT_FUNDS",
  "INSUFFICIENT_BALANCE",
  "RPC_PROTOCOL_MISMATCH",
]);

export type SendOutcome =
  | { kind: "confirmed"; digest: string; from?: string }
  | { kind: "failed"; digest: string; from?: string }
  | { kind: "rejected"; waapCode: string; message: string }
  | { kind: "unknown"; digest?: string; from?: string; message: string };

/**
 * The kind bytes go in argv, not on stdin: they are public (they are broadcast anyway), and
 * waap-cli needs its stdin free to read a phone-2FA code (bundle functions `mh`/`dh`).
 */
export function sendTxArgs(kindBase64: string): string[] {
  return ["send-tx", "--chain", WAAP_CHAIN, "--tx", kindBase64, "--tx-format", "base64", "--json", "--wait"];
}

/**
 * Hand kind bytes to WaaP: it prepares gas, applies policy/2FA, signs with the account's key
 * and broadcasts. With --wait, an on-chain failure still exits 0, so the status field decides.
 */
export async function waapSendKind(kindBase64: string, opts: WaapOptions = {}): Promise<SendOutcome> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(kindBase64)) throw new RecipeError("UNEXPECTED", "kind bytes are not canonical base64");
  const run = await runWaap(sendTxArgs(kindBase64), undefined, opts);
  const err = errorEvent(run);
  const result = resultEvent(run);
  if (err || run.exitCode !== 0) {
    const code = String(err?.code ?? "UNKNOWN");
    const message = String(err?.message ?? `waap-cli exited with code ${run.exitCode}`);
    if (NOT_EXECUTED_CODES.has(code)) return { kind: "rejected", waapCode: code, message };
    const digest = typeof result?.txHash === "string" ? result.txHash : undefined;
    return { kind: "unknown", digest, message: `${code}: ${message}` };
  }
  if (!result) return { kind: "unknown", message: "waap-cli printed no result event" };
  const digest = typeof result.txHash === "string" ? result.txHash : undefined;
  const from = typeof result.from === "string" ? result.from : undefined;
  if (!digest) return { kind: "unknown", from, message: "waap-cli result has no transaction digest" };
  if (result.status === "confirmed") return { kind: "confirmed", digest, from };
  if (result.status === "failed") return { kind: "failed", digest, from };
  const why = typeof result.confirmationError === "string" ? `: ${result.confirmationError}` : "";
  return { kind: "unknown", digest, from, message: `confirmation status is ${String(result.status ?? "missing")}${why}` };
}
