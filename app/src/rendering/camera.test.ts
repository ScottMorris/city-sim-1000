import { describe, it, expect } from 'vitest';
import {
  Camera,
  MAX_SCALE,
  MIN_SCALE,
  createCamera,
  centerCamera,
  screenToTile,
  zoomAt
} from './camera';

const TILE_SIZE = 32;

// screenToTile only touches width/height/getBoundingClientRect, so a plain
// object stands in for the canvas under the node test environment.
function fakeCanvas(
  width: number,
  height: number,
  rect: Partial<DOMRect> = {}
): HTMLCanvasElement {
  const fullRect = { left: 0, top: 0, width, height, ...rect };
  return {
    width,
    height,
    getBoundingClientRect: () => fullRect
  } as unknown as HTMLCanvasElement;
}

function fakeWrapper(clientWidth: number, clientHeight: number): HTMLElement {
  return { clientWidth, clientHeight } as HTMLElement;
}

// Screen position of a tile's centre for a 1:1 canvas anchored at the origin —
// the inverse of screenToTile, used to drive round-trip checks.
function tileCentreToScreen(camera: Camera, tx: number, ty: number) {
  const size = TILE_SIZE * camera.scale;
  return {
    clientX: camera.x + (tx + 0.5) * size,
    clientY: camera.y + (ty + 0.5) * size
  };
}

describe('createCamera', () => {
  it('starts at the origin with scale 1', () => {
    expect(createCamera()).toEqual({ x: 0, y: 0, scale: 1 });
  });
});

describe('centerCamera', () => {
  it('centres the map in the wrapper at scale 1', () => {
    const camera = createCamera();
    const state = { width: 10, height: 10 } as any;
    centerCamera(state, fakeWrapper(800, 600), TILE_SIZE, camera);
    expect(camera.x).toBe(800 / 2 - (10 * TILE_SIZE) / 2);
    expect(camera.y).toBe(600 / 2 - (10 * TILE_SIZE) / 2);
  });

  it('accounts for the current scale', () => {
    const camera = createCamera();
    camera.scale = 2;
    const state = { width: 10, height: 10 } as any;
    centerCamera(state, fakeWrapper(800, 600), TILE_SIZE, camera);
    expect(camera.x).toBe(800 / 2 - (10 * TILE_SIZE * 2) / 2);
    expect(camera.y).toBe(600 / 2 - (10 * TILE_SIZE * 2) / 2);
  });
});

describe('screenToTile', () => {
  it('maps client coordinates to tiles with an identity camera', () => {
    const camera = createCamera();
    const canvas = fakeCanvas(800, 600);
    expect(screenToTile(camera, TILE_SIZE, canvas, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(screenToTile(camera, TILE_SIZE, canvas, TILE_SIZE - 1, 0)).toEqual({ x: 0, y: 0 });
    expect(screenToTile(camera, TILE_SIZE, canvas, TILE_SIZE, TILE_SIZE * 2)).toEqual({
      x: 1,
      y: 2
    });
  });

  it('floors towards negative infinity left of the map', () => {
    const camera = createCamera();
    camera.x = TILE_SIZE;
    const canvas = fakeCanvas(800, 600);
    expect(screenToTile(camera, TILE_SIZE, canvas, TILE_SIZE / 2, 0)).toEqual({ x: -1, y: 0 });
  });

  it('applies camera pan and zoom', () => {
    const camera: Camera = { x: 100, y: 50, scale: 2 };
    const canvas = fakeCanvas(800, 600);
    const size = TILE_SIZE * camera.scale;
    expect(
      screenToTile(camera, TILE_SIZE, canvas, 100 + 3 * size + 1, 50 + 2 * size + 1)
    ).toEqual({ x: 3, y: 2 });
  });

  it('ignores the canvas backing store size — only the CSS rect matters', () => {
    // Pixi's stage coordinates (and camera.x/y) are always in CSS/logical
    // pixels regardless of resolution/devicePixelRatio; canvas.width/height
    // (the backing store) only controls rendering sharpness. A tap must map
    // the same way whether resolution is 1 (backing store == CSS size) or
    // capped at 2 on a high-DPI phone (backing store == 2x CSS size) — this
    // was a real bug (M4-2's resolution cap): scaling by canvas.width/rect.width
    // here put every tap resolution× further from the camera origin than
    // intended, e.g. the DPR-2/resolution-2 case below used to compute
    // { x: 1, y: 0 } for a tap at the midpoint of tile 0.
    const camera = createCamera();
    const canvas1x = fakeCanvas(800, 600, { width: 800, height: 600 });
    const canvas2x = fakeCanvas(1600, 1200, { width: 800, height: 600 });
    const expected = { x: 0, y: 0 };
    expect(screenToTile(camera, TILE_SIZE, canvas1x, TILE_SIZE / 2, 0)).toEqual(expected);
    expect(screenToTile(camera, TILE_SIZE, canvas2x, TILE_SIZE / 2, 0)).toEqual(expected);
  });

  it('offsets by the canvas position in the page', () => {
    const camera = createCamera();
    const canvas = fakeCanvas(800, 600, { left: 40, top: 20, width: 800, height: 600 });
    expect(screenToTile(camera, TILE_SIZE, canvas, 40, 20)).toEqual({ x: 0, y: 0 });
  });

  it('round-trips tile centres across pans and zooms', () => {
    const canvas = fakeCanvas(800, 600);
    const cameras: Camera[] = [
      { x: 0, y: 0, scale: 1 },
      { x: 240, y: 140, scale: 1 },
      { x: -37.5, y: 12.25, scale: 0.5 },
      { x: 15.75, y: -60.5, scale: 2.4 }
    ];
    for (const camera of cameras) {
      for (const [tx, ty] of [
        [0, 0],
        [5, 3],
        [12, 12]
      ]) {
        const { clientX, clientY } = tileCentreToScreen(camera, tx, ty);
        expect(screenToTile(camera, TILE_SIZE, canvas, clientX, clientY)).toEqual({
          x: tx,
          y: ty
        });
      }
    }
  });
});

describe('zoomAt', () => {
  const worldPointAt = (camera: Camera, focusX: number, focusY: number) => ({
    x: (focusX - camera.x) / camera.scale,
    y: (focusY - camera.y) / camera.scale
  });

  it('keeps the world point under the focus stationary while zooming in', () => {
    const camera: Camera = { x: 240, y: 140, scale: 1 };
    const before = worldPointAt(camera, 400, 300);
    zoomAt(camera, 400, 300, 1.25);
    expect(camera.scale).toBeCloseTo(1.25, 10);
    const after = worldPointAt(camera, 400, 300);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
  });

  it('keeps the anchor stationary across repeated zooms in both directions', () => {
    const camera: Camera = { x: -12.5, y: 48, scale: 1 };
    const before = worldPointAt(camera, 123, 456);
    for (const factor of [1.1, 1.1, 0.85, 1.3, 0.9]) {
      zoomAt(camera, 123, 456, factor);
      const after = worldPointAt(camera, 123, 456);
      expect(after.x).toBeCloseTo(before.x, 8);
      expect(after.y).toBeCloseTo(before.y, 8);
    }
  });

  it('keeps the hovered tile fixed under the cursor through a zoom', () => {
    const camera: Camera = { x: 240, y: 140, scale: 1 };
    const canvas = fakeCanvas(800, 600);
    const clientX = 500.5;
    const clientY = 322.25;
    const before = screenToTile(camera, TILE_SIZE, canvas, clientX, clientY);
    zoomAt(camera, clientX, clientY, 1.15);
    zoomAt(camera, clientX, clientY, 1.15);
    expect(screenToTile(camera, TILE_SIZE, canvas, clientX, clientY)).toEqual(before);
  });

  it('is a no-op with factor 1', () => {
    const camera: Camera = { x: 33, y: -7, scale: 1.5 };
    zoomAt(camera, 100, 200, 1);
    expect(camera).toEqual({ x: 33, y: -7, scale: 1.5 });
  });

  it('inverse factors restore the original view', () => {
    const camera: Camera = { x: 240, y: 140, scale: 1 };
    zoomAt(camera, 400, 300, 2);
    zoomAt(camera, 400, 300, 0.5);
    expect(camera.scale).toBeCloseTo(1, 10);
    expect(camera.x).toBeCloseTo(240, 10);
    expect(camera.y).toBeCloseTo(140, 10);
  });

  it('clamps to MAX_SCALE and stays anchored when the clamp engages', () => {
    const camera: Camera = { x: 0, y: 0, scale: 2.9 };
    const before = worldPointAt(camera, 400, 300);
    zoomAt(camera, 400, 300, 1.5);
    expect(camera.scale).toBe(MAX_SCALE);
    const after = worldPointAt(camera, 400, 300);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
    // Further zooming in changes nothing once clamped.
    const clamped = { ...camera };
    zoomAt(camera, 400, 300, 1.5);
    expect(camera.scale).toBe(MAX_SCALE);
    expect(camera.x).toBeCloseTo(clamped.x, 10);
    expect(camera.y).toBeCloseTo(clamped.y, 10);
  });

  it('clamps to MIN_SCALE and stays anchored when the clamp engages', () => {
    const camera: Camera = { x: 120, y: 80, scale: 0.55 };
    const before = worldPointAt(camera, 50, 60);
    zoomAt(camera, 50, 60, 0.5);
    expect(camera.scale).toBe(MIN_SCALE);
    const after = worldPointAt(camera, 50, 60);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
  });

  it('honours custom clamp bounds', () => {
    const camera: Camera = { x: 0, y: 0, scale: 1 };
    zoomAt(camera, 0, 0, 10, 0.25, 4);
    expect(camera.scale).toBe(4);
    zoomAt(camera, 0, 0, 0.001, 0.25, 4);
    expect(camera.scale).toBe(0.25);
  });
});
