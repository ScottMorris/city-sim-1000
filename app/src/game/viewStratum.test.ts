// viewStratum.test.ts — unit coverage for tool-implied ViewStratum switching.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { requiredStratumForTool, resolveStratumForTool } from './viewStratum';
import { Tool } from './toolTypes';

describe('resolveStratumForTool', () => {
  it('WaterPipe always forces underground', () => {
    expect(resolveStratumForTool(Tool.WaterPipe, 'surface')).toBe('underground');
    expect(resolveStratumForTool(Tool.WaterPipe, 'underground')).toBe('underground');
  });

  it('an "Any" tool is stratum-neutral and follows whatever is already active', () => {
    // Bulldoze clears whichever stratum the view is on rather than being
    // gated by a requirement (`commands::bulldoze`'s layer-scoped
    // semantics); the terrain brushes place no occupant to derive a
    // requirement from — both land on `required_stratum(tool) == None`.
    for (const tool of [Tool.Bulldoze, Tool.Inspect, Tool.TerraformRaise, Tool.TerraformLower, Tool.Water]) {
      expect(resolveStratumForTool(tool, 'surface')).toBe('surface');
      expect(resolveStratumForTool(tool, 'underground')).toBe('underground');
    }
  });

  it('every surface-occupant tool snaps the view back to surface', () => {
    for (const tool of [Tool.Road, Tool.Park, Tool.PowerLine]) {
      expect(resolveStratumForTool(tool, 'surface')).toBe('surface');
      expect(resolveStratumForTool(tool, 'underground')).toBe('surface');
    }
  });
});

describe('requiredStratumForTool', () => {
  it('WaterPipe requires underground', () => {
    expect(requiredStratumForTool(Tool.WaterPipe)).toBe('underground');
  });

  it('Inspect, the terrain brushes, and Bulldoze are "Any" — no requirement to violate', () => {
    for (const tool of [Tool.Inspect, Tool.TerraformRaise, Tool.TerraformLower, Tool.Water, Tool.Bulldoze]) {
      expect(requiredStratumForTool(tool)).toBeNull();
    }
  });

  it('every occupant-placing surface tool requires surface', () => {
    for (const tool of [Tool.Road, Tool.Park, Tool.PowerLine, Tool.Residential]) {
      expect(requiredStratumForTool(tool)).toBe('surface');
    }
  });
});
