export interface RadioTrack {
  id: string;
  title: string;
  artist: string;
  src: string;
  cover?: string;
  duration?: number;
  loudnessLufs?: number;
  loop?: boolean;
  fallbackSrc?: string[];
}

export interface RadioPlaylist {
  version: string;
  tracks: RadioTrack[];
}

export const DEFAULT_PLAYLIST_PATH = '/audio/radio/playlist.json';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function fetchRadioPlaylist(
  url: string = DEFAULT_PLAYLIST_PATH,
  fetchImpl: FetchLike = fetch
): Promise<RadioPlaylist | null> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    return normalisePlaylist(data);
  } catch {
    return null;
  }
}

export function normalisePlaylist(data: unknown): RadioPlaylist | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const version = isNonEmptyString((data as { version?: unknown }).version)
    ? (data as { version: string }).version
    : '1.0';

  const tracks = Array.isArray((data as { tracks?: unknown }).tracks)
    ? ((data as { tracks: unknown[] }).tracks
        .map((entry) => normaliseTrack(entry))
        .filter((entry): entry is RadioTrack => Boolean(entry)))
    : [];

  return { version, tracks };
}

function normaliseTrack(entry: unknown): RadioTrack | null {
  if (!entry || typeof entry !== 'object') return null;
  const { id, title, artist, src, cover, duration, loudnessLufs, loop, fallbackSrc } = entry as Record<
    string,
    unknown
  >;

  if (!isNonEmptyString(id) || !isNonEmptyString(title) || !isNonEmptyString(artist) || !isNonEmptyString(src)) {
    return null;
  }

  const normalisedFallbacks = Array.isArray(fallbackSrc)
    ? fallbackSrc.filter((item): item is string => isNonEmptyString(item))
    : undefined;

  return {
    id,
    title,
    artist,
    src,
    cover: isNonEmptyString(cover) ? cover : undefined,
    duration: typeof duration === 'number' ? duration : undefined,
    loudnessLufs: typeof loudnessLufs === 'number' ? loudnessLufs : undefined,
    loop: typeof loop === 'boolean' ? loop : undefined,
    fallbackSrc: normalisedFallbacks && normalisedFallbacks.length > 0 ? normalisedFallbacks : undefined
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
