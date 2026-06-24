import { describe, expect, it, vi } from 'vitest';
import { fetchRadioPlaylist, normalisePlaylist } from './radioPlaylist';

describe('normalisePlaylist', () => {
  it('keeps valid tracks and drops invalid entries', () => {
    const playlist = normalisePlaylist({
      version: '1.2',
      tracks: [
        {
          id: 'track-1',
          title: 'First',
          artist: 'Alpha',
          src: '/audio/radio/first.opus',
          cover: '/audio/radio/covers/first.webp',
          fallbackSrc: ['/audio/radio/first.ogg', '', null]
        },
        {
          id: '',
          title: 'Missing',
          artist: 'Nope',
          src: '/audio/radio/missing.opus'
        }
      ]
    });

    expect(playlist).not.toBeNull();
    expect(playlist?.version).toBe('1.2');
    expect(playlist?.tracks).toHaveLength(1);
    expect(playlist?.tracks[0]).toMatchObject({
      id: 'track-1',
      title: 'First',
      artist: 'Alpha',
      src: '/audio/radio/first.opus',
      cover: '/audio/radio/covers/first.webp',
      fallbackSrc: ['/audio/radio/first.ogg']
    });
  });

  it('returns null for invalid input', () => {
    expect(normalisePlaylist(null)).toBeNull();
    expect(normalisePlaylist({ tracks: 'invalid' })).toMatchObject({ tracks: [] });
  });
});

describe('fetchRadioPlaylist', () => {
  it('parses responses when fetch succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          version: '1.0',
          tracks: [
            { id: 'a', title: 'A', artist: 'Artist', src: '/audio/radio/a.opus' },
            { id: 'b', title: 'B', artist: 'Artist 2', src: '/audio/radio/b.opus' }
          ]
        })
    });

    const playlist = await fetchRadioPlaylist('/audio/radio/playlist.json', fetchMock as unknown as typeof fetch);
    expect(fetchMock).toHaveBeenCalled();
    expect(playlist?.tracks).toHaveLength(2);
  });

  it('returns null on fetch errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({})
    });

    const playlist = await fetchRadioPlaylist('/audio/radio/playlist.json', fetchMock as unknown as typeof fetch);
    expect(playlist).toBeNull();
  });
});
