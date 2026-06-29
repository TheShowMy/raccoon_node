import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const apiTarget = process.env.RACCOON_API_URL ?? "http://127.0.0.1:3001";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": apiTarget,
    },
  },
});
