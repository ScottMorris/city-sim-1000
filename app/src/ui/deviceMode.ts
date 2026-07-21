// Derives touch/mouse input mode and compact/full layout mode from pointer
// capability and viewport width/height, re-evaluating live as any change.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

export type InputMode = 'touch' | 'mouse';
export type LayoutMode = 'compact' | 'full';

export interface DeviceMode {
  inputMode: InputMode;
  layoutMode: LayoutMode;
}

// Matches the `@media (max-width: 900px), (max-height: 500px)` breakpoint in
// style.css — keep the two in sync, or layout and JS-derived mode can
// disagree. Width alone misses a phone in landscape: it's comfortably wider
// than 900px on most devices, but short enough that a full desktop shell
// (topbar + toolbar both sized for a tall viewport) leaves little to no
// canvas — so compact triggers on EITHER dimension being small, not just width.
export const DEFAULT_COMPACT_BREAKPOINT_PX = 900;
export const DEFAULT_COMPACT_HEIGHT_BREAKPOINT_PX = 500;

export interface DeviceModeOptions {
  window?: Window;
  compactBreakpointPx?: number;
  compactHeightBreakpointPx?: number;
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
  breakpointPx: number,
  heightBreakpointPx: number
): LayoutMode {
  if (layoutQuery) {
    return layoutQuery.matches ? 'compact' : 'full';
  }
  return win.innerWidth <= breakpointPx || win.innerHeight <= heightBreakpointPx ? 'compact' : 'full';
}

export function initDeviceMode(options: DeviceModeOptions = {}): DeviceModeController {
  const win = options.window ?? window;
  const breakpointPx = options.compactBreakpointPx ?? DEFAULT_COMPACT_BREAKPOINT_PX;
  const heightBreakpointPx = options.compactHeightBreakpointPx ?? DEFAULT_COMPACT_HEIGHT_BREAKPOINT_PX;

  const pointerQuery = win.matchMedia?.('(pointer: coarse)');
  // Comma = OR in a media query list, matching deriveLayoutMode's fallback.
  const layoutQuery = win.matchMedia?.(`(max-width: ${breakpointPx}px), (max-height: ${heightBreakpointPx}px)`);

  let mode: DeviceMode = {
    inputMode: deriveInputMode(win, pointerQuery),
    layoutMode: deriveLayoutMode(win, layoutQuery, breakpointPx, heightBreakpointPx)
  };

  const reevaluate = () => {
    const next: DeviceMode = {
      inputMode: deriveInputMode(win, pointerQuery),
      layoutMode: deriveLayoutMode(win, layoutQuery, breakpointPx, heightBreakpointPx)
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
