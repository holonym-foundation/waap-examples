import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { mergeWalletQueries } = require("./android-wallet-queries.js");

describe("mergeWalletQueries", () => {
  // expo-web-browser declares a Custom Tabs query; replacing the block drops
  // it, and from Android 11 the login browser then cannot be found.
  it("keeps queries other plugins declared", () => {
    const customTabs = {
      intent: [
        {
          action: [
            {
              $: {
                "android:name":
                  "android.support.customtabs.action.CustomTabsService",
              },
            },
          ],
        },
      ],
    };
    const manifest = mergeWalletQueries({ queries: [customTabs] });

    expect(manifest.queries[0]).toBe(customTabs);
    expect(JSON.stringify(manifest.queries)).toContain("io.metamask");
  });

  it("adds the wallet packages to a manifest with no queries", () => {
    const manifest = mergeWalletQueries({});
    expect(JSON.stringify(manifest.queries)).toContain(
      "com.wallet.crypto.trustapp",
    );
  });
});
