// Derives touch/mouse input mode and compact/full layout mode from pointer
// capability and viewport width, re-evaluating live as either changes.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

export type InputMode = 'touch' | 'mouse';
export type LayoutMode = 'compact' | 'full';

export interface DeviceMode {
  inputMode: InputMode;
  layoutMode: LayoutMode;
}

// Matches the `@media (max-width: 900px)` breakpoint in style.css — keep the
// two in sync, or layout and JS-derived mode can disagree.
export const DEFAULT_COMPACT_BREAKPOINT_PX = 900;

export interface DeviceModeOptions {
  window?: Window;
  compactBreakpointPx?: number;
  onChange?: (mode: DeviceMode) => void;
}

export interface DeviceModeController {
  getMode: () => DeviceMode;
  dispose: () => void;
}

function deriveInputMode(win: Window, pointerQuery: MediaQueryList | undefined): InputMode {
  if (pointerQuery) {
    return pointerQuery.matches ? 'touch' : 'mouse';
  }
  // Last-resort fallback only: any browser with `matchMedia` at all returns a
  // (truthy) MediaQueryList even for an unrecognized feature, so this only
  // runs when `matchMedia` itself is missing entirely (a non-browser test
  // harness, or an environment far below this app's existing `dvh` floor).
  return (win.navigator?.maxTouchPoints ?? 0) > 0 ? 'touch' : 'mouse';
}

function deriveLayoutMode(
  win: Window,
  layoutQuery: MediaQueryList | undefined,
  breakpointPx: number
): LayoutMode {
  if (layoutQuery) {
    return layoutQuery.matches ? 'compact' : 'full';
  }
  return win.innerWidth <= breakpointPx ? 'compact' : 'full';
}

export function initDeviceMode(options: DeviceModeOptions = {}): DeviceModeController {
  const win = options.window ?? window;
  const breakpointPx = options.compactBreakpointPx ?? DEFAULT_COMPACT_BREAKPOINT_PX;

  const pointerQuery = win.matchMedia?.('(pointer: coarse)');
  const layoutQuery = win.matchMedia?.(`(max-width: ${breakpointPx}px)`);

  let mode: DeviceMode = {
    inputMode: deriveInputMode(win, pointerQuery),
    layoutMode: deriveLayoutMode(win, layoutQuery, breakpointPx)
  };

  const reevaluate = () => {
    const next: DeviceMode = {
      inputMode: deriveInputMode(win, pointerQuery),
      layoutMode: deriveLayoutMode(win, layoutQuery, breakpointPx)
    };
    if (next.inputMode === mode.inputMode && next.layoutMode === mode.layoutMode) {
      return;
    }
    mode = next;
    options.onChange?.(mode);
  };

  pointerQuery?.addEventListener('change', reevaluate);
  layoutQuery?.addEventListener('change', reevaluate);
  // Fallback path only: without matchMedia support, resize is the only signal
  // for a layout-mode change (there's no live signal for maxTouchPoints).
  if (!layoutQuery) {
    win.addEventListener('resize', reevaluate);
  }

  return {
    getMode: () => mode,
    dispose: () => {
      pointerQuery?.removeEventListener('change', reevaluate);
      layoutQuery?.removeEventListener('change', reevaluate);
      if (!layoutQuery) {
        win.removeEventListener('resize', reevaluate);
      }
    }
  };
}
