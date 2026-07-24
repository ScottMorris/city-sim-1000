// The in-game sound effects editor: per-layer voice parameters, preview, save/reset
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { SoundType, VoiceParams } from '@liminal-hq/undertone';
import {
  SFX_EFFECT_IDS,
  SFX_EFFECT_LABELS,
  resetEffect,
  resolveVoiceParams,
  type SfxEffectId,
  type SfxOverrides
} from '../game/sfxOverrides';
import { DEFAULT_SFX_VOICES } from './sfxDefinitions';
import { paramsToCode, codeToParams } from './sfxCode';
import type { SfxController } from './sfx';

const SOUND_TYPES: SoundType[] = ['sine', 'triangle', 'square', 'sawtooth', 'white', 'pink', 'brown'];
const NOISE_TYPES = new Set<SoundType>(['white', 'pink', 'brown']);

interface FieldConfig {
  key: keyof VoiceParams;
  label: string;
  min: number;
  max: number;
  step: number;
}

// lpf uses 0 as a "no filter" sentinel — filterCutoff is undefined below that, matching
// how Undertone itself treats an absent filterCutoff as "skip creating a filter at all".
const FIELDS: FieldConfig[] = [
  { key: 'attack', label: 'Attack (s)', min: 0, max: 1, step: 0.001 },
  { key: 'decay', label: 'Decay (s)', min: 0, max: 1, step: 0.001 },
  { key: 'sustain', label: 'Sustain (0-1)', min: 0, max: 1, step: 0.01 },
  { key: 'release', label: 'Release (s)', min: 0, max: 1, step: 0.001 },
  { key: 'gainLevel', label: 'Gain (0-1)', min: 0, max: 1, step: 0.01 },
  { key: 'filterCutoff', label: 'Filter cutoff (Hz, 0 = off)', min: 0, max: 8000, step: 10 },
  { key: 'filterEnvAmount', label: 'Filter env amount (Hz)', min: 0, max: 8000, step: 10 },
  { key: 'filterAttack', label: 'Filter attack (s)', min: 0, max: 1, step: 0.001 },
  { key: 'filterDecay', label: 'Filter decay (s)', min: 0, max: 1, step: 0.001 },
  { key: 'filterSustain', label: 'Filter sustain (0-1)', min: 0, max: 1, step: 0.01 },
  { key: 'filterRelease', label: 'Filter release (s)', min: 0, max: 1, step: 0.001 },
  { key: 'slideTime', label: 'Slide (s)', min: 0, max: 1, step: 0.001 },
  { key: 'nudgeTime', label: 'Nudge (s)', min: 0, max: 1, step: 0.001 }
];

function fieldValue(params: VoiceParams, key: keyof VoiceParams): number {
  const value = params[key];
  return typeof value === 'number' ? value : 0;
}

function setFieldValue(params: VoiceParams, key: keyof VoiceParams, value: number): void {
  if (key === 'filterCutoff') {
    params.filterCutoff = value > 0 ? value : undefined;
    return;
  }
  (params as unknown as Record<string, number>)[key] = value;
}

export interface SfxEditorOptions {
  sfx: SfxController;
  getCityOverrides: () => SfxOverrides;
  getGlobalOverrides: () => SfxOverrides;
  onSaveCity: (next: SfxOverrides) => void;
  onSaveGlobal: (next: SfxOverrides) => void;
}

export function initSfxEditorModal(options: SfxEditorOptions) {
  const { sfx, getCityOverrides, getGlobalOverrides, onSaveCity, onSaveGlobal } = options;
  let backdrop: HTMLDivElement | null = null;
  let escHandler: ((event: KeyboardEvent) => void) | null = null;
  let body: HTMLDivElement | null = null;

  const cleanup = () => {
    if (escHandler) {
      window.removeEventListener('keydown', escHandler);
      escHandler = null;
    }
    if (backdrop) {
      backdrop.remove();
      backdrop = null;
    }
    body = null;
  };

  function resolveCurrent(id: SfxEffectId): VoiceParams[] {
    return resolveVoiceParams(id, DEFAULT_SFX_VOICES, getCityOverrides(), getGlobalOverrides());
  }

  function renderListView(): void {
    if (!body) return;
    body.innerHTML = '';

    for (const id of SFX_EFFECT_IDS) {
      const row = document.createElement('div');
      row.className = 'sfx-editor-row';

      const label = document.createElement('div');
      label.className = 'sfx-editor-row-label';
      label.textContent = SFX_EFFECT_LABELS[id];

      const previewBtn = document.createElement('button');
      previewBtn.type = 'button';
      previewBtn.className = 'secondary';
      previewBtn.textContent = '▶ Preview';
      previewBtn.addEventListener('click', () => sfx.preview(id));

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'secondary';
      editBtn.textContent = '✏️ Edit';
      editBtn.addEventListener('click', () => renderEditView(id));

      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'secondary';
      resetBtn.textContent = '↺ Reset';
      resetBtn.addEventListener('click', () => {
        onSaveCity(resetEffect(getCityOverrides(), id));
        onSaveGlobal(resetEffect(getGlobalOverrides(), id));
        renderListView();
      });

      row.append(label, previewBtn, editBtn, resetBtn);
      body.appendChild(row);
    }

    const resetAllBtn = document.createElement('button');
    resetAllBtn.type = 'button';
    resetAllBtn.className = 'secondary sfx-editor-reset-all';
    resetAllBtn.textContent = '↺↺ Reset All';
    resetAllBtn.addEventListener('click', () => {
      onSaveCity({});
      onSaveGlobal({});
      renderListView();
    });
    body.appendChild(resetAllBtn);
  }

  function renderEditView(id: SfxEffectId): void {
    if (!body) return;
    const bodyEl = body;
    bodyEl.innerHTML = '';

    // Deep clone so edits don't mutate the live saved/default params until Save is pressed.
    const draft: VoiceParams[] = resolveCurrent(id).map((params) => ({ ...params }));
    let mode: 'sliders' | 'code' = 'sliders';
    let codeTextarea: HTMLTextAreaElement | null = null;

    const heading = document.createElement('div');
    heading.className = 'sfx-editor-edit-title';
    heading.textContent = `Editing: ${SFX_EFFECT_LABELS[id]}`;
    bodyEl.appendChild(heading);

    const modeToggle = document.createElement('div');
    modeToggle.className = 'sfx-editor-mode-toggle';
    const slidersBtn = document.createElement('button');
    slidersBtn.type = 'button';
    slidersBtn.className = 'secondary';
    slidersBtn.textContent = '🎚️ Sliders';
    const codeBtn = document.createElement('button');
    codeBtn.type = 'button';
    codeBtn.className = 'secondary';
    codeBtn.textContent = '🧑‍💻 Code';
    modeToggle.append(slidersBtn, codeBtn);
    bodyEl.appendChild(modeToggle);

    const errorEl = document.createElement('div');
    errorEl.className = 'sfx-editor-code-error';
    errorEl.hidden = true;

    const contentEl = document.createElement('div');
    contentEl.className = 'sfx-editor-edit-content';
    bodyEl.appendChild(contentEl);
    bodyEl.appendChild(errorEl);

    // Reads the textarea back into `draft` when leaving code view for any reason (switching to
    // sliders, Preview, Save). Returns false (and shows the error inline) without touching draft
    // if the code doesn't compile, so a mistake never silently discards the player's edits.
    function applyCodeIfPresent(): boolean {
      if (mode !== 'code' || !codeTextarea) return true;
      try {
        const parsed = codeToParams(codeTextarea.value);
        draft.length = 0;
        draft.push(...parsed);
        errorEl.hidden = true;
        return true;
      } catch (err) {
        errorEl.textContent = err instanceof Error ? err.message : String(err);
        errorEl.hidden = false;
        return false;
      }
    }

    function renderSliders(): void {
      draft.forEach((params, layerIndex) => {
        const section = document.createElement('fieldset');
        section.className = 'sfx-editor-layer';
        const legend = document.createElement('legend');
        legend.textContent = `Layer ${layerIndex + 1}`;
        section.appendChild(legend);

        const soundRow = document.createElement('label');
        soundRow.className = 'sfx-editor-row';
        const soundLabel = document.createElement('span');
        soundLabel.textContent = 'Sound';
        const soundSelect = document.createElement('select');
        for (const type of SOUND_TYPES) {
          const option = document.createElement('option');
          option.value = type;
          option.textContent = NOISE_TYPES.has(type) ? `${type} noise` : type;
          option.selected = type === params.soundType;
          soundSelect.appendChild(option);
        }
        soundSelect.addEventListener('change', () => {
          params.soundType = soundSelect.value as SoundType;
        });
        soundRow.append(soundLabel, soundSelect);
        section.appendChild(soundRow);

        const pitchRow = document.createElement('label');
        pitchRow.className = 'sfx-editor-row';
        const pitchLabel = document.createElement('span');
        pitchLabel.textContent = 'Note (ignored for noise)';
        const pitchInput = document.createElement('input');
        pitchInput.type = 'text';
        pitchInput.value = typeof params.pitch === 'string' ? params.pitch : (params.pitch?.toString() ?? 'c4');
        pitchInput.addEventListener('input', () => {
          params.pitch = pitchInput.value;
        });
        pitchRow.append(pitchLabel, pitchInput);
        section.appendChild(pitchRow);

        for (const field of FIELDS) {
          const row = document.createElement('label');
          row.className = 'sfx-editor-row';
          const nameSpan = document.createElement('span');
          nameSpan.textContent = field.label;
          const rangeInput = document.createElement('input');
          rangeInput.type = 'range';
          rangeInput.min = String(field.min);
          rangeInput.max = String(field.max);
          rangeInput.step = String(field.step);
          rangeInput.value = String(fieldValue(params, field.key));
          const valueSpan = document.createElement('span');
          valueSpan.className = 'sfx-editor-value';
          valueSpan.textContent = rangeInput.value;
          rangeInput.addEventListener('input', () => {
            setFieldValue(params, field.key, Number(rangeInput.value));
            valueSpan.textContent = rangeInput.value;
          });
          row.append(nameSpan, rangeInput, valueSpan);
          section.appendChild(row);
        }

        contentEl.appendChild(section);
      });
    }

    function renderCode(): void {
      const help = document.createElement('div');
      help.className = 'sfx-editor-code-help';
      help.textContent = 'Advanced: hand-edit the voice stack directly. Must evaluate to an array '
        + "of voices, e.g. [note(60).attack(0.01).decay(0.1).sustain(0).release(0.05).gain(0.8)].";
      contentEl.appendChild(help);

      codeTextarea = document.createElement('textarea');
      codeTextarea.className = 'sfx-editor-code-textarea';
      codeTextarea.spellcheck = false;
      codeTextarea.value = paramsToCode(draft);
      contentEl.appendChild(codeTextarea);
    }

    function showMode(): void {
      contentEl.innerHTML = '';
      errorEl.hidden = true;
      codeTextarea = null;
      slidersBtn.classList.toggle('active', mode === 'sliders');
      codeBtn.classList.toggle('active', mode === 'code');
      if (mode === 'sliders') renderSliders();
      else renderCode();
    }

    slidersBtn.addEventListener('click', () => {
      if (mode === 'sliders') return;
      if (!applyCodeIfPresent()) return;
      mode = 'sliders';
      showMode();
    });
    codeBtn.addEventListener('click', () => {
      if (mode === 'code') return;
      mode = 'code';
      showMode();
    });

    showMode();

    const actions = document.createElement('div');
    actions.className = 'sfx-editor-actions';

    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'secondary';
    previewBtn.textContent = '▶ Preview';
    previewBtn.addEventListener('click', () => {
      if (!applyCodeIfPresent()) return;
      sfx.preview(id, draft);
    });

    const saveCityBtn = document.createElement('button');
    saveCityBtn.type = 'button';
    saveCityBtn.className = 'primary';
    saveCityBtn.textContent = '💾 Save to this city';
    saveCityBtn.addEventListener('click', () => {
      if (!applyCodeIfPresent()) return;
      onSaveCity({ ...getCityOverrides(), [id]: draft });
      renderListView();
    });

    const saveGlobalBtn = document.createElement('button');
    saveGlobalBtn.type = 'button';
    saveGlobalBtn.className = 'primary';
    saveGlobalBtn.textContent = '🌐 Save globally';
    saveGlobalBtn.addEventListener('click', () => {
      if (!applyCodeIfPresent()) return;
      onSaveGlobal({ ...getGlobalOverrides(), [id]: draft });
      renderListView();
    });

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'secondary';
    resetBtn.textContent = '↺ Reset';
    resetBtn.addEventListener('click', () => {
      onSaveCity(resetEffect(getCityOverrides(), id));
      onSaveGlobal(resetEffect(getGlobalOverrides(), id));
      renderListView();
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'secondary';
    cancelBtn.textContent = '✕ Cancel';
    cancelBtn.addEventListener('click', () => renderListView());

    actions.append(previewBtn, saveCityBtn, saveGlobalBtn, resetBtn, cancelBtn);
    bodyEl.appendChild(actions);
  }

  const open = () => {
    if (backdrop) return;

    backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'modal sfx-editor-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Sound effects editor');

    const header = document.createElement('div');
    header.className = 'sfx-editor-header';
    const title = document.createElement('div');
    title.className = 'sfx-editor-title';
    title.textContent = 'Sound Effects';
    const subtitle = document.createElement('div');
    subtitle.className = 'sfx-editor-subtitle';
    subtitle.textContent = 'Preview, customize, and save your own version of each sound.';
    const titleBlock = document.createElement('div');
    titleBlock.append(title, subtitle);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.className = 'secondary modal-close';

    header.append(titleBlock, closeBtn);

    body = document.createElement('div');
    body.className = 'sfx-editor-body';

    modal.append(header, body);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    renderListView();

    escHandler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cleanup();
    };
    window.addEventListener('keydown', escHandler);

    closeBtn.addEventListener('click', cleanup);
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) cleanup();
    });
    modal.addEventListener('click', (event) => event.stopPropagation());
  };

  return { open, close: cleanup };
}
