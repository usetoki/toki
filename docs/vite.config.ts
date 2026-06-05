import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Built for https://usetoki.github.io/toki/, so production assets resolve under
// /toki/. In dev we serve from the root, so localhost has no base-path friction
// (e.g. /toki without a trailing slash tripping the dev server on refresh).
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/toki/" : "/",
  plugins: [react()],
  build: {
    target: "es2022",
    sourcemap: false,
  },
}));
