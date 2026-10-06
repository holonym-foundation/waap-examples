import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", ".test-tmp/**"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 20000,
    pool: "forks",
  },
});
