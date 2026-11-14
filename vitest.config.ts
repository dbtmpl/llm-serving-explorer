import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "schema/test/**/*.test.ts",
      "tools/**/test/**/*.test.ts",
      "scenarios/**/*.test.ts",
      "web/src/**/*.test.ts",
      "web/src/**/*.test.tsx"
    ]
  }
});
