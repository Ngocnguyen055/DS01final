import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  envDir: "../..",
  resolve: {
    alias: {
      "@ds01/shared": fileURLToPath(new URL("../shared/index.ts", import.meta.url)),
    },
  },
  optimizeDeps: { exclude: ["@ds01/shared"] },
});
