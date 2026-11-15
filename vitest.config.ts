import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/src/**/*.test.{ts,tsx}", "apps/*/test/**/*.test.ts"],
    environment: "node",
    // Many tests run whole simulations; under a full parallel run on a busy machine the 5 s
    // default trips on healthy tests. Slow tests that need more set their own timeout.
    testTimeout: 30_000,
  },
});
