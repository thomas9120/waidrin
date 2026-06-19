import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  // Provide an inline (empty) PostCSS config so Vite never tries to load the
  // project's postcss.config.mjs, which references @tailwindcss/postcss and is
  // only meant for the Next.js build, not for these pure unit tests.
  css: { postcss: { plugins: [] } },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.ts"],
    // Don't try to run the Next.js route/component tests as part of the pure unit suite.
    exclude: ["node_modules/**", ".next/**", ".pi/**"],
  },
});
