// Follow-up 2: pure classification of one vitest run for the mutation gate (scripts/mutation-check.mjs).
// Input: the spawn outcome and the parsed JSON report. A mutant is KILLED only when vitest exited
// exactly 1, every test the positive control ran is present with the same identity, nothing was
// skipped/todo/pending, no file failed outside a test, and a failing test matches the declared target.
import path from "node:path";

/** Test identities and statuses from a vitest JSON report. */
export function readReport(report, testRoot) {
  const tests = new Map();
  const brokenFiles = [];
  for (const f of report?.testResults ?? []) {
    const rel = path.relative(testRoot, f.name);
    const assertions = f.assertionResults ?? [];
    if (f.status === "failed" && !assertions.some((a) => a.status === "failed")) brokenFiles.push(`${rel}: ${(f.message ?? "").slice(0, 200)}`);
    for (const a of assertions) tests.set(`${rel} > ${a.fullName}`, a.status);
  }
  return { tests, brokenFiles };
}

/**
 * @param run { status, signal, timedOut, error, report } — report is the parsed JSON or undefined
 * @param ctx { controlIds?: Set<string>, target?: RegExp, testRoot }
 * @returns { verdict: "PASS"|"KILLED"|"SURVIVED"|"UNATTRIB"|"ERROR", note, failed, matched }
 */
export function classify(run, ctx) {
  const out = (verdict, note, extra = {}) => ({ verdict, note, failed: [], matched: [], ...extra });
  if (run.signal || run.timedOut || run.error) return out("ERROR", `signal=${run.signal} timedOut=${!!run.timedOut} error=${run.error ?? ""}`);
  if (!run.report) return out("ERROR", "no JSON report (startup failure?)");
  const { tests, brokenFiles } = readReport(run.report, ctx.testRoot);
  if (brokenFiles.length) return out("ERROR", `file-level failure: ${brokenFiles.join("; ")}`);
  const odd = [...tests].filter(([, s]) => s !== "passed" && s !== "failed");
  if (odd.length) return out("ERROR", `non-run tests (skipped/todo/pending): ${odd.map(([n, s]) => `${s} ${n}`).join(" | ").slice(0, 400)}`);
  if (ctx.controlIds) {
    const missing = [...ctx.controlIds].filter((n) => !tests.has(n));
    const extra = [...tests.keys()].filter((n) => !ctx.controlIds.has(n));
    if (missing.length || extra.length) return out("ERROR", `test identities differ from the control: missing ${missing.length} [${missing.slice(0, 3).join(" | ")}], extra ${extra.length} [${extra.slice(0, 3).join(" | ")}]`);
  }
  const failed = [...tests].filter(([, s]) => s === "failed").map(([n]) => n);
  if (failed.length === 0) return run.status === 0 ? out("PASS", `${tests.size} passed`, { failed }) : out("ERROR", `exit ${run.status} with no failing test`);
  if (run.status !== 1) return out("ERROR", `exit ${run.status} (a test failure must exit 1)`, { failed });
  if (!ctx.target) return out("ERROR", "failing tests but no declared target", { failed });
  const matched = failed.filter((n) => ctx.target.test(n));
  if (!matched.length) return out("UNATTRIB", `failures not in the declared targets: ${failed.join(" | ").slice(0, 400)}`, { failed });
  const other = failed.length - matched.length;
  return out("KILLED", other ? `${other} other failing test(s): ${failed.filter((n) => !ctx.target.test(n)).join(" | ").slice(0, 400)}` : "", { failed, matched });
}
