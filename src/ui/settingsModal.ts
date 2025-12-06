import { GameSettings, MinimapSize, PanSpeedPreset, ZoomSensitivityPreset } from '../game/gameState';
import { defaultHotkeys, HotkeyAction } from './hotkeys';

interface SettingsModalOptions {
  getSettings: () => GameSettings;
  onApply: (settings: GameSettings) => void;
}

const PAN_SPEED_LABELS: Record<PanSpeedPreset, string> = {
  slow: 'Slow',
  normal: 'Normal',
  fast: 'Fast'
};

const ZOOM_SPEED_LABELS: Record<ZoomSensitivityPreset, string> = {
  gentle: 'Gentle',
  normal: 'Normal',
  fast: 'Fast'
};

const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  moveUp: 'Move up',
  moveDown: 'Move down',
  moveLeft: 'Move left',
  moveRight: 'Move right',
  selectInspect: 'Inspect tool',
  selectTerraformRaise: 'Raise terrain',
  selectTerraformLower: 'Lower terrain',
  selectWater: 'Paint water',
  selectTrees: 'Plant trees',
  selectRoad: 'Road tool',
  selectRail: 'Rail tool',
  selectPower: 'Power lines',
  selectHydro: 'Hydro plant',
  selectWaterPump: 'Water pump',
  selectWaterTower: 'Water tower',
  selectResidential: 'Residential zone',
  selectCommercial: 'Commercial zone',
  selectIndustrial: 'Industrial zone',
  selectPark: 'Park',
  selectBulldoze: 'Bulldoze',
  speedSlow: 'Speed: Slow',
  speedFast: 'Speed: Fast',
  speedLudicrous: 'Speed: Ludicrous',
  toggleMinimap: 'Toggle minimap'
};

function createSection(title: string, hint?: string) {
  const section = document.createElement('div');
  section.className = 'settings-section';
  const header = document.createElement('div');
  header.className = 'settings-section-header';
  const heading = document.createElement('div');
  heading.className = 'settings-section-title';
  heading.textContent = title;
  header.appendChild(heading);
  if (hint) {
    const subtitle = document.createElement('div');
    subtitle.className = 'settings-section-hint';
    subtitle.textContent = hint;
    header.appendChild(subtitle);
  }
  section.appendChild(header);
  return section;
}

function createToggleRow(options: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const row = document.createElement('label');
  row.className = 'settings-row';
  const text = document.createElement('div');
  text.className = 'settings-label';
  text.textContent = options.label;
  const desc = document.createElement('div');
  desc.className = 'settings-description';
  desc.textContent = options.description ?? '';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = options.checked;
  checkbox.disabled = Boolean(options.disabled);
  checkbox.addEventListener('change', () => options.onChange(checkbox.checked));
  row.append(text, desc, checkbox);
  return row;
}

export function initSettingsModal(options: SettingsModalOptions) {
  const { getSettings, onApply } = options;
  let backdrop: HTMLDivElement | null = null;
  let escHandler: ((e: KeyboardEvent) => void) | null = null;
  const cleanup = () => {
    if (backdrop) {
      backdrop.remove();
      backdrop = null;
    }
    if (escHandler) {
      window.removeEventListener('keydown', escHandler);
      escHandler = null;
    }
  };

  const open = () => {
    if (backdrop) return;
    const draft: GameSettings = JSON.parse(JSON.stringify(getSettings()));

    backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'modal settings-modal';

    const header = document.createElement('div');
    header.className = 'settings-header';
    const title = document.createElement('div');
    title.className = 'settings-title';
    title.textContent = 'Settings';
    const subtitle = document.createElement('div');
    subtitle.className = 'settings-subtitle';
    subtitle.textContent = 'Toggles for HUD, input, audio, and accessibility.';
    header.append(title, subtitle);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.className = 'secondary modal-close';

    const headerActions = document.createElement('div');
    headerActions.className = 'settings-actions';
    headerActions.append(closeBtn);

    const headerRow = document.createElement('div');
    headerRow.className = 'settings-header-row';
    headerRow.append(header, headerActions);

    const body = document.createElement('div');
    body.className = 'settings-body';

    const general = createSection('Gameplay', 'Toggles that affect growth feedback.');
    const penaltiesRow = createToggleRow({
      label: 'Over-zoning penalties',
      description: 'Keep the soft pending-zone demand penalty on. Also available in Debug.',
      checked: draft.pendingPenaltyEnabled,
      onChange: (checked) => {
        draft.pendingPenaltyEnabled = checked;
        onApply(draft);
      }
    });
    general.append(penaltiesRow);

    const minimap = createSection('Minimap', 'A quick copy of the panel controls.');
    const minimapToggle = createToggleRow({
      label: 'Show minimap',
      description: 'Mirror of the Hide/Show toggle in the HUD.',
      checked: draft.minimap.open,
      onChange: (checked) => {
        draft.minimap.open = checked;
        onApply(draft);
      }
    });
    const minimapSizeRow = document.createElement('div');
    minimapSizeRow.className = 'settings-row';
    const minimapLabel = document.createElement('div');
    minimapLabel.className = 'settings-label';
    minimapLabel.textContent = 'Minimap size';
    const minimapDesc = document.createElement('div');
    minimapDesc.className = 'settings-description';
    minimapDesc.textContent = 'Small or medium footprint.';
    const minimapSelect = document.createElement('select');
    (['small', 'medium'] as MinimapSize[]).forEach((size) => {
      const opt = document.createElement('option');
      opt.value = size;
      opt.textContent = size === 'small' ? 'Small' : 'Medium';
      opt.selected = draft.minimap.size === size;
      minimapSelect.appendChild(opt);
    });
    minimapSelect.addEventListener('change', () => {
      draft.minimap.size = minimapSelect.value as MinimapSize;
      onApply(draft);
    });
    minimapSizeRow.append(minimapLabel, minimapDesc, minimapSelect);
    minimap.append(minimapToggle, minimapSizeRow);

    const input = createSection('Input', 'Pan, zoom, and scroll options.');
    const invertPanRow = createToggleRow({
      label: 'Invert keyboard pan',
      description: 'Flip WASD/arrow panning direction.',
      checked: draft.input.invertPan,
      onChange: (checked) => {
        draft.input.invertPan = checked;
        onApply(draft);
      }
    });
    const panSpeedRow = document.createElement('div');
    panSpeedRow.className = 'settings-row';
    const panSpeedLabel = document.createElement('div');
    panSpeedLabel.className = 'settings-label';
    panSpeedLabel.textContent = 'Pan speed';
    const panSpeedDesc = document.createElement('div');
    panSpeedDesc.className = 'settings-description';
    panSpeedDesc.textContent = 'Preset speed for keyboard pan.';
    const panSpeedSelect = document.createElement('select');
    (['slow', 'normal', 'fast'] as PanSpeedPreset[]).forEach((key) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = PAN_SPEED_LABELS[key];
      opt.selected = draft.input.panSpeed === key;
      panSpeedSelect.appendChild(opt);
    });
    panSpeedSelect.addEventListener('change', () => {
      draft.input.panSpeed = panSpeedSelect.value as PanSpeedPreset;
      onApply(draft);
    });
    panSpeedRow.append(panSpeedLabel, panSpeedDesc, panSpeedSelect);

    const shiftScrollRow = createToggleRow({
      label: 'Shift + scroll pans',
      description: 'Hold Shift to pan vertically instead of zooming; Ctrl + scroll pans left/right.',
      checked: draft.input.shiftScrollsToPan,
      onChange: (checked) => {
        draft.input.shiftScrollsToPan = checked;
        onApply(draft);
      }
    });

    const ctrlScrollRow = createToggleRow({
      label: 'Ctrl + scroll pans',
      description: 'Hold Ctrl to pan horizontally instead of zooming.',
      checked: draft.input.ctrlScrollsToPan,
      onChange: (checked) => {
        draft.input.ctrlScrollsToPan = checked;
        onApply(draft);
      }
    });

    const zoomRow = document.createElement('div');
    zoomRow.className = 'settings-row';
    const zoomLabel = document.createElement('div');
    zoomLabel.className = 'settings-label';
    zoomLabel.textContent = 'Zoom sensitivity';
    const zoomDesc = document.createElement('div');
    zoomDesc.className = 'settings-description';
    zoomDesc.textContent = 'How much each scroll step zooms in or out.';
    const zoomSelect = document.createElement('select');
    (['gentle', 'normal', 'fast'] as ZoomSensitivityPreset[]).forEach((key) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = ZOOM_SPEED_LABELS[key];
      opt.selected = draft.input.zoomSensitivity === key;
      zoomSelect.appendChild(opt);
    });
    zoomSelect.addEventListener('change', () => {
      draft.input.zoomSensitivity = zoomSelect.value as ZoomSensitivityPreset;
      onApply(draft);
    });
    zoomRow.append(zoomLabel, zoomDesc, zoomSelect);

    const edgeScrollRow = createToggleRow({
      label: 'Edge scroll (stub)',
      description: 'Reserved for mouse-at-edge panning. Does nothing yet.',
      checked: draft.input.edgeScrollEnabled,
      onChange: (checked) => {
        draft.input.edgeScrollEnabled = checked;
        onApply(draft);
      }
    });
    input.append(invertPanRow, panSpeedRow, shiftScrollRow, ctrlScrollRow, zoomRow, edgeScrollRow);

    const audio = createSection('Audio', 'Radio volume and future effects.');
    const radioRow = document.createElement('div');
    radioRow.className = 'settings-row';
    const radioLabel = document.createElement('div');
    radioLabel.className = 'settings-label';
    radioLabel.textContent = 'Radio volume';
    const radioDesc = document.createElement('div');
    radioDesc.className = 'settings-description';
    radioDesc.textContent = 'Adjust music volume (if a playlist is present).';
    const radioSlider = document.createElement('input');
    radioSlider.type = 'range';
    radioSlider.min = '0';
    radioSlider.max = '100';
    radioSlider.value = Math.round((draft.audio.radioVolume ?? 1) * 100).toString();
    radioSlider.addEventListener('input', () => {
      const next = Math.max(0, Math.min(100, Number(radioSlider.value)));
      draft.audio.radioVolume = next / 100;
      onApply(draft);
    });
    radioRow.append(radioLabel, radioDesc, radioSlider);

    const sfxRow = document.createElement('div');
    sfxRow.className = 'settings-row';
    const sfxLabel = document.createElement('div');
    sfxLabel.className = 'settings-label';
    sfxLabel.textContent = 'Sound effects (stub)';
    const sfxDesc = document.createElement('div');
    sfxDesc.className = 'settings-description';
    sfxDesc.textContent = 'Placeholder control for future effects.';
    const sfxSlider = document.createElement('input');
    sfxSlider.type = 'range';
    sfxSlider.min = '0';
    sfxSlider.max = '100';
    sfxSlider.value = Math.round((draft.audio.sfxVolume ?? 1) * 100).toString();
    sfxSlider.disabled = true;
    sfxRow.append(sfxLabel, sfxDesc, sfxSlider);
    audio.append(radioRow, sfxRow);

    const accessibility = createSection('Accessibility', 'Make the HUD easier to parse.');
    const reducedMotionRow = createToggleRow({
      label: 'Reduced motion',
      description: 'Dial back motion once transitions are hooked up.',
      checked: draft.accessibility.reducedMotion,
      onChange: (checked) => {
        draft.accessibility.reducedMotion = checked;
        onApply(draft);
      }
    });
    const contrastRow = createToggleRow({
      label: 'Higher-contrast overlays/tooltips',
      description: 'Placeholder for brighter overlays.',
      checked: draft.accessibility.highContrastOverlays,
      onChange: (checked) => {
        draft.accessibility.highContrastOverlays = checked;
        onApply(draft);
      }
    });
    accessibility.append(reducedMotionRow, contrastRow);

    const cosmetics = createSection('Cosmetics', 'Visual toggles for sprites.');
    const geminiRow = createToggleRow({
      label: 'Gemini building sprites',
      description: 'On by default; placeholder toggle with no effect yet.',
      checked: draft.cosmetics.geminiBuildingsEnabled,
      disabled: true,
      onChange: () => {
        draft.cosmetics.geminiBuildingsEnabled = true;
        onApply(draft);
      }
    });
    cosmetics.append(geminiRow);

    const hotkeys = createSection('Hotkeys', 'Remap controls; warns on conflicts.');
    const hotkeyTable = document.createElement('div');
    hotkeyTable.className = 'hotkey-table';
    const hotkeyHint = document.createElement('div');
    hotkeyHint.className = 'settings-description';
    hotkeyHint.textContent = 'Click a field and press a key to set a single binding; edit text for multiple with commas.';
    const conflictLabel = document.createElement('div');
    conflictLabel.className = 'settings-warning';
    conflictLabel.textContent = '';

    const resetHotkeys = document.createElement('button');
    resetHotkeys.className = 'secondary';
    resetHotkeys.textContent = 'Reset hotkeys';
    resetHotkeys.addEventListener('click', () => {
      draft.hotkeys = { ...defaultHotkeys };
      renderHotkeyRows();
      onApply(draft);
    });

    const hotkeyHeaderRow = document.createElement('div');
    hotkeyHeaderRow.className = 'hotkey-row hotkey-row-header';
    const hkActionHeader = document.createElement('div');
    hkActionHeader.textContent = 'Action';
    const hkBindingHeader = document.createElement('div');
    hkBindingHeader.textContent = 'Keys';
    hotkeyHeaderRow.append(hkActionHeader, hkBindingHeader);

    const renderConflicts = () => {
      const seen = new Map<string, string[]>();
      Object.entries(draft.hotkeys ?? {}).forEach(([action, keys]) => {
        keys?.forEach((key) => {
          const list = seen.get(key) ?? [];
          list.push(action);
          seen.set(key, list);
        });
      });
      const conflicts = Array.from(seen.entries()).filter(([, actions]) => actions.length > 1);
      if (conflicts.length === 0) {
        conflictLabel.textContent = 'No conflicts detected.';
        conflictLabel.classList.remove('error');
      } else {
        const parts = conflicts.map(([key, actions]) => `${key} → ${actions.join(', ')}`);
        conflictLabel.textContent = `Conflicts: ${parts.join(' • ')}`;
        conflictLabel.classList.add('error');
      }
    };

    const renderHotkeyRows = () => {
      hotkeyTable.innerHTML = '';
      hotkeyTable.append(hotkeyHeaderRow);
      (Object.keys(defaultHotkeys) as HotkeyAction[]).forEach((action) => {
        const row = document.createElement('div');
        row.className = 'hotkey-row';
        const actionLabel = document.createElement('div');
        actionLabel.textContent = HOTKEY_LABELS[action] ?? action;
        const bindingInput = document.createElement('input');
        bindingInput.type = 'text';
        bindingInput.value = (draft.hotkeys[action] ?? defaultHotkeys[action] ?? []).join(', ');
        bindingInput.placeholder = 'Press a key or type codes';
        bindingInput.addEventListener('keydown', (e) => {
          e.preventDefault();
          const code = e.code;
          draft.hotkeys[action] = [code];
          bindingInput.value = code;
          onApply(draft);
          renderConflicts();
        });
        bindingInput.addEventListener('change', () => {
          const parts = bindingInput.value
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean);
          draft.hotkeys[action] = parts.length > 0 ? parts : [];
          onApply(draft);
          renderConflicts();
        });
        row.append(actionLabel, bindingInput);
        hotkeyTable.append(row);
      });
      renderConflicts();
    };

    renderHotkeyRows();

    hotkeys.append(hotkeyHint, resetHotkeys, hotkeyTable, conflictLabel);

    body.append(audio, general, minimap, input, accessibility, cosmetics, hotkeys);
    modal.append(headerRow, body);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cleanup();
    };

    closeBtn.addEventListener('click', cleanup);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) cleanup();
    });
    window.addEventListener('keydown', escHandler);
  };

  return { open, close: cleanup };
}
