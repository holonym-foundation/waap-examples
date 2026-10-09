import { defineConfig } from "vitest/config";

// Only the pure modules under src/workbench and the Expo config plugin are
// tested here; the screens need a device.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "*.test.ts"],
  },
});
