// playwright.config.ts — mobile emulation e2e coverage (M5-2).
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// Two projects share one spec (`e2e/mobile.spec.ts`): portrait and landscape
// on the same device profile, dimensions swapped. Both land in the compact
// layout — `deviceMode.ts`'s breakpoint triggers on width OR height, and a
// landscape phone is short even though it's not narrow.
import { defineConfig, devices } from '@playwright/test';

const PORTRAIT = devices['Pixel 5'];
const LANDSCAPE = {
  ...PORTRAIT,
  viewport: { width: PORTRAIT.viewport.height, height: PORTRAIT.viewport.width }
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure'
  },
  projects: [
    { name: 'mobile-portrait', use: { ...PORTRAIT } },
    { name: 'mobile-landscape', use: { ...LANDSCAPE } }
  ],
  webServer: {
    command: 'bun run build && bun run preview -- --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
