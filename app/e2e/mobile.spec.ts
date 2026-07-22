// mobile.spec.ts — mobile emulation coverage (M5-2), run in both the
// mobile-portrait and mobile-landscape Playwright projects.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { test, expect, type Page } from '@playwright/test';

declare global {
  interface Window {
    __mcpTest: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  }
}

/** Boots the app with the MCP debug bridge active and waits past the loading screen. */
async function boot(page: Page): Promise<void> {
  await page.goto('/?mcp');
  await page.waitForSelector('#loading-screen', { state: 'detached', timeout: 30_000 });
}

function mcp(page: Page, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(
    ({ method, params }) => window.__mcpTest(method, params),
    { method, params }
  );
}

test.describe('mobile emulation', () => {
  test('compact layout renders with current-tool button and undo', async ({ page }) => {
    await boot(page);
    await expect(page.locator('.toolbar[data-layout-mode="compact"]')).toBeVisible();
    await expect(page.locator('.toolbar-current-tool-btn')).toBeVisible();
    const undoBtn = page.locator('.toolbar-undo-btn');
    await expect(undoBtn).toBeVisible();
    await expect(undoBtn).toBeDisabled();
  });

  test('tool sheet opens, picks Road, and closes', async ({ page }) => {
    await boot(page);
    const sheet = page.locator('.tool-sheet');
    await expect(sheet).not.toHaveClass(/open/);

    await page.locator('.toolbar-current-tool-btn').tap();
    await expect(sheet).toHaveClass(/open/);

    await page.locator('.tool-sheet-button[data-tool="road"]').tap();
    await expect(sheet).not.toHaveClass(/open/);
    await expect(page.locator('.toolbar')).toHaveAttribute('data-active-tool', 'road');
  });

  test('two-finger gesture pans the camera without painting a tile', async ({ page }) => {
    await boot(page);
    await mcp(page, 'set_speed', { multiplier: 0 });

    // Road is the active tool so a stray one-finger touch would leave visible
    // evidence — the gesture below must be read as camera control, not paint.
    await page.locator('.toolbar-current-tool-btn').tap();
    await page.locator('.tool-sheet-button[data-tool="road"]').tap();

    const box = await page.locator('#canvas-wrapper').boundingBox();
    if (!box) throw new Error('#canvas-wrapper has no layout box');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Playwright's own (CDP-based) element screenshot, not the MCP `screenshot`
    // op — that reads the WebGL canvas via `toDataURL()`, which races the
    // browser's implicit buffer clear (no `preserveDrawingBuffer`) and can
    // return a stale/blank capture unrelated to what's actually on screen.
    const before = await page.locator('#canvas-wrapper').screenshot();

    await page.evaluate(({ cx, cy }) => {
      const wrapper = document.querySelector('#canvas-wrapper');
      if (!wrapper) throw new Error('#canvas-wrapper missing');
      const fire = (type: string, id: number, x: number, y: number) => {
        wrapper.dispatchEvent(
          new PointerEvent(type, {
            pointerId: id,
            pointerType: 'touch',
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
            isPrimary: id === 1,
            buttons: 1
          })
        );
      };
      // Both fingers land in the same tick — well inside the 60 ms grace
      // window `main.ts` gives a first touch before committing a paint — then
      // move apart while shifting sideways, which both pans and pinch-zooms.
      fire('pointerdown', 1, cx - 30, cy);
      fire('pointerdown', 2, cx + 30, cy);
      fire('pointermove', 1, cx - 70, cy - 25);
      fire('pointermove', 2, cx + 70, cy + 25);
      fire('pointerup', 1, cx - 70, cy - 25);
      fire('pointerup', 2, cx + 70, cy + 25);
    }, { cx, cy });

    // Let the render loop pick up the new camera position.
    await page.waitForTimeout(200);

    const after = await page.locator('#canvas-wrapper').screenshot();
    expect(before.equals(after)).toBe(false);

    const roadTiles = await mcp(page, 'get_tiles_where', { kind: 'road' });
    expect(roadTiles).toEqual([]);
  });

  test('autosave fires on visibilitychange', async ({ page }) => {
    await boot(page);
    await mcp(page, 'apply_tool', { tool: 'road', x: 2, y: 2 });
    // Give the sim clock a moment to advance the tick past the autosave
    // module's initial sentinel, so the hidden-tab flush isn't skipped as "no
    // new tick since the last write".
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden'
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              new Promise<boolean>((resolve, reject) => {
                const openReq = indexedDB.open('city-sim-1000');
                openReq.onerror = () => reject(openReq.error);
                openReq.onsuccess = () => {
                  const db = openReq.result;
                  const getReq = db.transaction('saves', 'readonly').objectStore('saves').get('autosave');
                  getReq.onerror = () => reject(getReq.error);
                  getReq.onsuccess = () => resolve(getReq.result != null);
                };
              })
          ),
        { timeout: 10_000 }
      )
      .toBe(true);
  });
});
