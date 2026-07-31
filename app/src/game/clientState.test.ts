import { describe, expect, it } from 'vitest';
import { ensureSettingsShape } from './clientState';
import { createDefaultMinimapSettings, MINIMAP_OVERLAYS } from './gameState';

describe('ensureSettingsShape — minimap overlay sanitiser', () => {
  it('defaults to base when settings are absent', () => {
    expect(ensureSettingsShape().minimap).toEqual(createDefaultMinimapSettings());
  });

  it('accepts every valid overlay, including wilderness', () => {
    for (const overlay of MINIMAP_OVERLAYS) {
      expect(ensureSettingsShape({ minimap: { open: true, size: 'medium', overlay } }).minimap.overlay).toBe(
        overlay
      );
    }
  });

  it('falls back to base for an overlay value outside the allow-list', () => {
    const settings = ensureSettingsShape({
      minimap: { open: true, size: 'medium', overlay: 'not-a-real-overlay' as never }
    });
    expect(settings.minimap.overlay).toBe('base');
  });

  it('drops an old mode: underground save field instead of migrating it', () => {
    const settings = ensureSettingsShape({
      minimap: { open: true, size: 'medium', mode: 'underground' } as never
    });
    expect(settings.minimap.overlay).toBe('base');
    expect(settings.minimap).not.toHaveProperty('mode');
  });

  it('preserves open/size while defaulting a missing overlay', () => {
    const settings = ensureSettingsShape({ minimap: { open: false, size: 'small' } as never });
    expect(settings.minimap).toEqual({ open: false, size: 'small', overlay: 'base' });
  });
});
