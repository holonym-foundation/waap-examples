import { describe, expect, it, vi } from "vitest";

import { createRunLog } from "./runLog";

describe("runLog", () => {
  // The button that ran it shows this, beside the full history.
  it("resolves with the entry it recorded", async () => {
    const log = createRunLog();
    const ok = await log.run("sign", async () => "0xsig");
    const failed = await log.run("send", async () => {
      throw { code: 4001, message: "User rejected" };
    });

    expect(ok).toMatchObject({ label: "sign", ok: true, detail: "0xsig" });
    expect(failed).toMatchObject({ ok: false, detail: "4001: User rejected" });
  });

  it("records successes newest first", async () => {
    const log = createRunLog();
    await log.run("first", async () => "a");
    await log.run("second", async () => "b");

    expect(log.entries().map((e) => e.label)).toEqual(["second", "first"]);
    expect(log.entries()[0]).toMatchObject({ ok: true, detail: "b" });
  });

  // The SDK rejects with EIP-1193 objects, bare `{ error }` objects and
  // Errors; each must read as a failure, not "[object Object]".
  it.each([
    [{ code: 4001, message: "User rejected" }, "4001: User rejected"],
    [{ error: "Not implemented (foo)" }, "Not implemented (foo)"],
    [new Error("boom"), "boom"],
    ["plain", "plain"],
  ])("records a rejection %#", async (error, detail) => {
    const log = createRunLog();
    await log.run("sign", async () => {
      throw error;
    });
    expect(log.entries()[0]).toMatchObject({ ok: false, detail });
  });

  it("notifies subscribers, records events, and clears", async () => {
    const log = createRunLog();
    const listener = vi.fn();
    const unsubscribe = log.subscribe(listener);
    log.record("bridge", false, "failed");
    log.clear();
    unsubscribe();
    log.record("after", true, "ignored");

    expect(listener).toHaveBeenCalledTimes(2);
    expect(log.entries()).toHaveLength(1);
  });

  it("keeps entries logged in the same millisecond distinct", () => {
    const log = createRunLog();
    log.record("Sign", true, "a");
    log.record("Sign", true, "b");
    const [second, first] = log.entries();
    expect(second.id).not.toBe(first.id);
  });
});
