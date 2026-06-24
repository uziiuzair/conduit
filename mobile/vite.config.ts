import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Separate Vite app from the root Tauri client; port 5174 avoids the root app's 5173.
// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: true, // expose on the LAN so a phone can reach the dev server
  },
});
