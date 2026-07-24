// Plays the game's procedural sound effects via @liminal-hq/undertone
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { stack, type AudioContextLike, type VoiceParams } from '@liminal-hq/undertone';
import { Tool } from '../game/toolTypes';
import { resolveVoiceParams, type SfxEffectId, type SfxOverrides } from '../game/sfxOverrides';
import { DEFAULT_SFX_VOICES, voiceFromParams } from './sfxDefinitions';

/** Sounds other than the priority-1 placeBuilding "plop" get a minimum replay
 * interval so a fast drag-stroke doesn't stack overlapping copies into mush. */
const THROTTLE_MS: Partial<Record<SfxEffectId, number>> = {
  bulldoze: 50,
  error: 80,
  undo: 80
};

export interface SfxController {
  playToolResult(tool: Tool, success: boolean): void;
  playUndo(): void;
  /** Plays a draft (unsaved) voice stack immediately, bypassing throttling — for the editor's preview button. */
  preview(id: SfxEffectId, draftParams?: VoiceParams[]): void;
}

export interface SfxOptions {
  getVolume: () => number;
  getCityOverrides: () => SfxOverrides;
  getGlobalOverrides: () => SfxOverrides;
  /** Injectable for tests; defaults to the real AudioContext constructor. */
  createAudioContext?: () => AudioContext;
}

/** Wraps a real AudioContext so every voice routes through one master GainNode instead
 * of straight to ctx.destination — Undertone's SoundEffect.play() has no volume knob
 * of its own, so this is the only way a settings slider can control playback volume. */
function createMasterGainContext(audioContext: AudioContext): { ctx: AudioContextLike; masterGain: GainNode } {
  const masterGain = audioContext.createGain();
  masterGain.connect(audioContext.destination);
  const ctx: AudioContextLike = {
    get currentTime() {
      return audioContext.currentTime;
    },
    get sampleRate() {
      return audioContext.sampleRate;
    },
    destination: masterGain,
    createOscillator: () => audioContext.createOscillator(),
    createGain: () => audioContext.createGain(),
    createBiquadFilter: () => audioContext.createBiquadFilter(),
    createBufferSource: () => audioContext.createBufferSource(),
    createBuffer: (numChannels, length, sampleRate) => audioContext.createBuffer(numChannels, length, sampleRate)
  };
  return { ctx, masterGain };
}

export function initSfx(options: SfxOptions): SfxController {
  let lazy: { audioContext: AudioContext; ctx: AudioContextLike; masterGain: GainNode } | undefined;
  const lastPlayedAt: Partial<Record<SfxEffectId, number>> = {};

  function ensure() {
    if (!lazy) {
      const audioContext = (options.createAudioContext ?? (() => new AudioContext()))();
      const { ctx, masterGain } = createMasterGainContext(audioContext);
      lazy = { audioContext, ctx, masterGain };
    }
    lazy.masterGain.gain.value = options.getVolume();
    return lazy;
  }

  function playParams(params: VoiceParams[]): void {
    if (options.getVolume() <= 0) return;
    const { audioContext, ctx } = ensure();
    if (audioContext.state === 'suspended') {
      void audioContext.resume();
    }
    stack(...params.map(voiceFromParams)).play(ctx);
  }

  function resolveParams(id: SfxEffectId): VoiceParams[] {
    return resolveVoiceParams(id, DEFAULT_SFX_VOICES, options.getCityOverrides(), options.getGlobalOverrides());
  }

  function play(id: SfxEffectId): void {
    const minInterval = THROTTLE_MS[id];
    if (minInterval !== undefined) {
      const now = performance.now();
      if (now - (lastPlayedAt[id] ?? -Infinity) < minInterval) return;
      lastPlayedAt[id] = now;
    }
    playParams(resolveParams(id));
  }

  return {
    playToolResult(tool, success) {
      if (!success) {
        play('error');
        return;
      }
      if (tool === Tool.Bulldoze) {
        play('bulldoze');
        return;
      }
      if (tool === Tool.Inspect) return;
      // Priority-1 sound: always plays, never throttled.
      playParams(resolveParams('placeBuilding'));
    },
    playUndo() {
      play('undo');
    },
    preview(id, draftParams) {
      playParams(draftParams ?? resolveParams(id));
    }
  };
}
