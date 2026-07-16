import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setupTests.ts"],
    css: true,
    maxWorkers: 1,
    restoreMocks: true,
    testTimeout: 10_000,
  },
});
