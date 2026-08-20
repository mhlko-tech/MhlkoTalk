import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), cloudflare()],
  clearScreen: false,
  server: {
    port: 1425,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/target/**"] },
  },
});
