import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

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
  plugins: [
    VitePWA({
      // Workbox generateSW mode: builds the service worker from the real
      // Vite build manifest, so precached JS/WASM chunk names (and thus
      // cache-busting on rebuild) fall out of Vite's own content hashing —
      // no hand-rolled cache-invalidation logic needed.
      strategies: 'generateSW',
      registerType: 'autoUpdate',
      injectRegister: false, // registration is driven from src/pwa/registerServiceWorker.ts via virtual:pwa-register
      // app/public/manifest.webmanifest already exists and is linked from index.html directly;
      // don't have the plugin generate a second, competing manifest.
      manifest: false,
      includeManifestIcons: false,
      workbox: {
        // Everything under app/public/ (manual.html, manifest.webmanifest, icons/, etc.)
        // is copied verbatim into dist/ alongside the hashed build output, so a single
        // glob over dist/ picks up both.
        globPatterns: ['**/*.{js,css,html,wasm,ico,png,svg,webmanifest}'],
        globIgnores: [
          '**/audio/**',
          '**/readme-banner.png',
          '**/social-preview.png',
        ],
      },
    }),
  ],
});
