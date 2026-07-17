import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.E2E_WEB_PORT ?? 5173),
    proxy: {
      "/api/v1": {
        target: `http://127.0.0.1:${process.env.E2E_API_PORT ?? "3001"}`,
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
});
