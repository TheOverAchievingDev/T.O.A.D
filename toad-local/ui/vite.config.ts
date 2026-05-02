import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Tauri 2 boots a webview pointing at this dev server when running
// `tauri dev`. The port must stay deterministic so the Rust shell can
// find it — strictPort: true makes Vite refuse to silently drift to
// 5174/5175 when 5173 is busy.
const isTauri = process.env.TAURI_ENV_PLATFORM != null;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  // Tauri expects sourcemaps off in production (smaller bundle inside the
  // packaged .app/.exe) but on in dev so the inspector is useful.
  build: {
    outDir: 'dist',
    sourcemap: !isTauri ? true : process.env.TAURI_ENV_DEBUG === 'true',
    // Inline tiny assets so the bundled .exe doesn't need a sea of files.
    assetsInlineLimit: 4096,
  },
  server: {
    port: 5173,
    strictPort: isTauri,
    host: isTauri ? '127.0.0.1' : false,
    // Tauri's Rust process polls Vite's HMR over a fixed port; let it
    // through unconditionally.
    hmr: isTauri ? { protocol: 'ws', host: '127.0.0.1', port: 5174 } : undefined,
    watch: isTauri ? { ignored: ['**/src-tauri/**'] } : undefined,
  },
});
