import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  return {
    plugins: [react()],
    clearScreen: false,
    build: {
      sourcemap: mode !== 'production',
      minify: mode === 'production',
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) return 'react-vendor';
            if (id.includes('node_modules/@tauri-apps')) return 'tauri-vendor';
            return undefined;
          }
        }
      }
    },
    server: {
      port: 1420,
      strictPort: true,
      host: '127.0.0.1',
      hmr: { protocol: 'ws', host: '127.0.0.1', port: 1421 },
      watch: {
        ignored: [
          '**/src-tauri/**',
          '**/node_modules/**',
          '**/.git/**'
        ]
      }
    }
  };
});
