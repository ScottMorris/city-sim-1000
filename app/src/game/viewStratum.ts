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
