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
      // moved a lot" — it bounds a set that is nearly always empty.
      //
      // That is not a hypothetical gap here. Delta 1 turns one minimap tile from
      // rail-brown to road-grey — `sprites.ts`'s palette, `0x8c6b3e` to
      // `0x7f8894` — and `d-minimap.png` exists precisely to pin that shift. Put
      // through the same YIQ metric Playwright compares against, that pair sits
      // 844 apart, which is a `threshold` of 0.155: inside the default, so at 0.2
      // the harness could not see the one delta it was built for.
      //
      // 0 is the honest setting and it is affordable. `visual.spec.ts` is the
      // only spec under `e2e/` that screenshots at all, and every clip it takes
      // is canvas — flat dithered pixel art composited by WebGL at a fixed
      // camera, with the rasteriser, colour profile and DPR all pinned by the
      // `visual` project above — so there is no antialiasing jitter to absorb and
      // no font or DOM text in shot. None of 0's usual *timing* flakiness risks
      // are here: three parallel repeats run green, and the same run repeats
      // green on one machine all day.
      //
      // It is still not free, and the exception is worth knowing about before
      // you add a fixture. Reproducible-on-one-machine is not the same as
      // identical-across-machines: GitHub Actions' Chromium renders a 36-pixel
      // cluster of one clip differently from a developer machine, up to a YIQ
      // distance of 0.1032 — a visibly different green, not a rounding step. So
      // `b-hydro-lines.png` carries a measured per-call `threshold` of its own,
      // documented at the assertion in `visual.spec.ts`. Every other baseline
      // holds 0 on both, including `d-minimap.png`, which is the one that
      // matters: it pins delta 1, and it saw zero CI noise. A new fixture that
      // fails only on CI wants the same per-image treatment, sized from that
      // run's artefacts — not a global loosening, which would spend delta 1's
      // margin to fix an unrelated image.
      //
      // Measured both ways, by swapping the `Rail` and `Road` rungs of
      // `wire_kind` so `Road` wins a level crossing again and rebuilding the
      // WASM:
      //   threshold: 0     `d-minimap.png` fails, 11 pixels different (a tile is
      //                    drawn several pixels wide), and the other three
      //                    baselines are untouched — exactly what `display.rs`
      //                    predicts for delta 1. Unmutated, all four pass.
      //   threshold: 0.2   every baseline passes, no pixel counted as different
      //                    anywhere. The only thing that fails is the numeric
      //                    `kindAt` soft assertion in the spec, so the *visual*
      //                    harness saw nothing at all.
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
