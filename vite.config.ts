import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), cloudflare()],
  clearScreen: false,
  build: {
    // LiveKit is isolated into a cacheable vendor chunk that is currently just
    // above Vite's generic 500 kB warning threshold.
    chunkSizeWarningLimit: 550,
    rollupOptions: {
      output: {
        manualChunks(moduleId) {
          if (moduleId.includes("livekit-client") || moduleId.includes("@livekit")) {
            return "livekit";
          }
          if (moduleId.includes("@supabase")) {
            return "supabase";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 1425,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/target/**"] },
  },
});
