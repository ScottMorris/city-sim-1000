// Unit tests for the in-game sound effects editor modal
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SFX_EFFECT_IDS } from '../game/sfxOverrides';
import type { SfxOverrides } from '../game/sfxOverrides';
import { DEFAULT_SFX_VOICES } from './sfxDefinitions';
import { initSfxEditorModal, type SfxEditorOptions } from './sfxEditor';
import type { SfxController } from './sfx';

function createFakeSfx(): SfxController {
  return {
    playToolResult: vi.fn(),
    playUndo: vi.fn(),
    preview: vi.fn()
  };
}

function initTestEditor(overrides: Partial<SfxEditorOptions> = {}) {
  const sfx = createFakeSfx();
  const onSaveCity = vi.fn();
  const onSaveGlobal = vi.fn();
  const editor = initSfxEditorModal({
    sfx,
    getCityOverrides: () => ({}),
    getGlobalOverrides: () => ({}),
    onSaveCity,
    onSaveGlobal,
    ...overrides
  });
  return { editor, sfx, onSaveCity, onSaveGlobal };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('list view', () => {
  it('shows a row for every known effect when opened', () => {
    const { editor } = initTestEditor();
    editor.open();
    const rows = document.querySelectorAll('.sfx-editor-row-label');
    expect(rows).toHaveLength(SFX_EFFECT_IDS.length);
  });

  it('preview button plays the resolved (saved or default) version, not a draft', () => {
    const { editor, sfx } = initTestEditor();
    editor.open();
    const previewBtn = document.querySelectorAll('.sfx-editor-row button')[0] as HTMLButtonElement;
    previewBtn.click();
    expect(sfx.preview).toHaveBeenCalledWith(SFX_EFFECT_IDS[0]);
  });

  it('reset clears the effect from both scopes', () => {
    const cityOverrides: SfxOverrides = { placeBuilding: DEFAULT_SFX_VOICES.placeBuilding };
    const { editor, onSaveCity, onSaveGlobal } = initTestEditor({ getCityOverrides: () => cityOverrides });
    editor.open();
    const resetBtn = document.querySelectorAll('.sfx-editor-row button')[2] as HTMLButtonElement;
    resetBtn.click();
    expect(onSaveCity).toHaveBeenCalledWith({});
    expect(onSaveGlobal).toHaveBeenCalledWith({});
  });

  it('reset all clears every effect from both scopes', () => {
    const { editor, onSaveCity, onSaveGlobal } = initTestEditor();
    editor.open();
    const resetAllBtn = document.querySelector<HTMLButtonElement>('.sfx-editor-reset-all');
    resetAllBtn?.click();
    expect(onSaveCity).toHaveBeenCalledWith({});
    expect(onSaveGlobal).toHaveBeenCalledWith({});
  });
});

describe('edit view', () => {
  it('renders one layer section per voice in the stack (placeBuilding has 3)', () => {
    const { editor } = initTestEditor();
    editor.open();
    const editBtn = document.querySelectorAll('.sfx-editor-row button')[1] as HTMLButtonElement;
    editBtn.click();
    const layers = document.querySelectorAll('.sfx-editor-layer');
    expect(layers).toHaveLength(DEFAULT_SFX_VOICES.placeBuilding.length);
  });

  it('preview plays the in-progress draft, not just the saved version', () => {
    const { editor, sfx } = initTestEditor();
    editor.open();
    const editBtn = document.querySelectorAll('.sfx-editor-row button')[1] as HTMLButtonElement;
    editBtn.click();
    const previewBtn = document.querySelector<HTMLButtonElement>('.sfx-editor-actions button');
    previewBtn?.click();
    expect(sfx.preview).toHaveBeenCalledWith('placeBuilding', expect.any(Array));
    const draftArg = (sfx.preview as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(draftArg).toHaveLength(DEFAULT_SFX_VOICES.placeBuilding.length);
  });

  it('save to city calls onSaveCity with the effect set to the edited stack', () => {
    const { editor, onSaveCity } = initTestEditor();
    editor.open();
    const editBtn = document.querySelectorAll('.sfx-editor-row button')[1] as HTMLButtonElement;
    editBtn.click();
    const [, saveCityBtn] = document.querySelectorAll<HTMLButtonElement>('.sfx-editor-actions button');
    saveCityBtn.click();
    expect(onSaveCity).toHaveBeenCalledWith(
      expect.objectContaining({ placeBuilding: expect.any(Array) })
    );
  });

  it('save globally calls onSaveGlobal with the effect set to the edited stack', () => {
    const { editor, onSaveGlobal } = initTestEditor();
    editor.open();
    const editBtn = document.querySelectorAll('.sfx-editor-row button')[1] as HTMLButtonElement;
    editBtn.click();
    const [, , saveGlobalBtn] = document.querySelectorAll<HTMLButtonElement>('.sfx-editor-actions button');
    saveGlobalBtn.click();
    expect(onSaveGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ placeBuilding: expect.any(Array) })
    );
  });

  it('editing a slider updates the draft passed to preview', () => {
    const { editor, sfx } = initTestEditor();
    editor.open();
    const editBtn = document.querySelectorAll('.sfx-editor-row button')[1] as HTMLButtonElement;
    editBtn.click();

    const gainSlider = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="range"]')).find(
      (input) => input.previousElementSibling?.textContent === 'Gain (0-1)'
    );
    expect(gainSlider).toBeDefined();
    gainSlider!.value = '0.42';
    gainSlider!.dispatchEvent(new Event('input'));

    const previewBtn = document.querySelector<HTMLButtonElement>('.sfx-editor-actions button');
    previewBtn?.click();
    const draftArg = (sfx.preview as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(draftArg[0].gainLevel).toBeCloseTo(0.42);
  });

  it('code view shows generated code for the current draft, and switching back applies edits', () => {
    const { editor, sfx } = initTestEditor();
    editor.open();
    const editBtn = document.querySelectorAll('.sfx-editor-row button')[1] as HTMLButtonElement;
    editBtn.click();

    const [slidersBtn, codeBtn] = document.querySelectorAll<HTMLButtonElement>('.sfx-editor-mode-toggle button');
    codeBtn.click();
    const textarea = document.querySelector<HTMLTextAreaElement>('.sfx-editor-code-textarea');
    expect(textarea).not.toBeNull();
    expect(textarea!.value).toContain('note(');

    textarea!.value = textarea!.value.replace(/\.gain\([\d.]+\)/, '.gain(0.11)');
    slidersBtn.click();

    const previewBtn = document.querySelector<HTMLButtonElement>('.sfx-editor-actions button');
    previewBtn?.click();
    const draftArg = (sfx.preview as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(draftArg[0].gainLevel).toBeCloseTo(0.11);
  });

  it('the generated code includes filter fields for a layer with a defined filterCutoff', () => {
    const { editor } = initTestEditor();
    editor.open();
    const editBtn = document.querySelectorAll('.sfx-editor-row button')[1] as HTMLButtonElement;
    editBtn.click(); // placeBuilding — its first layer has a defined filterCutoff (220)

    const codeBtn = document.querySelectorAll<HTMLButtonElement>('.sfx-editor-mode-toggle button')[1];
    codeBtn.click();
    const textarea = document.querySelector<HTMLTextAreaElement>('.sfx-editor-code-textarea')!;
    expect(textarea.value).toContain('.lpf(220)');
    expect(textarea.value).toContain('.lpenv(');
  });

  it('round-trips an edit through code → sliders → code without losing it', () => {
    const { editor } = initTestEditor();
    editor.open();
    const editBtn = document.querySelectorAll('.sfx-editor-row button')[1] as HTMLButtonElement;
    editBtn.click();

    const [slidersBtn, codeBtn] = document.querySelectorAll<HTMLButtonElement>('.sfx-editor-mode-toggle button');
    codeBtn.click();
    let textarea = document.querySelector<HTMLTextAreaElement>('.sfx-editor-code-textarea')!;
    textarea.value = textarea.value.replace(/\.gain\([\d.]+\)/, '.gain(0.77)');

    slidersBtn.click(); // compiles the edit into the draft
    codeBtn.click(); // regenerates code from that same draft

    textarea = document.querySelector<HTMLTextAreaElement>('.sfx-editor-code-textarea')!;
    expect(textarea.value).toContain('.gain(0.77)');
  });

  it('invalid code shows an inline error and does not lose the draft', () => {
    const { editor, sfx, onSaveCity } = initTestEditor();
    editor.open();
    const editBtn = document.querySelectorAll('.sfx-editor-row button')[1] as HTMLButtonElement;
    editBtn.click();

    const codeBtn = document.querySelectorAll<HTMLButtonElement>('.sfx-editor-mode-toggle button')[1];
    codeBtn.click();
    const textarea = document.querySelector<HTMLTextAreaElement>('.sfx-editor-code-textarea')!;
    textarea.value = 'not valid js [[[';

    const [previewBtn, saveCityBtn] = document.querySelectorAll<HTMLButtonElement>('.sfx-editor-actions button');
    previewBtn.click();
    expect(sfx.preview).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>('.sfx-editor-code-error')?.hidden).toBe(false);

    saveCityBtn.click();
    expect(onSaveCity).not.toHaveBeenCalled();
  });

  it('cancel discards the draft and returns to the list view without saving', () => {
    const { editor, onSaveCity, onSaveGlobal } = initTestEditor();
    editor.open();
    const editBtn = document.querySelectorAll('.sfx-editor-row button')[1] as HTMLButtonElement;
    editBtn.click();
    const buttons = document.querySelectorAll<HTMLButtonElement>('.sfx-editor-actions button');
    buttons[buttons.length - 1].click(); // Cancel is last
    expect(onSaveCity).not.toHaveBeenCalled();
    expect(onSaveGlobal).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.sfx-editor-row-label')).toHaveLength(SFX_EFFECT_IDS.length);
  });
});

describe('close behaviour', () => {
  it('the Close button removes the modal from the DOM', () => {
    const { editor } = initTestEditor();
    editor.open();
    expect(document.querySelector('.modal-backdrop')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('.modal-close')?.click();
    expect(document.querySelector('.modal-backdrop')).toBeNull();
  });
});
