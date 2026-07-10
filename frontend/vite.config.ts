import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.RACCOON_API_URL ?? "http://127.0.0.1:3001";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const path = id.replaceAll("\\", "/");
          if (!path.includes("/node_modules/")) return undefined;
          if (
            path.includes("/@xyflow/") ||
            path.includes("/zustand/") ||
            path.includes("/d3-")
          ) {
            return "vendor-flow";
          }
          if (
            path.includes("/react/") ||
            path.includes("/react-dom/") ||
            path.includes("/scheduler/")
          ) {
            return "vendor-react";
          }
          if (
            path.includes("/@astryxdesign/") ||
            path.includes("/@stylexjs/")
          ) {
            return "vendor-astryx";
          }
          if (
            path.includes("/react-markdown/") ||
            path.includes("/remark-") ||
            path.includes("/micromark") ||
            path.includes("/unified/")
          ) {
            return "vendor-markdown";
          }
          if (path.includes("/lucide-react/")) return "vendor-icons";
          return undefined;
        },
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: apiTarget,
        ws: true,
      },
    },
  },
});
