// registerServiceWorker.ts — PWA service worker registration.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { withBasePath } from '../utils/assetPaths';

export function registerServiceWorker() {
  // Skip in dev mode: Vite serves unhashed asset URLs, so the SW would
  // cache stale JS/WASM across hot rebuilds. Production builds hash
  // every asset filename, so URL changes naturally bust the cache.
  if (import.meta.env.DEV) return;
  if ('serviceWorker' in navigator) {
    const serviceWorkerPath = withBasePath('service-worker.js');
    navigator.serviceWorker.register(serviceWorkerPath).catch(() => {
      // ignore
    });
  }
}
