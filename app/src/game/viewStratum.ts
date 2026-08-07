// viewStratum.ts — tool-implied ViewStratum switching, pulled out of main.ts's setTool so it's unit-testable.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
//
// `requiredStratumForTool` is a mirror, not a second opinion: the engine
// derives each tool's required stratum from the occupant it places
// (`city_sim_core::commands::required_stratum`, Option B of the
// engine-owned-stratum-rule design note) and `wireParity.json`'s
// `toolRequiredStrata` table pins this file against that derivation
// (`wireParity.test.ts`) — there is no hand-picked-per-tool logic left here
// to drift.

import { Tool } from './toolTypes';
import type { ViewStratum } from './gameState';
import wireParityFixture from './protocol/wireParity.json';

interface ToolRequiredStratumEntry {
  name: string;
  requiredStratum: 'Surface' | 'Underground' | null;
}

const TOOL_REQUIRED_STRATA = (
  wireParityFixture as { toolRequiredStrata: ToolRequiredStratumEntry[] }
).toolRequiredStrata;

/** `Tool` → its required `ViewStratum`, `null` for "Any" — built once from
 *  `wireParity.json` rather than hand-matched per `Tool` member. */
const REQUIRED_STRATUM_BY_TOOL: Partial<Record<Tool, ViewStratum | null>> = {};
for (const entry of TOOL_REQUIRED_STRATA) {
  const tool = Tool[entry.name as keyof typeof Tool];
  REQUIRED_STRATUM_BY_TOOL[tool] = entry.requiredStratum === null ? null : (entry.requiredStratum.toLowerCase() as ViewStratum);
}

/**
 * Which stratum must be active for a click with `tool` armed to be honoured
 * — `null` for a tool with no stratum of its own to require ("Any": places
 * nothing, or clears rather than places — `Inspect`, the terrain brushes,
 * `Bulldoze`, which stays layer-*scoped* rather than gated, see
 * `commands::bulldoze`; also `null` for a `tool` value the fixture has no
 * entry for, e.g. `mcpBridge.ts`'s `stratumParam` calling this with `params.
 * tool` left unset by the script — treated as "no requirement", same as a
 * real Any tool). Selecting a tool always leaves the view matching its
 * requirement (`resolveStratumForTool`), so this only matters when the
 * player manually toggles the view away afterwards without reselecting the
 * tool — the click-guard in `main.ts`'s `applyCurrentTool` refuses the click
 * instead of silently applying it to the wrong layer. `wireParity.test.ts`
 * pins `REQUIRED_STRATUM_BY_TOOL` covering every real `Tool` member, so this
 * only ever falls back to `null` for a value that isn't one.
 */
export function requiredStratumForTool(tool: Tool): ViewStratum | null {
  return REQUIRED_STRATUM_BY_TOOL[tool] ?? null;
}

/**
 * What stratum selecting `tool` should leave the view on. A tool with a
 * required stratum (`requiredStratumForTool`) switches the view to it — the
 * general form of what used to be `WaterPipe`'s special case; an "Any" tool
 * (`null` requirement, e.g. `Bulldoze` or a terrain brush) is stratum-neutral
 * and follows whatever is already active. See `docs/features/view-layers.md`'s
 * "Entry points for the underground stratum".
 */
export function resolveStratumForTool(tool: Tool, currentStratum: ViewStratum): ViewStratum {
  return requiredStratumForTool(tool) ?? currentStratum;
}
