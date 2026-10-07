#!/usr/bin/env node
// Follow-up 2: negative and positive controls for the mutation-gate classifier. Synthetic reports
// test the evidence classification only, not recipe behaviour. Pass --legacy to run the follow-up 1
// rule (kept verbatim below) and show which invalid reports it accepted.
import { classify } from "./mutation-classify.mjs";

const ROOT = "/r/test";
const t = (name, status, file = "a.test.ts") => ({ file, name, status });
function report(tests, fileExtra = []) {
  const byFile = new Map();
  for (const x of tests) (byFile.get(x.file) ?? byFile.set(x.file, []).get(x.file)).push({ fullName: x.name, status: x.status, failureMessages: [] });
  return {
    testResults: [
      ...[...byFile].map(([file, assertionResults]) => ({ name: `${ROOT}/${file}`, status: assertionResults.some((a) => a.status === "failed") ? "failed" : "passed", assertionResults })),
      ...fileExtra,
    ],
  };
}
const controlTests = [t("target test", "passed"), t("other test", "passed"), t("third", "passed", "b.test.ts")];
const controlIds = new Set(controlTests.map((x) => `${x.file} > ${x.name}`));
const target = /target test/;
const killedReport = report([t("target test", "failed"), t("other test", "passed"), t("third", "passed", "b.test.ts")]);

/** The follow-up 1 rule, verbatim in effect: count + named target, no exit or identity check. */
function legacy(run, expectedTotal) {
  if (run.signal || run.timedOut || run.error || !run.report) return "ERROR";
  let total = 0;
  const failed = [];
  let broken = 0;
  for (const f of run.report.testResults) {
    if (f.status === "failed" && !f.assertionResults.some((a) => a.status === "failed")) broken++;
    for (const a of f.assertionResults) (total++, a.status === "failed" && failed.push(a.fullName));
  }
  if (total !== expectedTotal || broken) return "ERROR";
  if (!failed.length) return "SURVIVED";
  return failed.some((n) => target.test(n)) ? "KILLED" : "UNATTRIB";
}

const CASES = [
  ["genuine kill: exit 1, same identities, target failed", { status: 1, report: killedReport }, "KILLED"],
  ["positive control: exit 0, all passed", { status: 0, report: report(controlTests) }, "PASS"],
  ["exit 2 with a target failure", { status: 2, report: killedReport }, "ERROR"],
  ["identities replaced at unchanged count", { status: 1, report: report([t("target test", "failed"), t("renamed", "passed"), t("third", "passed", "b.test.ts")]) }, "ERROR"],
  ["a test missing", { status: 1, report: report([t("target test", "failed"), t("third", "passed", "b.test.ts")]) }, "ERROR"],
  ["a skipped test", { status: 1, report: report([t("target test", "failed"), t("other test", "skipped"), t("third", "passed", "b.test.ts")]) }, "ERROR"],
  ["file-level failure", { status: 1, report: report([t("target test", "failed"), t("other test", "passed"), t("third", "passed", "b.test.ts")], [{ name: `${ROOT}/c.test.ts`, status: "failed", message: "SyntaxError", assertionResults: [] }]) }, "ERROR"],
  ["killed by signal", { status: null, signal: "SIGKILL", report: killedReport }, "ERROR"],
  ["no report (startup failure)", { status: 1 }, "ERROR"],
  ["only an unrelated test failed", { status: 1, report: report([t("target test", "passed"), t("other test", "failed"), t("third", "passed", "b.test.ts")]) }, "UNATTRIB"],
];

const useLegacy = process.argv.includes("--legacy");
let bad = 0;
for (const [label, run, expected] of CASES) {
  const got = useLegacy ? legacy(run, controlIds.size) : classify(run, { controlIds, target, testRoot: ROOT }).verdict;
  const exp = useLegacy && expected === "PASS" ? "SURVIVED" : expected;
  const ok = got === exp;
  if (!ok) bad++;
  console.log(`${ok ? "OK " : "BAD"}  ${label}: expected ${exp}, got ${got}`);
}
console.log(bad ? `\n${bad} classifier control(s) wrong (${useLegacy ? "legacy" : "current"} rule)` : `\nAll ${CASES.length} classifier controls correct (${useLegacy ? "legacy" : "current"} rule).`);
process.exit(bad ? 1 : 0);
