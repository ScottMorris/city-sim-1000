import { withBasePath } from '../utils/assetPaths';

export interface RadioStation {
  id: string;
  name: string;
  description?: string;
  playlist: string;
}

export interface RadioStationManifest {
  version: string;
  stations: RadioStation[];
}

const DEFAULT_MANIFEST_PATH = withBasePath('audio/radio/stations.json');

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function fetchRadioStations(
  url: string = DEFAULT_MANIFEST_PATH,
  fetchImpl: FetchLike = fetch
): Promise<RadioStationManifest | null> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    return normaliseStations(data);
  } catch {
    return null;
  }
}

function normaliseStations(data: unknown): RadioStationManifest | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const version =
    isNonEmptyString((data as { version?: unknown }).version) ? (data as { version: string }).version : '1.0';
  const rawStations = (data as { stations?: unknown }).stations;
  if (!Array.isArray(rawStations)) {
    return null;
  }

  const stations = rawStations
    .map((entry) => normaliseStation(entry))
    .filter((entry): entry is RadioStation => Boolean(entry));

  return { version, stations };
}

function normaliseStation(entry: unknown): RadioStation | null {
  if (!entry || typeof entry !== 'object') return null;
  const { id, name, description, playlist } = entry as Record<string, unknown>;
  if (!isNonEmptyString(id) || !isNonEmptyString(playlist)) {
    return null;
  }

  return {
    id,
    name: isNonEmptyString(name) ? name : formatStationName(id),
    description: isNonEmptyString(description) ? description : undefined,
    playlist
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function formatStationName(id: string): string {
  return id
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
