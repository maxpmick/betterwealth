import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/test/setupTests.ts"],
    css: true,
    maxWorkers: 1,
    restoreMocks: true,
    testTimeout: 10_000,
    server: {
      deps: {
        // zod v4's namespace re-export (`export { z }`) loses its named exports
        // when externalized under the Bun runtime; inline it so Vite transforms it.
        inline: ["zod"],
      },
    },
  },
});
