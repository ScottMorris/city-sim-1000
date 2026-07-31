// viewStratum.ts — tool-implied ViewStratum switching, pulled out of main.ts's setTool so it's unit-testable.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { Tool } from './toolTypes';
import type { ViewStratum } from './gameState';

/**
 * What stratum selecting `tool` should leave the view on. Tools with a home
 * stratum (`WaterPipe`) force it; `Bulldoze` is stratum-neutral and follows
 * whatever is already active (that's what makes it layer-scoped); every
 * other tool is a surface tool and snaps the view back. See
 * `docs/features/view-layers.md`'s "Entry points for the underground
 * stratum".
 */
export function resolveStratumForTool(tool: Tool, currentStratum: ViewStratum): ViewStratum {
  if (tool === Tool.WaterPipe) return 'underground';
  if (tool === Tool.Bulldoze) return currentStratum;
  return 'surface';
}

/**
 * Which stratum must be active for a click with `tool` armed to be honoured
 * — `null` for tools that place nothing on a fixed layer (`Inspect`,
 * `Bulldoze`, both stratum-neutral). Selecting a tool always leaves the view
 * matching its requirement (`resolveStratumForTool`), so this only matters
 * when the player manually toggles the view away afterwards without
 * reselecting the tool — the click-guard in `main.ts`'s `applyCurrentTool`
 * refuses the click instead of silently applying it to the wrong layer.
 */
export function requiredStratumForTool(tool: Tool): ViewStratum | null {
  if (tool === Tool.WaterPipe) return 'underground';
  if (tool === Tool.Bulldoze || tool === Tool.Inspect) return null;
  return 'surface';
}
