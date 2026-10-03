import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../server/public",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/ws": {
        // 127.0.0.1:8080 is held by another container (onexo-bifrost/OrbStack),
        // so dev mode runs the backend on 8091. Override to point elsewhere,
        // e.g. VITE_WS_TARGET=ws://127.0.0.1:8090 to use the docker container.
        target: process.env.VITE_WS_TARGET ?? "ws://127.0.0.1:8091",
        ws: true,
      },
      "/api": {
        target: process.env.VITE_API_TARGET ?? "http://127.0.0.1:8091",
      },
    },
  },
});
