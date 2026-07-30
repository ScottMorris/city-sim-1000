import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const base = process.env.VITE_BASE ?? '/';

/**
 * Build identity, surfaced in the debug overlay.
 *
 * This exists because of a real hour lost: a tile behaviour was fixed, the
 * engine rebuilt, and the browser kept the old one — with no way to tell from
 * inside the page which build was actually running. `SimHost.version()` was no
 * help, because it returns `CARGO_PKG_VERSION`, which does not move between
 * releases. What is needed is a fingerprint that changes on *every* build.
 *
 * `git describe` is not used: it is empty on a repo with no tags and throws in
 * a tarball checkout. Everything here degrades to a string rather than failing
 * the build, because a dev server that will not start is a worse outcome than
 * an unknown version.
 */
function gitSha(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=9', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    // A dirty tree is the common case while iterating, and it is exactly when
    // "which build am I running" gets asked — so say so rather than implying
    // the running code is that commit.
    const dirty =
      execFileSync('git', ['status', '--porcelain'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim().length > 0;
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}

/** Modification time of the compiled WASM, as an ISO string, or `null`. */
function wasmBuiltAt(): string | null {
  try {
    return statSync('src/wasm/sim_wasm/sim_wasm_bg.wasm').mtime.toISOString();
  } catch {
    return null;
  }
}

// COOP + COEP are required for SharedArrayBuffer (Phase 2+).
// The dev server sets them; production requires matching server config.
// Runtime detection (`crossOriginIsolated`) selects SAB vs. transferable fallback.
const crossOriginHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base,
  define: {
    // Resolved when Vite starts, so a dev server left running across a rebuild
    // reports the moment it booted rather than pretending to be current — the
    // staleness the overlay exists to reveal.
    __BUILD_SHA__: JSON.stringify(gitSha()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __WASM_BUILT_AT__: JSON.stringify(wasmBuiltAt())
  },
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
