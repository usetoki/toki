import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Served from https://usetoki.github.io/toki/, so assets resolve under /toki/.
export default defineConfig({
  base: "/toki/",
  plugins: [react()],
  build: {
    target: "es2022",
    sourcemap: false,
  },
});
