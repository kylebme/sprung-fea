import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  build: {
    // The service's CSP allows fonts only from 'self', so never inline them.
    assetsInlineLimit: (file) =>
      /\.(woff2?|ttf)$/.test(file) ? false : undefined,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        "**/.bettersim/**",
        "**/runtime/**",
        "**/output/**",
        "**/release/**",
      ],
    },
    proxy: { "/api": "http://127.0.0.1:4318" },
  },
});
