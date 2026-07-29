// playwright.config.ts — mobile emulation (M5-2) and visual regression e2e.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// Three projects over two specs, each pinned with `testMatch` so a mobile
// device profile never picks up the desktop-only visual spec and vice versa.
//
// `mobile-portrait` / `mobile-landscape` share `e2e/mobile.spec.ts`: the same
// device profile with dimensions swapped. Both land in the compact layout —
// `deviceMode.ts`'s breakpoint triggers on width OR height, and a landscape
// phone is short even though it's not narrow.
//
// `visual` runs `e2e/visual.spec.ts`, the screenshot regression over the wire
// bytes `crates/city-sim-core/src/display.rs` derives. It needs a full desktop
// layout (compact mode starts at a different camera zoom) and, above all, a
// fixed viewport: the spec computes its clip rectangles from the canvas
// wrapper's own box, so the viewport is what makes the baselines reproducible.
import { defineConfig, devices } from '@playwright/test';

const PORTRAIT = devices['Pixel 5'];
const LANDSCAPE = {
  ...PORTRAIT,
  viewport: { width: PORTRAIT.viewport.height, height: PORTRAIT.viewport.width }
};

// 1440×900 leaves the fixture band clear of both bottom-anchored HUD panels
// with room to spare. `deviceScaleFactor: 1` keeps the backing store at CSS
// resolution — `renderer.ts` caps Pixi's resolution at 2× device pixel ratio,
// so a DPR of anything but 1 would rasterise the tiles differently.
const VISUAL = {
  ...devices['Desktop Chrome'],
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  launchOptions: {
    args: [
      // Without this Chromium applies the host display's colour profile to
      // the compositor output, so the same pixels come out slightly different
      // on a wide-gamut monitor than on CI.
      '--force-color-profile=srgb',
      // Subpixel antialiasing is host-font-stack dependent; greyscale is not.
      '--disable-lcd-text',
      // Pin the rasteriser: SwiftShader is what headless CI gets, and it is
      // what the committed baselines were captured with. Letting a developer
      // machine silently swap in a real GPU would produce diffs that mean
      // nothing.
      '--disable-gpu',
      '--use-gl=swiftshader',
      '--disable-partial-raster'
    ]
  }
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  // Baselines are per-platform on purpose: Chromium rasterises WebGL
  // differently across operating systems, so a macOS run reports "snapshot
  // missing" (obviously not a regression) instead of a false diff. Linux is
  // what CI runs and what the committed baselines hold.
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{arg}{ext}',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure'
  },
  expect: {
    toHaveScreenshot: {
      // No CSS animation or transition may be mid-flight when the shutter
      // opens, and no text caret may blink into a shot.
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      // Exact match. The tile art is flat dithered pixel art composited by
      // WebGL with a fixed camera — there is no antialiasing jitter to
      // absorb, so any difference at all is a real one worth looking at.
      maxDiffPixels: 0
    }
  },
  projects: [
    { name: 'mobile-portrait', testMatch: /mobile\.spec\.ts/, use: { ...PORTRAIT } },
    { name: 'mobile-landscape', testMatch: /mobile\.spec\.ts/, use: { ...LANDSCAPE } },
    { name: 'visual', testMatch: /visual\.spec\.ts/, use: VISUAL }
  ],
  webServer: {
    command: 'bun run build && bun run preview -- --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
