import { describe, it, expect } from 'vitest';
import { serialize, deserialize, copyState } from './persistence';
import {
  TileKind,
  createDefaultSettings,
  createInitialState
} from './gameState';
import { DEFAULT_BYLAWS } from './bylaws';
import { SeededRng } from './rng';
import { DEFAULT_SERVICE_DEFINITIONS } from './services';
import { createEmptyEducationStats } from './education';

// Serialize a fresh state, strip or mutate fields the way an old save would
// lack them, and hand the result to deserialize. Working on the parsed object
// keeps each test focused on the single field it degrades.
function degrade(mutate: (parsed: any) => void, seed = 42) {
  const parsed = JSON.parse(serialize(createInitialState(8, 8, seed)));
  mutate(parsed);
  return deserialize(JSON.stringify(parsed));
}

describe('serialize/deserialize round-trip', () => {
  it('copyState reproduces a fresh state exactly', () => {
    const state = createInitialState(8, 8, 42);
    expect(copyState(state)).toEqual(state);
  });

  it('deserialize is idempotent', () => {
    const once = copyState(createInitialState(8, 8, 42));
    expect(copyState(once)).toEqual(once);
  });
});

describe('settings back-fill', () => {
  it('applies full defaults when settings are absent', () => {
    const state = degrade((parsed) => {
      delete parsed.settings;
    });
    expect(state.settings).toEqual(createDefaultSettings());
  });

  it('back-fills a missing settings section without touching the others', () => {
    const state = degrade((parsed) => {
      delete parsed.settings.narrative;
      parsed.settings.audio.radioVolume = 0.25;
    });
    expect(state.settings.narrative).toEqual(createDefaultSettings().narrative);
    expect(state.settings.audio.radioVolume).toBe(0.25);
  });

  it('merges defaults into a partially-populated section', () => {
    const state = degrade((parsed) => {
      parsed.settings.input = { panSpeed: 'fast' };
    });
    expect(state.settings.input.panSpeed).toBe('fast');
    // Fields the old save never had arrive with their defaults.
    const defaults = createDefaultSettings().input;
    expect(state.settings.input.zoomSensitivity).toBe(defaults.zoomSensitivity);
    expect(state.settings.input.ctrlScrollsToPan).toBe(defaults.ctrlScrollsToPan);
  });

  it('back-fills each nested section independently', () => {
    const state = degrade((parsed) => {
      parsed.settings = {
        minimap: { open: false },
        accessibility: { reducedMotion: true },
        audio: {},
        hotkeys: {},
        cosmetics: {},
        narrative: { enabled: false }
      };
    });
    const defaults = createDefaultSettings();
    expect(state.settings.minimap.open).toBe(false);
    expect(state.settings.minimap.size).toBe(defaults.minimap.size);
    expect(state.settings.accessibility.reducedMotion).toBe(true);
    expect(state.settings.accessibility.highContrastOverlays).toBe(
      defaults.accessibility.highContrastOverlays
    );
    expect(state.settings.audio).toEqual(defaults.audio);
    expect(state.settings.hotkeys).toEqual(defaults.hotkeys);
    expect(state.settings.narrative.enabled).toBe(false);
    expect(state.settings.narrative.tickerEnabled).toBe(defaults.narrative.tickerEnabled);
    expect(state.settings.pendingPenaltyEnabled).toBe(defaults.pendingPenaltyEnabled);
  });

  it('defaults ui.mode to auto on a save that predates the setting', () => {
    const state = degrade((parsed) => {
      delete parsed.settings.ui;
    });
    expect(state.settings.ui).toEqual(createDefaultSettings().ui);
  });

  it('preserves an explicit ui.mode choice', () => {
    const state = degrade((parsed) => {
      parsed.settings.ui = { mode: 'mobile' };
    });
    expect(state.settings.ui.mode).toBe('mobile');
  });
});

describe('seed and RNG back-fill', () => {
  it('assigns seed 0 to saves that predate seeding', () => {
    const state = degrade((parsed) => {
      delete parsed.seed;
      delete parsed.rngState;
    });
    expect(state.seed).toBe(0);
    expect(state.rngState).toEqual(new SeededRng(0).toJSON());
  });

  it('re-derives an invalid rngState from the seed', () => {
    const state = degrade((parsed) => {
      parsed.rngState = [1, 2];
    });
    expect(state.rngState).toEqual(new SeededRng(state.seed).toJSON());
  });

  it('preserves a valid rngState untouched', () => {
    const original = createInitialState(8, 8, 42);
    const state = deserialize(serialize(original));
    expect(state.rngState).toEqual(original.rngState);
  });
});

describe('utilities back-fill', () => {
  it('builds utilities from legacy top-level power/water fields', () => {
    const state = degrade((parsed) => {
      delete parsed.utilities;
      parsed.power = 5;
      parsed.water = 3;
    });
    expect(state.utilities).toEqual({
      power: 5,
      water: 3,
      powerProduced: 0,
      powerUsed: 0,
      waterProduced: 0,
      waterUsed: 0
    });
  });

  it('back-fills produced/used on a partial utilities object', () => {
    const state = degrade((parsed) => {
      parsed.utilities = { power: 2, water: 1 };
    });
    expect(state.utilities.powerProduced).toBe(0);
    expect(state.utilities.waterUsed).toBe(0);
    expect(state.utilities.power).toBe(2);
  });
});

describe('scalar and structural back-fill', () => {
  it('defaults tick and tileRevision to 0', () => {
    const state = degrade((parsed) => {
      delete parsed.tick;
      delete parsed.tileRevision;
    });
    expect(state.tick).toBe(0);
    expect(state.tileRevision).toBe(0);
  });

  it('creates a default budget when absent', () => {
    const state = degrade((parsed) => {
      delete parsed.budget;
    });
    expect(state.budget.net).toBe(0);
    expect(state.budget.breakdown.revenue).toEqual({
      base: 0,
      residents: 0,
      commercial: 0,
      industrial: 0
    });
    expect(state.budget.breakdown.details.transport.rail).toBe(0);
  });

  it('migrates the legacy revenue.population field to residents', () => {
    const state = degrade((parsed) => {
      parsed.budget.breakdown.revenue = { base: 10, population: 7 };
    });
    expect(state.budget.breakdown.revenue.residents).toBe(7);
    expect(state.budget.breakdown.revenue.base).toBe(10);
  });

  it('back-fills the *ByType breakdown maps', () => {
    const state = degrade((parsed) => {
      parsed.budget.breakdown.details.buildings = { power: 1, civic: 2, zones: 3 };
    });
    expect(state.budget.breakdown.details.buildings.powerByType).toEqual({});
    expect(state.budget.breakdown.details.buildings.civicByType).toEqual({});
    expect(state.budget.breakdown.details.buildings.zonesByType).toEqual({});
    expect(state.budget.breakdown.details.buildings.zones).toBe(3);
  });

  it('defaults budgetHistory, education, and bylaws', () => {
    const state = degrade((parsed) => {
      delete parsed.budgetHistory;
      delete parsed.education;
      delete parsed.bylaws;
    });
    expect(state.budgetHistory).toEqual({ daily: [], lastRecordedDay: 0 });
    expect(state.education).toEqual(createEmptyEducationStats());
    expect(state.bylaws).toEqual(DEFAULT_BYLAWS);
  });

  it('back-fills a missing bylaws section without clobbering the rest', () => {
    const state = degrade((parsed) => {
      delete parsed.bylaws.lighting;
    });
    expect(state.bylaws.lighting).toEqual(DEFAULT_BYLAWS.lighting);
  });

  it('back-fills missing service definitions individually', () => {
    const firstId = Object.keys(
      DEFAULT_SERVICE_DEFINITIONS
    )[0] as keyof typeof DEFAULT_SERVICE_DEFINITIONS;
    const state = degrade((parsed) => {
      delete parsed.services.definitions[firstId];
    });
    expect(state.services.definitions[firstId]).toEqual(DEFAULT_SERVICE_DEFINITIONS[firstId]);
  });
});

describe('tile back-fill', () => {
  it('defaults powered/watered/services on old tiles', () => {
    const state = degrade((parsed) => {
      delete parsed.tiles[0].powered;
      delete parsed.tiles[0].watered;
      delete parsed.tiles[0].services;
    });
    expect(state.tiles[0].powered).toBe(false);
    expect(state.tiles[0].watered).toBe(false);
    expect(state.tiles[0].services).toBeDefined();
  });
});

describe('building back-fill and legacy civic migration', () => {
  it('repairs missing building state fields', () => {
    const state = degrade((parsed) => {
      parsed.tiles[0].kind = TileKind.Park;
      parsed.tiles[0].buildingId = 1;
      parsed.buildings = [
        { id: 1, templateId: 'park', origin: { x: 0, y: 0 }, state: { status: undefined } }
      ];
    });
    const building = state.buildings[0];
    expect(building.state.health).toBe(100);
    expect(building.state.status).toBeDefined();
    expect(building.state.serviceLoad).toBeDefined();
  });

  it('creates building instances for legacy civic tiles without buildingId', () => {
    const idx = 3 * 8 + 4; // (4, 3) on the 8x8 map
    const state = degrade((parsed) => {
      parsed.tiles[idx].kind = TileKind.Park;
      delete parsed.tiles[idx].buildingId;
      parsed.buildings = [];
      delete parsed.nextBuildingId;
    });
    const tile = state.tiles[idx];
    expect(tile.buildingId).toBeDefined();
    const created = state.buildings.find((b) => b.id === tile.buildingId);
    expect(created).toBeDefined();
    expect(created!.origin).toEqual({ x: 4, y: 3 });
    expect(state.nextBuildingId).toBeGreaterThan(tile.buildingId!);
  });
});
