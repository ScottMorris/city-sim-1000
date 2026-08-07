// wireParse.test.ts — parseWire's structural sanity checks against malformed wire payloads.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseWire } from './wireParse';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseWire', () => {
  it('returns the parsed value unchanged when it matches the expected shape', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parseWire<{ id: number }[]>('[{"id":1},{"id":2}]', { requireArray: true });
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns, but still returns the value, when requireArray sees an object instead', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parseWire<unknown[]>('{"not":"an array"}', { requireArray: true });
    expect(result).toEqual({ not: 'an array' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('expected an array');
  });

  it('warns once per missing key when requiredKeys are absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseWire('{"demand":{}}', { requiredKeys: ['demand', 'labour'] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('labour');
  });

  it('does not warn when every requiredKey is present', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseWire('{"demand":{},"labour":{}}', { requiredKeys: ['demand', 'labour'] });
    expect(warn).not.toHaveBeenCalled();
  });
});
