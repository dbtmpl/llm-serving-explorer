import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "conformance/**/*.test.ts", "replay/**/*.test.ts"],
    // Some tests run whole simulations; CI runners are several times slower than a laptop.
    testTimeout: 60_000
  }
});
