import { describe, it, expect } from 'vitest';
import { BUILD_COST } from './constants';
import { createInitialState, getTile, setTile, TileKind } from './gameState';
import { applyTool, Tool } from './tools';
import { tick } from './simulation';

describe('tools', () => {
  it('blocks tool usage when funds are insufficient', () => {
    const state = createInitialState(4, 4);
    state.money = 0;
    const result = applyTool(state, Tool.Tree, 1, 1);
    expect(result.success).toBe(false);
    expect(result.message).toBe('Not enough funds');
  });

  it('applies a tool, updates tile, and deducts cost', () => {
    const state = createInitialState(4, 4);
    state.money = 100;
    const before = state.money;
    const result = applyTool(state, Tool.Road, 0, 0);
    expect(result.success).toBe(true);
    expect(getTile(state, 0, 0)?.kind).toBe(TileKind.Road);
    expect(state.money).toBe(before - BUILD_COST[Tool.Road]);
  });

  it('supports terraform raise/lower tools', () => {
    const state = createInitialState(4, 4);
    state.money = 100;
    setTile(state, 1, 1, TileKind.Water);
    applyTool(state, Tool.TerraformRaise, 1, 1);
    expect(getTile(state, 1, 1)?.kind).toBe(TileKind.Land);
    applyTool(state, Tool.TerraformLower, 1, 1);
    expect(getTile(state, 1, 1)?.kind).toBe(TileKind.Water);
  });
});

describe('simulation', () => {
  it('updates utility balances based on generators and pumps', () => {
    const state = createInitialState(4, 4);
    state.money = 0;
    setTile(state, 0, 0, TileKind.HydroPlant);
    setTile(state, 1, 0, TileKind.WaterPump);
    tick(state, 1);
    expect(state.utilities.power).toBeGreaterThan(0);
    expect(state.utilities.water).toBeGreaterThan(0);
  });
});
