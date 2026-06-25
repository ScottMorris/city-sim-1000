import { defineConfig } from 'vite';

const base = process.env.VITE_BASE ?? '/';

// COOP + COEP are required for SharedArrayBuffer (Phase 2+).
// The dev server sets them; production requires matching server config.
// Runtime detection (`crossOriginIsolated`) selects SAB vs. transferable fallback.
const crossOriginHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base,
  server: {
    host: true,
    headers: crossOriginHeaders,
  },
  preview: {
    headers: crossOriginHeaders,
  },
});
