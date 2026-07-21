import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_COMPACT_BREAKPOINT_PX, initDeviceMode } from './deviceMode';

// A minimal MediaQueryList stand-in with a `set` helper to fire the same
// 'change' event a real browser fires when the query's match state flips
// (e.g. crossing the breakpoint, or a mouse plugged into a tablet).
class FakeMediaQueryList {
  matches: boolean;
  private listeners = new Set<(event: { matches: boolean }) => void>();

  constructor(matches: boolean) {
    this.matches = matches;
  }

  addEventListener(_type: 'change', listener: (event: { matches: boolean }) => void) {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'change', listener: (event: { matches: boolean }) => void) {
    this.listeners.delete(listener);
  }

  set(matches: boolean) {
    this.matches = matches;
    this.listeners.forEach((listener) => listener({ matches }));
  }
}

interface FakeWindowOptions {
  pointerCoarse: boolean;
  compact: boolean;
  maxTouchPoints?: number;
  innerWidth?: number;
  matchMediaSupported?: boolean;
}

function fakeWindow(options: FakeWindowOptions) {
  const pointerQuery = new FakeMediaQueryList(options.pointerCoarse);
  const layoutQuery = new FakeMediaQueryList(options.compact);
  const resizeListeners = new Set<() => void>();

  const matchMedia = options.matchMediaSupported === false
    ? undefined
    : (query: string) => (query.includes('pointer') ? pointerQuery : layoutQuery) as unknown as MediaQueryList;

  const win = {
    navigator: { maxTouchPoints: options.maxTouchPoints ?? 0 },
    innerWidth: options.innerWidth ?? 1200,
    matchMedia,
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'resize') resizeListeners.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === 'resize') resizeListeners.delete(listener);
    }
  } as unknown as Window;

  return {
    win,
    pointerQuery,
    layoutQuery,
    fireResize: () => resizeListeners.forEach((listener) => listener())
  };
}

describe('initDeviceMode — derivation matrix', () => {
  it('touch + compact: coarse pointer under the breakpoint', () => {
    const { win } = fakeWindow({ pointerCoarse: true, compact: true });
    expect(initDeviceMode({ window: win }).getMode()).toEqual({ inputMode: 'touch', layoutMode: 'compact' });
  });

  it('touch + full: coarse pointer over the breakpoint (e.g. a tablet in landscape)', () => {
    const { win } = fakeWindow({ pointerCoarse: true, compact: false });
    expect(initDeviceMode({ window: win }).getMode()).toEqual({ inputMode: 'touch', layoutMode: 'full' });
  });

  it('mouse + compact: fine pointer in a narrow window', () => {
    const { win } = fakeWindow({ pointerCoarse: false, compact: true });
    expect(initDeviceMode({ window: win }).getMode()).toEqual({ inputMode: 'mouse', layoutMode: 'compact' });
  });

  it('mouse + full: fine pointer, wide window', () => {
    const { win } = fakeWindow({ pointerCoarse: false, compact: false });
    expect(initDeviceMode({ window: win }).getMode()).toEqual({ inputMode: 'mouse', layoutMode: 'full' });
  });
});

describe('initDeviceMode — live re-evaluation', () => {
  it('flips inputMode when a mouse is plugged into a tablet', () => {
    const { win, pointerQuery } = fakeWindow({ pointerCoarse: true, compact: false });
    const onChange = vi.fn();
    const controller = initDeviceMode({ window: win, onChange });

    pointerQuery.set(false);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ inputMode: 'mouse', layoutMode: 'full' });
    expect(controller.getMode()).toEqual({ inputMode: 'mouse', layoutMode: 'full' });
  });

  it('flips layoutMode when the viewport crosses the breakpoint', () => {
    const { win, layoutQuery } = fakeWindow({ pointerCoarse: false, compact: false });
    const onChange = vi.fn();
    initDeviceMode({ window: win, onChange });

    layoutQuery.set(true);

    expect(onChange).toHaveBeenCalledWith({ inputMode: 'mouse', layoutMode: 'compact' });
  });

  it('does not call onChange when a query fires with an unchanged match state', () => {
    const { win, pointerQuery } = fakeWindow({ pointerCoarse: true, compact: false });
    const onChange = vi.fn();
    initDeviceMode({ window: win, onChange });

    pointerQuery.set(true);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('stops re-evaluating after dispose', () => {
    const { win, pointerQuery } = fakeWindow({ pointerCoarse: true, compact: false });
    const onChange = vi.fn();
    const controller = initDeviceMode({ window: win, onChange });

    controller.dispose();
    pointerQuery.set(false);

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('initDeviceMode — fallback without matchMedia', () => {
  it('derives inputMode from maxTouchPoints', () => {
    const { win } = fakeWindow({ pointerCoarse: false, compact: false, matchMediaSupported: false, maxTouchPoints: 5 });
    expect(initDeviceMode({ window: win }).getMode().inputMode).toBe('touch');
  });

  it('derives layoutMode from innerWidth against the breakpoint', () => {
    const { win } = fakeWindow({
      pointerCoarse: false,
      compact: false,
      matchMediaSupported: false,
      innerWidth: DEFAULT_COMPACT_BREAKPOINT_PX
    });
    expect(initDeviceMode({ window: win }).getMode().layoutMode).toBe('compact');
  });

  it('re-evaluates layoutMode on resize', () => {
    const { win, fireResize } = fakeWindow({
      pointerCoarse: false,
      compact: false,
      matchMediaSupported: false,
      innerWidth: 1200
    });
    const onChange = vi.fn();
    initDeviceMode({ window: win, onChange });

    (win as unknown as { innerWidth: number }).innerWidth = 400;
    fireResize();

    expect(onChange).toHaveBeenCalledWith({ inputMode: 'mouse', layoutMode: 'compact' });
  });
});

describe('initDeviceMode — custom breakpoint', () => {
  it('honours a caller-supplied compactBreakpointPx', () => {
    const { win } = fakeWindow({ pointerCoarse: false, compact: false, matchMediaSupported: false, innerWidth: 500 });
    expect(initDeviceMode({ window: win, compactBreakpointPx: 400 }).getMode().layoutMode).toBe('full');
  });
});
