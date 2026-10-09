import { describe, expect, it } from "vitest";

import appJson from "../../app.json";
import { project, walletTarget } from "./config";

describe("walletTarget", () => {
  it("reaches production unless told otherwise", () => {
    expect(walletTarget(undefined)).toEqual({
      label: "production",
      target: { environment: "production" },
    });
  });

  it("reaches staging by name", () => {
    expect(walletTarget("staging")).toEqual({
      label: "staging",
      target: { environment: "staging" },
    });
  });
});

describe("project", () => {
  // The login session returns to this scheme, so the app must register it.
  it("returns to the scheme app.json registers", () => {
    const { expo } = appJson;
    expect(project.nativeRedirect).toBe(`${expo.scheme}://`);
    expect(project.appId).toBe(expo.ios.bundleIdentifier);
    expect(project.appId).toBe(expo.android.package);
  });
});
