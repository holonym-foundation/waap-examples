import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { journalReconcileCommand, statusCommand, supplyCommand, withdrawCommand, type Deps, type Reporter } from "./app.js";
import { DEFAULT_GRPC_URL, TESTED_WAAP_CLI_VERSION, WAAP_CHAIN } from "./constants.js";
import { EXIT_CODES, RecipeError } from "./errors.js";
import { Journal, OPEN_STATES, defaultStateDir } from "./journal.js";
import { acquireLock, removeStaleLock } from "./lock.js";
import { waapSuiAddress, waapVersion } from "./waap.js";

const USAGE = `suilend-waap — supply, monitor and withdraw SUI on SuiLend (main market, ${WAAP_CHAIN}) with a WaaP wallet.
No borrowing, no leverage. Transactions are signed by waap-cli; this tool never sees keys or passwords.

Commands
  doctor                         Check Node, waap-cli version and configuration (no network)
  address                        Show the WaaP account's Sui address (waap-cli whoami)
  status   [--address A] [--watch SECONDS]
                                 Wallet SUI, SuiLend obligation(s), supplied SUI, reserve liquidity
  supply   --amount SUI [--obligation-id ID | --new-obligation] [--gas-reserve SUI] [--yes]
                                 Supply exactly SUI. Without --yes: dry run (plan + simulation only)
  withdraw (--amount SUI | --all) [--obligation-id ID] [--yes]
                                 Withdraw SUI back to the wallet. Without --yes: dry run
  journal                        List local submission records
  journal reconcile ID --digest D
                                 Reconcile an open record against a digest you found (e.g. on an explorer)
  journal ack ID                 Close an open record WITHOUT reconciling it (audited; never a success)
  journal unlock                 Remove a lock left by a dead suilend-waap process on this host
  journal repair                 Back up an unreadable journal and replace bad lines with blocking records

Options
  --json             NDJSON output for agents: {"event":"result"|"error"|"awaiting_2fa"|"status",...}
  --address A        status: any address; supply/withdraw: assert the WaaP account is A
  --skip-simulate    Submit without the pre-submit simulation (not recommended)
  --allow-pending    Submit past an unreconciled record that has a WaaP digest (unreconciled/mismatch).
                     Never past a submitting/pending record (outcome unknown); still locked; an
                     unreadable journal still blocks
  --grpc-url URL     Sui gRPC full node (default ${DEFAULT_GRPC_URL}; env SUILEND_WAAP_GRPC_URL)

Exit codes
  0 ok (supply/withdraw: effect read back from chain) · 1 unexpected · 2 invalid input
  3 preflight refused · 4 simulation failed (not submitted) · 5 WaaP did not execute
  6 executed but failed on chain · 7 outcome unknown or not yet visible (do NOT retry; run status)
  8 blocked by an unreconciled earlier submission · 9 locked by another process
  10 journal unreadable · 11 chain shows a different result (e.g. another signer)`;

/** Supported runtime: transitive SDK dependencies declare Node ^24 (see README). */
export const SUPPORTED_NODE_MAJOR = 24;

/**
 * Test-only injection point. Not reachable from argv or environment variables: only code that
 * imports this module and calls main() with a third argument can substitute services.
 */
export interface MainOverrides {
  chain?: Deps["chain"];
  waap?: Deps["waap"];
  reconcile?: Deps["reconcile"];
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

function printHuman(value: unknown, indent = ""): void {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (v && typeof v === "object") {
        console.log(`${indent}${k}:`);
        printHuman(v, indent + "  ");
      } else console.log(`${indent}${k}: ${v}`);
    }
  } else if (Array.isArray(value)) {
    if (value.length === 0) console.log(`${indent}(none)`);
    value.forEach((v, i) => {
      console.log(`${indent}- [${i}]`);
      printHuman(v, indent + "    ");
    });
  } else console.log(`${indent}${String(value)}`);
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, overrides: MainOverrides = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        amount: { type: "string" },
        all: { type: "boolean" },
        address: { type: "string" },
        "obligation-id": { type: "string" },
        "new-obligation": { type: "boolean" },
        "gas-reserve": { type: "string" },
        yes: { type: "boolean" },
        "skip-simulate": { type: "boolean" },
        "allow-pending": { type: "boolean" },
        "grpc-url": { type: "string" },
        digest: { type: "string" },
        watch: { type: "string" },
        iterations: { type: "string" },
      },
    });
  } catch (e) {
    console.error((e as Error).message + "\n\n" + USAGE);
    return EXIT_CODES.INVALID_INPUT;
  }
  const { values: o, positionals } = parsed;
  const [command, ...rest] = positionals;
  const asJson = !!o.json;

  const reporter: Reporter = {
    progress: (msg) => {
      if (!asJson) console.error(msg);
    },
    event: (name, data) => {
      if (asJson) console.log(json({ event: name, ...data }));
      else if (name === "awaiting_2fa") {
        console.error(
          `\n>>> WaaP requires approval (${data.method ?? "2FA"}).` +
            (data.confirm_url ? ` Open: ${data.confirm_url}` : " Check your approval channel.") +
            "\n",
        );
      }
    },
  };
  const emitResult = (value: unknown) => {
    if (asJson) console.log(json({ event: "result", ...(value as object) }));
    else printHuman(JSON.parse(json(value)));
  };

  if (o.help || !command) {
    console.log(USAGE);
    return o.help ? EXIT_CODES.OK : EXIT_CODES.INVALID_INPUT;
  }

  const grpcUrl = o["grpc-url"] ?? env.SUILEND_WAAP_GRPC_URL ?? DEFAULT_GRPC_URL;
  let live: ReturnType<Deps["chain"]> | undefined;
  const deps: Deps = {
    // One connection per process (initialize() re-reads the market on every readMarket anyway).
    chain: overrides.chain ?? (() => (live ??= import("./chain.js").then((m) => m.connectLiveChain(grpcUrl)))),
    waap: overrides.waap ?? { env, onStderr: (l) => reporter.progress(`[waap-cli] ${l}`) },
    journal: new Journal(defaultStateDir(env)),
    reporter,
    reconcile: overrides.reconcile,
  };

  try {
    switch (command) {
      case "doctor": {
        const version = await waapVersion(deps.waap);
        const nodeMajor = Number(process.versions.node.split(".")[0]);
        emitResult({
          node: process.version,
          nodeSupported: nodeMajor === SUPPORTED_NODE_MAJOR,
          nodeSupportedRange: `${SUPPORTED_NODE_MAJOR}.x`,
          waapCliVersion: version,
          waapCliTestedVersion: TESTED_WAAP_CLI_VERSION,
          waapCliVersionMatches: version === TESTED_WAAP_CLI_VERSION,
          waapCliEnv: env.WAAP_CLI_ENV ?? env.SILK_NODE_ENV ?? "production (default)",
          chain: WAAP_CHAIN,
          grpcUrl,
          stateDir: defaultStateDir(env),
        });
        return EXIT_CODES.OK;
      }
      case "address":
        emitResult({ address: await waapSuiAddress(deps.waap), chain: WAAP_CHAIN });
        return EXIT_CODES.OK;
      case "status": {
        if (o.watch === undefined) {
          emitResult(await statusCommand(deps, { address: o.address }));
          return EXIT_CODES.OK;
        }
        const seconds = Number(o.watch);
        if (!Number.isFinite(seconds) || seconds < 5) {
          throw new RecipeError("INVALID_INPUT", "--watch needs a number of seconds ≥ 5");
        }
        const iterations = o.iterations ? Number(o.iterations) : Infinity;
        const address = o.address ?? (await waapSuiAddress(deps.waap)); // once, not per tick
        let previous: string | undefined;
        for (let i = 0; i < iterations; i++) {
          const s = await statusCommand(deps, { address });
          const key = json({ wallet: s.wallet, obligations: s.obligations, open: s.unresolvedSubmissions.length });
          if (asJson) console.log(json({ event: "status", changed: key !== previous, ...s }));
          else {
            const supplied = s.obligations.map((x) => `${x.suppliedSui} SUI${x.borrowCount ? ` (+${x.borrowCount} borrows!)` : ""}`);
            console.log(
              `${s.readAt}  wallet ${s.wallet.suiInCoins} SUI  supplied ${supplied.join(", ") || "0"}  ` +
                `APR ${s.reserve.supplyAprPercent}%${key !== previous && previous ? "  ← changed" : ""}` +
                (s.unresolvedSubmissions.length ? `  [${s.unresolvedSubmissions.length} unresolved submission(s)]` : ""),
            );
          }
          previous = key;
          if (i + 1 < iterations) await sleep(seconds * 1000);
        }
        return EXIT_CODES.OK;
      }
      case "supply":
        if (o.all) throw new RecipeError("INVALID_INPUT", "supply has no --all: pass an explicit --amount");
        emitResult(
          await supplyCommand(deps, {
            amount: o.amount,
            gasReserve: o["gas-reserve"],
            address: o.address,
            obligationId: o["obligation-id"],
            newObligation: o["new-obligation"],
            yes: o.yes,
            skipSimulate: o["skip-simulate"],
            allowPending: o["allow-pending"],
          }),
        );
        return EXIT_CODES.OK;
      case "withdraw":
        if (o["new-obligation"]) throw new RecipeError("INVALID_INPUT", "--new-obligation is only valid for supply");
        emitResult(
          await withdrawCommand(deps, {
            amount: o.amount,
            all: o.all,
            address: o.address,
            obligationId: o["obligation-id"],
            yes: o.yes,
            skipSimulate: o["skip-simulate"],
            allowPending: o["allow-pending"],
          }),
        );
        return EXIT_CODES.OK;
      case "journal": {
        const sub = rest[0];
        if (sub === "unlock") {
          const r = removeStaleLock(deps.journal.dir);
          if (!r.removed && r.reason !== "no lock file") throw new RecipeError("LOCKED", `Lock not removed: ${r.reason}`, { holder: r.holder });
          emitResult(r);
          return EXIT_CODES.OK;
        }
        if (sub === "repair") {
          const lock = acquireLock(deps.journal.dir, "journal repair");
          try {
            const r = deps.journal.repair(lock);
            emitResult({
              ...r,
              open: deps.journal.open().map((x) => x.id),
              next: r.replaced.length
                ? "Each replaced line is now an open 'pending' record that blocks submissions. Check your account on an explorer, then reconcile or ack them."
                : "journal is readable; nothing changed",
            });
          } finally {
            lock.release();
          }
          return EXIT_CODES.OK;
        }
        if (sub === "ack" || sub === "reconcile") {
          const id = rest[1];
          if (!id) throw new RecipeError("INVALID_INPUT", `journal ${sub} needs a record id`);
          if (sub === "reconcile") {
            if (!o.digest) throw new RecipeError("INVALID_INPUT", "journal reconcile needs --digest");
            emitResult(await journalReconcileCommand(deps, { id, digest: o.digest }));
            return EXIT_CODES.OK;
          }
          const lock = acquireLock(deps.journal.dir, "journal ack");
          try {
            const rec = deps.journal.latest().find((r) => r.id === id);
            if (!rec) throw new RecipeError("INVALID_INPUT", "journal ack needs an existing record id");
            if (!OPEN_STATES.includes(rec.state)) {
              throw new RecipeError("INVALID_INPUT", `record ${id} is ${rec.state}, not open; nothing to acknowledge`);
            }
            deps.journal.update(lock, id, "acknowledged", { note: `acknowledged by user while ${rec.state}; effect NOT reconciled` });
            emitResult({ acknowledged: id, previousState: rec.state, reconciled: false, digest: rec.digest });
          } finally {
            lock.release();
          }
          return EXIT_CODES.OK;
        }
        if (sub !== undefined) throw new RecipeError("INVALID_INPUT", `Unknown journal subcommand "${sub}"`);
        emitResult({ file: deps.journal.file, records: deps.journal.latest() });
        return EXIT_CODES.OK;
      }
      default:
        throw new RecipeError("INVALID_INPUT", `Unknown command "${command}"\n\n${USAGE}`);
    }
  } catch (e) {
    const err =
      e instanceof RecipeError ? e : new RecipeError("UNEXPECTED", (e as Error)?.message ?? String(e));
    if (asJson) console.log(json({ event: "error", code: err.code, message: err.message, details: err.details }));
    else {
      console.error(`Error [${err.code}]: ${err.message}`);
      if (err.code === "UNEXPECTED" && e instanceof Error && e.stack && env.DEBUG) console.error(e.stack);
    }
    return EXIT_CODES[err.code];
  }
}

const isEntry = process.argv[1]?.endsWith("/src/cli.ts");
if (isEntry) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
