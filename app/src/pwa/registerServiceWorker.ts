// registerServiceWorker.ts — PWA service worker registration.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// Registration itself is delegated to vite-plugin-pwa's virtual module: it
// wires up the Workbox-generated `sw.js` (built from the real Vite output —
// see vite.config.ts) and handles update polling for `registerType:
// 'autoUpdate'`. This file is kept only so the call site in main.ts
// (`registerServiceWorker()`, called once at startup) doesn't need to change.
import { registerSW } from 'virtual:pwa-register';

export function registerServiceWorker() {
  // Skip in dev mode: the plugin only emits a service worker for production
  // builds (devOptions.enabled is left off), and Vite serves unhashed asset
  // URLs in dev anyway, so there is nothing useful to register.
  if (import.meta.env.DEV) return;
  registerSW({ immediate: true });
}
