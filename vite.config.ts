import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three", "three/addons/controls/OrbitControls.js"],
        },
      },
    },
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
