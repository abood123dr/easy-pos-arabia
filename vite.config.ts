import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import pwa from "./build/pwa";

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 8080,
  },
  plugins: [react(), pwa()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
