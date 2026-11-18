/**
 * Studio console build (RFC 0004 D3, D4). The server serves exactly three static files, so the build is one
 * `index.html`, one `app.js` and one `style.css` in out/console/dist: no code-split chunks, no sourcemaps, no font or
 * image assets and no `data:` URIs, no inline <script> or <style> (strict CSP: the review:ui parity checklist
 * RU-H01, RU-H04). Fonts are system stacks (no network, nothing to bundle).
 */
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const here = import.meta.dirname;
const repo = path.resolve(here, "../..");

const consoleAliases = {
  "@contract": path.join(repo, "src/types/console.ts"),
  "@tokens": path.join(repo, "src/lib/design-tokens.ts"),
  // review:ui browser modules (pointer, channel and still clients) imported by the timeline view (WP13).
  "@review": path.join(repo, "src/lib/review-ui"),
  "@fixtures": path.join(repo, "tests/fixtures/console"),
  "@": here,
};

export default defineConfig({
  root: here,
  base: "./",
  publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: { alias: consoleAliases },
  server: { host: "127.0.0.1", fs: { allow: [repo] } },
  preview: { host: "127.0.0.1" },
  build: {
    outDir: path.join(repo, "out/console/dist"),
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    modulePreload: false,
    reportCompressedSize: false,
    rolldownOptions: {
      output: {
        codeSplitting: false,
        entryFileNames: "app.js",
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith(".css")) ? "style.css" : "[name][extname]",
      },
    },
  },
});
