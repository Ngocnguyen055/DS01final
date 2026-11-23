import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@ds01/shared": fileURLToPath(new URL("./src/shared/index.ts", import.meta.url)),
    },
  },
  test: { dir: "./tests", setupFiles: ["./tests/setup.ts"] },
});
