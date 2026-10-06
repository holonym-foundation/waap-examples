// Repair round 01: a file-backed controlled substitute for chain state, shared by the fake
// waap-cli (which applies a sent transaction's effect) and the fake chain port (which reads
// it). Separate OS processes see the same state, so races, restarts and delayed visibility
// can be exercised across process boundaries. All ids and numbers are synthetic.
import fs from "node:fs";
import path from "node:path";
import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import { normalizeSuiObjectId } from "@mysten/sui/utils";

export const MAINNET_CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S";
const U64_MAX = 18446744073709551615n;
const MIN_AVAILABLE = 100n;
export const GAS_MIST = 2_000_000n; // synthetic gas charged per executed tx

/** World JSON: bigints stored as decimal strings. */
export function readWorld(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeWorld(file, w) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(w, null, 1));
  fs.renameSync(tmp, file);
}

function abandoned(lock) {
  let st;
  try {
    st = fs.statSync(lock);
  } catch {
    return false; // already gone; the next mkdir decides
  }
  let pid;
  try {
    pid = Number(fs.readFileSync(path.join(lock, "pid"), "utf8"));
  } catch {
    pid = NaN;
  }
  // No PID file, or an empty/partial one (killed mid-write): Number("") is 0, and kill(0, 0)
  // would signal our own process group and look alive forever. Use a creation grace instead.
  if (!Number.isInteger(pid) || pid <= 0) return Date.now() - st.mtimeMs > 2000;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === "ESRCH";
  }
}

/** Serialize mutations of the world file between processes (test fixture only). */
export function withWorld(file, fn) {
  const lock = `${file}.lock`;
  const until = Date.now() + 10_000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
      break;
    } catch {
      // A holder killed inside this function (SIGKILL skips `finally`) leaves the lock behind.
      // Recover it only when its holder is provably gone: recorded PID dead, or no PID file
      // after a creation grace. Test fixture only; the recipe's own mutation lock never steals.
      if (abandoned(lock)) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > until) throw new Error("world lock timeout");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    const w = readWorld(file);
    const r = fn(w);
    writeWorld(file, w);
    return r;
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

const ctokensToMist = (m, c) => (BigInt(m.ctokenSupply) === 0n ? c : (c * BigInt(m.totalSupplyMist)) / BigInt(m.ctokenSupply));
const mistToCtokens = (m, x) => (BigInt(m.ctokenSupply) === 0n ? x : (x * BigInt(m.ctokenSupply)) / BigInt(m.totalSupplyMist));

/** Decode the kind bytes a recipe produced into the effect SuiLend would have. */
export function decodeKind(kindBase64) {
  const data = Transaction.fromKind(Buffer.from(kindBase64, "base64")).getData();
  const inputs = data.inputs;
  const pure = (arg) => Uint8Array.from(Buffer.from(inputs[arg.Input].Pure.bytes, "base64"));
  const owned = inputs
    .filter((i) => i.$kind === "Object" && i.Object.ImmOrOwnedObject)
    .map((i) => normalizeSuiObjectId(i.Object.ImmOrOwnedObject.objectId));
  let supplyMist, withdrawCtokens, createsObligation = false;
  for (const c of data.commands) {
    if (c.$kind === "SplitCoins") supplyMist = BigInt(bcs.u64().parse(pure(c.SplitCoins.amounts[0])));
    if (c.$kind === "MoveCall" && c.MoveCall.function === "create_obligation") createsObligation = true;
    if (c.$kind === "MoveCall" && c.MoveCall.function === "withdraw_ctokens") {
      withdrawCtokens = BigInt(bcs.u64().parse(pure(c.MoveCall.arguments[4])));
    }
  }
  return { supplyMist, withdrawCtokens, createsObligation, capId: owned[0] };
}

/**
 * Apply a sent transaction to the world. mode: "apply" | "none" (WaaP reports success but
 * nothing reaches the chain) | "wrong-sender" (executed by another account) |
 * "failed" (executed, aborted: gas only) | "delayed:K" (visible only after K more chain reads) |
 * "objects-delayed:K" (transaction visible now, objects after K reads) | "credit-elsewhere".
 */
export function applySend(w, { kindBase64, sender, digest, mode = "apply" }) {
  if (mode === "none") return;
  const m = w.market;
  // Each executed transaction lands in the next checkpoint (follow-up 2: chain clock for identity).
  w.checkpoint = (w.checkpoint ?? 0) + 1;
  const tx = { status: "success", sender, gasOwner: sender, gasMist: GAS_MIST.toString(), suiChange: {}, kindBase64, checkpoint: w.checkpoint };
  const owner = w.wallet.address;
  if (mode === "wrong-sender") {
    tx.sender = tx.gasOwner = "0x" + "b2".repeat(32);
    w.txs[digest] = tx;
    return;
  }
  if (mode === "failed") {
    tx.status = "failure";
    tx.suiChange[owner] = (-GAS_MIST).toString();
    w.wallet.coinMist = (BigInt(w.wallet.coinMist) - GAS_MIST).toString();
    w.txs[digest] = tx;
    return;
  }
  const d = decodeKind(kindBase64);
  const next = structuredClone(w);
  let net = -GAS_MIST;
  if (d.supplyMist !== undefined) {
    let ob;
    if (d.createsObligation) {
      const n = (next.created = (next.created ?? 0) + 1);
      ob = { obligationId: "0x" + n.toString(16).padStart(2, "0").repeat(32), capId: "0x" + (0xd0 + n).toString(16).repeat(32), suiCtokens: "0", otherDeposits: [], depositCount: 1, borrowCount: 0 };
      next.obligations.push(ob);
    } else ob = next.obligations.find((o) => normalizeSuiObjectId(o.capId) === d.capId);
    const minted = mistToCtokens(m, d.supplyMist);
    ob.suiCtokens = (BigInt(ob.suiCtokens) + minted).toString();
    net -= d.supplyMist;
  } else {
    const ob = next.obligations.find((o) => normalizeSuiObjectId(o.capId) === d.capId);
    const redeemable = BigInt(m.availableMist) - MIN_AVAILABLE;
    let c = d.withdrawCtokens === U64_MAX ? BigInt(ob.suiCtokens) : d.withdrawCtokens;
    const maxByLiquidity = mistToCtokens(m, redeemable);
    if (c > maxByLiquidity) c = maxByLiquidity;
    ob.suiCtokens = (BigInt(ob.suiCtokens) - c).toString();
    net += ctokensToMist(m, c);
  }
  if (mode === "credit-elsewhere") {
    // withdrawn SUI goes to another address: the owner only pays gas
    const other = "0x" + "b3".repeat(32);
    tx.suiChange[other] = (net + GAS_MIST).toString();
    net = -GAS_MIST;
  }
  next.wallet.coinMist = (BigInt(next.wallet.coinMist) + net).toString();
  tx.suiChange[owner] = net.toString();
  next.txs[digest] = tx;
  if (mode.startsWith("delayed:")) {
    w.delayed = { afterReads: (w.reads ?? 0) + Number(mode.slice(8)), state: { obligations: next.obligations, wallet: next.wallet, txs: next.txs, created: next.created } };
    return;
  }
  if (mode.startsWith("objects-delayed:")) {
    // the transaction is indexed at once, but object state lags behind (read-node lag)
    w.txs = next.txs;
    w.delayed = { afterReads: (w.reads ?? 0) + Number(mode.slice(16)), state: { obligations: next.obligations, wallet: next.wallet, created: next.created } };
    return;
  }
  Object.assign(w, { obligations: next.obligations, wallet: next.wallet, txs: next.txs, created: next.created });
}

/** Count a chain read; release a delayed effect once enough reads have happened. */
export function tick(w) {
  w.reads = (w.reads ?? 0) + 1;
  if (w.delayed && w.reads >= w.delayed.afterReads) {
    Object.assign(w, w.delayed.state);
    delete w.delayed;
  }
}

export function newWorld(overrides = {}) {
  const OWNER = "0x" + "a1".repeat(32);
  return {
    chainId: MAINNET_CHAIN_ID,
    market: {
      availableMist: (1_000_000n * 10n ** 9n).toString(),
      ctokenSupply: (2_000_000n * 10n ** 9n).toString(),
      totalSupplyMist: (2_100_000n * 10n ** 9n).toString(),
      depositLimitMist: (10_000_000n * 10n ** 9n).toString(),
    },
    wallet: { address: OWNER, coinMist: (100n * 10n ** 9n).toString(), addressBalanceMist: "0" },
    obligations: [
      { obligationId: "0x" + "0a".repeat(32), capId: "0x" + "c1".repeat(32), suiCtokens: (10n * 10n ** 9n).toString(), otherDeposits: [], depositCount: 1, borrowCount: 0 },
    ],
    txs: {},
    reads: 0,
    sends: 0,
    ...overrides,
  };
}
