// Preload that makes any outbound network attempt fail loudly and records it.
// Used for tests (vitest setup) and for the real waap-cli contract check (node --import).
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";

const logFile = process.env.NET_TRAP_LOG;
function record(kind, target) {
  const line = JSON.stringify({ kind, target: String(target), pid: process.pid }) + "\n";
  if (logFile) fs.appendFileSync(logFile, line);
  return new Error(`NETWORK_BLOCKED by net-trap: ${kind} ${target}`);
}
globalThis.fetch = async (input) => {
  throw record("fetch", typeof input === "string" ? input : input?.url ?? input);
};
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a = args[0];
  const target = typeof a === "object" ? `${a.host ?? a.path}:${a.port ?? ""}` : `${args[1] ?? ""}:${a}`;
  // Unix domain sockets / pipes used for child stdio are local IPC, not network.
  if (typeof a === "object" && a.path && !a.host) return origConnect.apply(this, args);
  throw record("net.connect", target);
};
tls.connect = (...args) => {
  throw record("tls.connect", JSON.stringify(args[0]?.host ?? args[0]));
};
for (const mod of [http, https]) {
  mod.request = (...args) => {
    throw record("http.request", JSON.stringify(args[0]?.host ?? args[0]));
  };
  mod.get = mod.request;
}
dns.lookup = (host, ...rest) => {
  const cb = rest.find((x) => typeof x === "function");
  const err = record("dns.lookup", host);
  if (cb) process.nextTick(() => cb(err));
  else throw err;
};
