import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { raisePodDeploymentTargets } = require("./ios-pod-deployment-target.js");

const podfile = `target 'App' do
  post_install do |installer|
    react_native_post_install(installer)
  end
end
`;

describe("raisePodDeploymentTargets", () => {
  // Xcode 27 accepts iOS 15.0 and later; react-native-svg and
  // async-storage still declare 12.4 and 13.4.
  it("raises pods below 15.1 inside post_install", () => {
    const out = raisePodDeploymentTargets(podfile);
    const hook = out.indexOf("post_install do |installer|");
    const raise = out.indexOf("IPHONEOS_DEPLOYMENT_TARGET");
    expect(raise).toBeGreaterThan(hook);
    expect(raise).toBeLessThan(out.indexOf("react_native_post_install"));
    expect(out).toContain("< 15.1");
  });

  it("is idempotent", () => {
    const once = raisePodDeploymentTargets(podfile);
    expect(raisePodDeploymentTargets(once)).toBe(once);
  });

  // A Podfile without the hook means the template changed: fail loudly
  // rather than build pods Xcode will reject.
  it("refuses a Podfile without post_install", () => {
    expect(() => raisePodDeploymentTargets("target 'App' do\nend\n")).toThrow(
      /post_install/,
    );
  });
});
