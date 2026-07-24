// Unit tests for SFX dispatch, throttling/priority, muting, and preview
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';

const playSpy = vi.fn();

vi.mock('@liminal-hq/undertone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@liminal-hq/undertone')>();
  return {
    ...actual,
    stack: vi.fn(() => ({ play: playSpy }))
  };
});

import { Tool } from '../game/toolTypes';
import { initSfx } from './sfx';

function createFakeAudioContext(): AudioContext {
  const gainNode = { connect: vi.fn(), gain: { value: 0 } };
  return {
    createGain: vi.fn(() => gainNode),
    destination: {},
    state: 'running',
    resume: vi.fn(async () => {})
  } as unknown as AudioContext;
}

function initTestSfx(overrides: Partial<Parameters<typeof initSfx>[0]> = {}) {
  return initSfx({
    getVolume: () => 1,
    getCityOverrides: () => ({}),
    getGlobalOverrides: () => ({}),
    createAudioContext: createFakeAudioContext,
    ...overrides
  });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('playToolResult dispatch', () => {
  it('plays the error sound whenever the tool result failed, regardless of tool', () => {
    initTestSfx().playToolResult(Tool.Road, false);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('plays bulldoze on a successful Bulldoze', () => {
    initTestSfx().playToolResult(Tool.Bulldoze, true);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('plays nothing for a successful Inspect', () => {
    initTestSfx().playToolResult(Tool.Inspect, true);
    expect(playSpy).not.toHaveBeenCalled();
  });

  it('plays placeBuilding for any other successful tool', () => {
    initTestSfx().playToolResult(Tool.Road, true);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });
});

describe('volume and muting', () => {
  it('skips playing entirely and never constructs an AudioContext when volume is 0', () => {
    const createAudioContext = vi.fn(createFakeAudioContext);
    const sfx = initTestSfx({ getVolume: () => 0, createAudioContext });
    sfx.playToolResult(Tool.Road, true);
    expect(playSpy).not.toHaveBeenCalled();
    expect(createAudioContext).not.toHaveBeenCalled();
  });

  it('creates the AudioContext lazily, once, and reuses it across plays', () => {
    const createAudioContext = vi.fn(createFakeAudioContext);
    const sfx = initTestSfx({ createAudioContext });
    sfx.playToolResult(Tool.Road, true);
    sfx.playUndo();
    expect(createAudioContext).toHaveBeenCalledTimes(1);
  });
});

describe('priority and throttling', () => {
  it('placeBuilding (priority 1) never throttles, even called back-to-back', () => {
    const sfx = initTestSfx();
    for (let i = 0; i < 5; i++) {
      sfx.playToolResult(Tool.Road, true);
    }
    expect(playSpy).toHaveBeenCalledTimes(5);
  });

  it('throttles rapid repeated bulldoze calls within the cooldown window', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const sfx = initTestSfx();

    sfx.playToolResult(Tool.Bulldoze, true); // plays
    now += 10; // within the 50ms cooldown
    sfx.playToolResult(Tool.Bulldoze, true); // throttled
    now += 10; // still within cooldown (20ms elapsed)
    sfx.playToolResult(Tool.Bulldoze, true); // throttled
    now += 40; // 60ms elapsed since the first play — past cooldown
    sfx.playToolResult(Tool.Bulldoze, true); // plays

    expect(playSpy).toHaveBeenCalledTimes(2);
  });
});

describe('preview', () => {
  it('bypasses throttling', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const sfx = initTestSfx();

    sfx.playToolResult(Tool.Bulldoze, true); // plays, sets the bulldoze cooldown
    now += 1; // well within the cooldown
    sfx.preview('bulldoze'); // should play anyway — preview ignores throttling

    expect(playSpy).toHaveBeenCalledTimes(2);
  });

  it('plays a draft params array when one is given, instead of the saved/default version', () => {
    const sfx = initTestSfx();
    sfx.preview('placeBuilding', []);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });
});
