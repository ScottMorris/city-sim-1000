import { describe, it, expect } from 'vitest';
import { resolveStratumForTool } from './viewStratum';
import { Tool } from './toolTypes';

describe('resolveStratumForTool', () => {
  it('WaterPipe always forces underground', () => {
    expect(resolveStratumForTool(Tool.WaterPipe, 'surface')).toBe('underground');
    expect(resolveStratumForTool(Tool.WaterPipe, 'underground')).toBe('underground');
  });

  it('Bulldoze is stratum-neutral and follows whatever is already active', () => {
    expect(resolveStratumForTool(Tool.Bulldoze, 'surface')).toBe('surface');
    expect(resolveStratumForTool(Tool.Bulldoze, 'underground')).toBe('underground');
  });

  it('every other tool snaps the view back to surface', () => {
    for (const tool of [Tool.Inspect, Tool.Road, Tool.Park, Tool.TerraformRaise, Tool.PowerLine]) {
      expect(resolveStratumForTool(tool, 'surface')).toBe('surface');
      expect(resolveStratumForTool(tool, 'underground')).toBe('surface');
    }
  });
});
