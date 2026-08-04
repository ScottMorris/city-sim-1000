// mcpBridge.test.ts — unit coverage for mcpBridge.ts's pure helpers.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { stratumParam } from './mcpBridge';
import { Tool } from './toolTypes';

describe('stratumParam', () => {
  it('defaults to surface when the param is absent', () => {
    expect(stratumParam({})).toBe('surface');
  });

  it('reads an explicit "underground" override', () => {
    expect(stratumParam({ stratum: 'underground' })).toBe('underground');
  });

  it('falls back to surface for an explicit "surface" or any unrecognised value', () => {
    expect(stratumParam({ stratum: 'surface' })).toBe('surface');
    expect(stratumParam({ stratum: 'sideways' })).toBe('surface');
    expect(stratumParam({ stratum: 42 })).toBe('surface');
  });

  it('defaults water_pipe to underground, since the engine refuses it anywhere else', () => {
    expect(stratumParam({ tool: Tool.WaterPipe })).toBe('underground');
  });

  it('still honours an explicit "surface" override on water_pipe (the engine will refuse it)', () => {
    expect(stratumParam({ tool: Tool.WaterPipe, stratum: 'surface' })).toBe('surface');
  });
});
