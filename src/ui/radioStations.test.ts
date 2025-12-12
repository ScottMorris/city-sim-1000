import { describe, expect, it, vi } from 'vitest';
import { fetchRadioStations } from './radioStations';

describe('fetchRadioStations', () => {
  it('returns a normalized manifest when data loads', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          version: '2.0',
          stations: [
            {
              id: 'city-synth',
              name: 'City Synth',
              playlist: '/audio/radio/city-synth/playlist.json',
              description: 'Downtown loops'
            },
            {
              id: 'sample',
              playlist: '/audio/radio/sample/playlist.json'
            }
          ]
        })
    });

    const manifest = await fetchRadioStations('/any', fetchMock as unknown as typeof fetch);
    expect(manifest).toEqual({
      version: '2.0',
      stations: [
        {
          id: 'city-synth',
          name: 'City Synth',
          description: 'Downtown loops',
          playlist: '/audio/radio/city-synth/playlist.json'
        },
        {
          id: 'sample',
          name: 'Sample',
          playlist: '/audio/radio/sample/playlist.json'
        }
      ]
    });
  });

  it('returns null for invalid payloads', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ foo: 'bar' })
    });
    expect(await fetchRadioStations('/any', fetchMock as unknown as typeof fetch)).toBeNull();

    const failureFetch = vi.fn().mockRejectedValue(new Error('no network'));
    expect(await fetchRadioStations('/any', failureFetch as unknown as typeof fetch)).toBeNull();
  });
});
