// visual.spec.ts — screenshot regression over the derived wire bytes.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// `crates/city-sim-core/src/display.rs` exists to emit `(kind, flags,
// underground)` bytes that a renderer interprets. Every other test in the
// repo checks those bytes numerically, which cannot notice a *wrong sprite*
// — the byte can be right by the unit test's lights and still draw the wrong
// thing, or be wrong in a way no assertion happens to name. This spec closes
// that: it builds one small fixed city out of exactly the tiles whose
// derivation is load-bearing, and pins what a player actually sees.
//
// It is deliberately organised around `display.rs`'s "three deltas" — the
// three classes of tile that come off the wire differently than they did at
// `fix(sim): read every stratum, so no feature goes uncounted` — step 2 of
// #177, the last commit where `kind` was canonical:
//
//   delta 1  a bare level crossing — rail now wins the kind byte in both
//            build orders, so a road-last crossing's *flat* colour moves.
//            The sprite is unchanged; the minimap pixel is not.
//   delta 2  a bare hydro line — `PowerLine` now wins over a regrade, so a
//            terraformed line draws the opaque hydro sprite instead of grass
//            with a transparent wire on top. **Measured here to be a visual
//            no-op** — see the fixture comment in region B.
//   delta 3  a bulldozed footprint building — the razed tile now emits
//            `Land` instead of keeping a ghost `Park`.
//
// Each fixture below names the delta it pins, or says explicitly that it is
// a control that must NOT have moved.
//
// The images are known to be *sensitive*, not merely stable: reverting
// `wire_kind`'s road/rail precedence (delta 1) moves `d-minimap.png` by 11
// pixels and nothing else, exactly as `display.rs` predicts, and dropping its
// zone rung moves `b-hydro-lines.png` by 3919 pixels. Neither mutation is
// committed; re-running them is the way to check the harness has not gone blind.
//
// That first one is only visible because `playwright.config.ts` pins the
// per-pixel `threshold` at 0. Playwright's default of 0.2 lets a pixel move a
// fifth of the colour space before it counts as different at all, and delta 1 is
// one minimap tile going rail-brown to road-grey — a step of 0.155, smaller than
// that.
// Measured: with the engine reverted and `threshold: 0.2`, all four baselines
// pass and only the `kindAt` assertions below notice. If either setting is ever
// loosened, this spec stops being able to see the delta it exists for.
//
// Run:     bun run test:visual
// Update:  bun run test:visual:update
//
// (`bun run test:e2e` runs this project too, alongside the two mobile ones —
// the split scripts are just for iterating on the baselines.)
//
// Baselines live in `e2e/__screenshots__/<platform>/` and are per-platform by
// design: WebGL rasterisation differs between Chromium's SwiftShader build on
// Linux and on macOS, so a macOS run reports "snapshot missing" (loud, and
// obviously not a regression) rather than a false diff. CI is Linux, and the
// committed Linux baselines are the authoritative ones.

import { test, expect, type Page } from '@playwright/test';
import { TILE_SIZE } from '../src/rendering/sprites';

declare global {
  interface Window {
    __mcpTest: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  }
}

/** Matches `createInitialState`'s default map size. */
const MAP_TILES = 64;

function mcp(page: Page, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(
    ({ method, params }) => window.__mcpTest(method, params),
    { method, params }
  );
}

const tool = (page: Page, t: string, x: number, y: number) =>
  mcp(page, 'apply_tool', { tool: t, x, y });

const line = (page: Page, t: string, x1: number, y1: number, x2: number, y2: number) =>
  mcp(page, 'apply_tool_line', { tool: t, x1, y1, x2, y2 });

const rect = (page: Page, t: string, x1: number, y1: number, x2: number, y2: number) =>
  mcp(page, 'apply_tool_rect', { tool: t, x1, y1, x2, y2 });

async function kindAt(page: Page, x: number, y: number): Promise<string> {
  const t = (await mcp(page, 'get_tile', { x, y })) as { kind: string };
  return t.kind;
}

/**
 * Wrapper geometry, read out of the live page rather than assumed.
 *
 * The camera is `centerCamera`'d at scale 1 on a desktop layout and nothing in
 * this spec moves it (no wheel, no drag, no keyboard pan, and the pointer is
 * never brought over the canvas), so tile → screen is a pure function of the
 * wrapper's own box. Deriving the clip from `clientWidth`/`clientHeight` here
 * rather than hard-coding pixel rectangles means a layout change shifts the
 * clip with the map instead of silently cropping a different set of tiles.
 */
async function tileClipper(page: Page) {
  const geom = await page.evaluate(() => {
    const wrapper = document.querySelector('#canvas-wrapper') as HTMLElement | null;
    if (!wrapper) throw new Error('#canvas-wrapper missing');
    const box = wrapper.getBoundingClientRect();
    return {
      left: box.left,
      top: box.top,
      clientWidth: wrapper.clientWidth,
      clientHeight: wrapper.clientHeight
    };
  });
  const camX = geom.clientWidth / 2 - (MAP_TILES * TILE_SIZE) / 2;
  const camY = geom.clientHeight / 2 - (MAP_TILES * TILE_SIZE) / 2;
  return (x0: number, y0: number, x1: number, y1: number) => {
    const clip = {
      x: Math.round(geom.left + camX + x0 * TILE_SIZE),
      y: Math.round(geom.top + camY + y0 * TILE_SIZE),
      width: (x1 - x0 + 1) * TILE_SIZE,
      height: (y1 - y0 + 1) * TILE_SIZE
    };
    if (clip.x < 0 || clip.y < 0) {
      throw new Error(
        `tile rect (${x0},${y0})–(${x1},${y1}) is off the top/left of the viewport ` +
          `(clip ${JSON.stringify(clip)}) — the fixture band no longer fits the camera`
      );
    }
    return clip;
  };
}

/** Collapses/expands the minimap panel via its header chip. */
async function toggleMinimap(page: Page): Promise<void> {
  await page.locator('.minimap-header-controls .chip-button').click();
}

/**
 * Builds the fixture city.
 *
 * Everything sits in one horizontal band, rows 22–30, in three regions that
 * each get their own clipped snapshot. The band is above the bottom-anchored
 * HUD panels (`.overlay` bottom-left, `.minimap-panel` bottom-right) so no
 * chrome can drift into a shot.
 */
async function buildFixture(page: Page): Promise<void> {
  // --- Region A — level crossings, x 13–22 -------------------------------
  // Two physically identical level crossings built in opposite orders. Under
  // v4 they were spelled differently; `commands.rs` now writes `Rail` +
  // `ROAD_UNDERLAY` for both. The base sprite was always order-agnostic
  // (`resolveBaseTileSprite` tests both spellings), so these two tiles must
  // look the same as each other here — the delta only shows on the flat-colour
  // paths, which is what the minimap shot below is for.
  await line(page, 'rail', 15, 24, 15, 28);
  await line(page, 'road', 20, 24, 20, 28);
  // (15,26): rail was there first, the road is laid last. DELTA 1 — v4 wrote
  // `Road` + `RAIL_UNDERLAY` here; it is now `Rail` + `ROAD_UNDERLAY`.
  await line(page, 'road', 13, 26, 17, 26);
  // (20,26): road first, rail last — the spelling v4 already used, unchanged.
  await line(page, 'rail', 18, 26, 22, 26);

  // --- Region B — hydro lines, x 25–39 -----------------------------------
  // A single vertical hydro line strung last across a road (y=24), a rail
  // (y=26) and a residential zone (y=28), with bare span between them. All
  // three crossings keep their surface — the line is a different stratum —
  // and all three are controls: v4 spelled them the same way.
  await line(page, 'road', 26, 24, 30, 24);
  await line(page, 'rail', 26, 26, 30, 26);
  await rect(page, 'residential', 26, 28, 30, 28);
  await line(page, 'powerline', 28, 23, 28, 29);

  // A bare hydro run on open ground — the ordinary spelling, a control.
  await line(page, 'powerline', 34, 24, 37, 24);

  // (34,26) is an isolated bare line; (37,26) is the same line put through a
  // regrade. DELTA 2 — v4 demoted the regraded one to `Land` +
  // `POWER_OVERLAY`, drawing grass with a transparent wire on top; it now
  // emits `PowerLine` and draws the opaque hydro sprite.
  //
  // Measured result, and it is worth knowing: **delta 2 is invisible.** Both
  // spellings composite to exactly the same pixels — the opaque hydro texture
  // is the transparent one over the same grass fill (`tileAtlas.ts`:
  // "Transparent twins of the hydro set … grass fill omitted"), and
  // `minimap.ts` tests `powerOverlay` before anything else, so both spellings
  // take the hydro palette there too. Deleting the `PowerLine` rung from
  // `wire_kind` leaves all four baselines byte-identical; only the `kindAt`
  // assertion below notices. So delta 2's documented visual consequence is
  // real as a code path and nil as a rendering, and this pair of tiles is
  // pinned numerically rather than visually. Keep them in the shot anyway:
  // if the two hydro texture sets ever diverge, this is where it shows up.
  await tool(page, 'powerline', 34, 26);
  await tool(page, 'powerline', 37, 26);
  await tool(page, 'terraform_raise', 37, 26);

  // --- Region C — parks and water, x 41–52 -------------------------------
  await tool(page, 'park', 42, 24);
  await tool(page, 'park_large', 44, 24); // 2×2, covers (44,24)–(45,25)
  // (48,24): built then razed. DELTA 3 — `remove_building` used to leave a
  // ghost `Park` kind behind (a second bulldozer click to clear, and +4.0 of
  // wilderness for ever); the tile now emits `Land` and draws bare ground.
  await tool(page, 'park', 48, 24);
  await tool(page, 'bulldoze', 48, 24);
  // (50,24) is the control the razed tile has to differ from.
  await tool(page, 'park', 50, 24);

  // A small lake for the water-edge sprites, then the bulldozer on one of its
  // tiles. Bulldozing water does *not* drain it — only a build-then-raze pair
  // regrades (`building_over_water_and_razing_it_is_the_cheapest_regrade`) —
  // so (43,28) must still be water, indistinguishable from its neighbours.
  await rect(page, 'water', 42, 27, 45, 29);
  await tool(page, 'bulldoze', 43, 28);
}

test.describe('tile derivation — visual regression', () => {
  // One page, one city, four images: booting and building the fixture is the
  // expensive part, so it is not paid four times over.
  test('the three display deltas draw the way they are meant to', async ({ page }) => {
    await page.goto('/?mcp');
    await page.waitForSelector('#loading-screen', { state: 'detached', timeout: 30_000 });

    // Freeze the clock before anything else. With the sim stopped the rendered
    // frame is a pure function of the tiles this spec places: no zone growth,
    // no abandonment, no service decay, nothing that would make the image
    // depend on how long the machine took to get here.
    //
    // Note what is *not* here: `mcp reset`. It is deliberately unused, because
    // it does not work for rendering — `WasmSimBridge.newCity` rebinds its own
    // `state` to the fresh `GameState` while `main.ts` keeps the const it was
    // constructed with, so after a reset `bridge.getState()` reports the new
    // city and the renderer goes on drawing the old one for ever. See the
    // harness report. Not resetting costs nothing: `createInitialState`'s
    // terrain is a pure function of (x, y) — the seed only feeds the RNG — so
    // the boot city is byte-identical every run anyway, and freezing the clock
    // before the first zone exists means the seed never gets to matter.
    await mcp(page, 'set_speed', { multiplier: 0 });

    await buildFixture(page);

    // Assert the derived kinds before looking at pixels. A build that silently
    // failed (a refusal, a renamed tool) would otherwise show up as an
    // inscrutable image diff; this names it instead. These four also pin the
    // three deltas numerically, on the TypeScript side of the wire.
    expect
      .soft(await kindAt(page, 15, 26), 'delta 1: road-last crossing is spelled rail')
      .toBe('rail');
    expect
      .soft(await kindAt(page, 20, 26), 'delta 1: rail-last crossing is spelled rail')
      .toBe('rail');
    expect
      .soft(await kindAt(page, 37, 26), 'delta 2: a regraded hydro line stays a line')
      .toBe('powerline');
    expect
      .soft(await kindAt(page, 48, 24), 'delta 3: a razed park leaves bare ground')
      .toBe('land');
    expect.soft(await kindAt(page, 50, 24), 'the un-razed park control').toBe('park');
    expect.soft(await kindAt(page, 43, 28), 'the bulldozer does not drain a lake').toBe('water');

    // Collapse the minimap so it cannot drift into a canvas clip if the HUD
    // is ever relaid out. It comes back for its own shot below.
    await toggleMinimap(page);
    await expect(page.locator('.minimap-canvas-wrapper')).toBeHidden();

    const clip = await tileClipper(page);

    // Delta 1. Both crossings, one built each way round. They must be the same
    // sprite as each other and unchanged from the pre-strata renderer.
    await expect
      .soft(page)
      .toHaveScreenshot('a-level-crossings.png', { clip: clip(12, 22, 23, 30) });

    // Delta 2, plus the three "line over something" controls.
    //
    // The one image that cannot hold the project's `threshold: 0`, and the only
    // one that needs an exception. CI's Chromium renders a 36-pixel cluster in
    // this clip (around x 95–99, y 185–190) differently from a developer
    // machine's — worst pair `(170,219,113)` → `(204,233,170)`, a visibly
    // different green rather than a rounding step. Pinning the rasteriser to
    // SwiftShader makes a run reproducible *on one machine*; it does not make
    // two Chromium builds agree bit-for-bit, and `threshold: 0` here fails on
    // GitHub Actions while passing locally.
    //
    // Measured from a failing run's artefacts, through the same YIQ metric
    // Playwright compares against (`pixelmatch`, `maxDelta = 35215`):
    //
    //   0.1032   worst cross-machine noise pixel in this clip (median 0.0277)
    //   0.1250   this allowance
    //   0.1549   delta 1, rail-brown 0x8c6b3e → road-grey 0x7f8894
    //
    // The allowance is deliberately scoped to this one image rather than set
    // globally, because delta 1 lives in `d-minimap.png` — which saw *zero* CI
    // noise, and so keeps exact matching. Spending the delta-1 margin globally
    // to fix a local problem is how this harness would go blind. What this
    // image itself exists to catch is unaffected, and that was re-measured
    // *with this allowance in place* rather than inherited: dropping
    // `wire_kind`'s zone rung still moves it 3919 pixels — about 100× the noise
    // being absorbed — and moves `d-minimap.png` by 26.
    //
    // Re-derive these numbers from a failing run's `-actual.png` rather than
    // trusting them if the runner image or Chromium version moves.
    await expect
      .soft(page)
      .toHaveScreenshot('b-hydro-lines.png', { clip: clip(25, 22, 39, 30), threshold: 0.125 });

    // Delta 3, plus the water-edge and bulldozed-water tiles.
    await expect
      .soft(page)
      .toHaveScreenshot('c-parks-and-water.png', { clip: clip(41, 22, 52, 30) });

    // The minimap is the one consumer that reads `railUnderlay` *before*
    // `roadUnderlay`, so the road-last crossing at (15,26) is exactly the pixel
    // that moved rail-brown → road-grey under delta 1. Nothing in the numeric
    // suites looks at this canvas at all.
    await toggleMinimap(page);
    const minimap = page.locator('.minimap-canvas');
    await expect(minimap).toBeVisible();
    // `minimap.ts` only redraws when it is dirty *and* 80 ms have passed since
    // the last redraw; re-opening the panel sets the dirty flag, so this is
    // just waiting for the throttle window plus a frame.
    await page.waitForTimeout(250);

    // Clipped to the fixture band rather than shot whole, and that is a
    // correctness point before it is a robustness one: the fixture occupies
    // tiles 12–29 across rows 22–30, and the rest of this canvas is procedurally
    // shaded wilderness that no assertion here is about. Shooting all 44 100
    // pixels imported 42 000 of them as unexamined background.
    //
    // It also happens to be the only version of this that can pass on CI. The
    // untouched terrain renders differently on a GitHub Actions runner — 1702
    // pixels over the whole canvas, and one of those transitions is a YIQ step
    // of 0.1545, which is delta 1's own magnitude of 0.1549. Signal and noise
    // are the same size out there, so no `threshold` could separate them and
    // loosening one would simply blind the test. Measured inside this band, on
    // the same failing run's artefact: **zero** differing pixels. The crossings
    // themselves are stable across machines; the grass is not.
    //
    // So this keeps the project's exact match — no per-image `threshold` — on
    // precisely the tiles delta 1 moves.
    const box = await minimap.boundingBox();
    if (!box) throw new Error('.minimap-canvas has no bounding box');
    // The canvas draws the whole 64×64 map edge to edge, so one tile is
    // `box.width / MAP_TILES` and the band is derived rather than hard-coded.
    const px = box.width / MAP_TILES;
    const py = box.height / MAP_TILES;
    await expect.soft(page).toHaveScreenshot('d-minimap.png', {
      clip: {
        x: Math.floor(box.x + 12 * px),
        y: Math.floor(box.y + 22 * py),
        width: Math.ceil(18 * px),
        height: Math.ceil(9 * py)
      }
    });
  });
});
