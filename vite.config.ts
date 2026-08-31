import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// Another Tauri app's dev server may already hold 1420 (they all default to it).
// CONDUIT_DEV_PORT moves this one; pair it with a matching `tauri dev --config`
// devUrl override so the webview looks at the same port.
// @ts-expect-error process is a nodejs global
const port = Number(process.env.CONDUIT_DEV_PORT) || 1420;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Monaco is a large ESM tree with CJS interop; pre-bundle it so dev cold-start and
  // the packaged `tauri build` resolve its entrypoints deterministically. (Phase 0 spike;
  // validated to be required for the offline packaged worker load.)
  optimizeDeps: {
    include: ["monaco-editor"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: port + 1,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
