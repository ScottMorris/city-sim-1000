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
      // Exact match, and it takes BOTH of these to say so.
      //
      // `maxDiffPixels` bounds how many pixels may differ; `threshold` decides
      // what "differ" means, per pixel, as a perceived YIQ distance. Playwright
      // defaults `threshold` to 0.2, and left at that default a pixel has to
      // move by a fifth of the colour space before it is counted at all — so
      // `maxDiffPixels: 0` on its own is not an exact match, it is "no pixel
      // moved a lot". That is not a hypothetical gap here: delta 1 is a single
      // minimap pixel going rail-brown (#6b4a2f) to road-grey (#555), a YIQ
      // distance well inside 0.2, and `d-minimap.png` exists precisely to pin
      // that shift. With the default threshold the harness could not see it.
      //
      // 0 is the honest setting and it is affordable: every clip in
      // `visual.spec.ts` is canvas — flat dithered pixel art composited by
      // WebGL at a fixed camera, with the rasteriser, colour profile and DPR all
      // pinned by the `visual` project above — so there is no antialiasing
      // jitter to absorb and no font rendering in shot.
      //
      // Measured both ways, by swapping rungs 6 and 7 of `wire_kind` so `Road`
      // wins a level crossing again and rebuilding the WASM:
      //   threshold: 0     `d-minimap.png` fails, 11 pixels different, and the
      //                    other three baselines are untouched — exactly what
      //                    `display.rs` predicts for delta 1.
      //   threshold: 0.2   every baseline passes. The only thing that fails is
      //                    the numeric `kindAt` soft assertion in the spec, so
      //                    the *visual* harness saw nothing at all.
      // Neither mutation is committed; re-running that swap is how to check this
      // has not gone blind again.
      threshold: 0,
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
