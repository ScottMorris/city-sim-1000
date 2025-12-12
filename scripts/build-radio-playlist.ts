#!/usr/bin/env -S node --experimental-import-meta-resolve
/**
 * Build radio playlists from station folders under public/audio/radio.
 * - Creates a playlist.json for each station directory.
 * - Emits a stations manifest (public/audio/radio/stations.json) that the runtime consumes.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const colour = {
  green: (s: string) => `\u001b[32m${s}\u001b[0m`,
  yellow: (s: string) => `\u001b[33m${s}\u001b[0m`,
  red: (s: string) => `\u001b[31m${s}\u001b[0m`,
  cyan: (s: string) => `\u001b[36m${s}\u001b[0m`,
  blue: (s: string) => `\u001b[34m${s}\u001b[0m`
};

interface MetaOverride {
  title?: string;
  artist?: string;
  loop?: boolean;
}

interface StationMeta {
  name?: string;
  description?: string;
}

interface StationDefinition {
  id: string;
  dir: string;
  meta?: StationMeta;
}

interface StationManifestEntry {
  id: string;
  name: string;
  description?: string;
  playlist: string;
}

interface CliOptions {
  stationsRoot: string;
  stationsManifest: string;
  coversDir: string;
  defaultArtist: string;
  metaPath?: string;
  extractEmbedded: boolean;
  force: boolean;
  dryRun: boolean;
  stationId?: string;
  convertOpus: boolean;
}

interface PlaylistTrack {
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

interface RadioPlaylist {
  version: string;
  tracks: PlaylistTrack[];
}

const AUDIO_EXT = ['.opus', '.ogg', '.mp3', '.flac', '.wav', '.m4a'];
const COVER_EXT = ['.webp', '.avif', '.png', '.jpg', '.jpeg'];
const PREFERRED_AUDIO_ORDER = ['.opus', '.ogg', '.mp3', '.flac', '.wav', '.m4a'];
const MAX_COVER_SIZE = 256;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) return;

  const publicRoot = path.resolve('public');
  const metaOverrides = opts.metaPath ? await loadMeta(opts.metaPath) : {};

  const stations = await discoverStations(opts.stationsRoot, opts.stationId);
  if (stations.length === 0) {
    if (opts.stationId) {
      console.error(
        `${colour.red('Station not found: ')}${colour.blue(opts.stationId)}${colour.red(
          ` in ${opts.stationsRoot}`
        )}`
      );
    } else {
      console.error(`${colour.red('No radio stations found in ')}${colour.blue(opts.stationsRoot)}`);
    }
    return;
  }

  const entries: StationManifestEntry[] = [];
  for (const station of stations) {
    const playlistPath = path.join(station.dir, 'playlist.json');
    const playlist = await buildStationPlaylist(station, playlistPath, opts, metaOverrides, publicRoot);
    if (!playlist || playlist.tracks.length === 0) {
      continue;
    }
    const manifestPath = toPublicPath(playlistPath, publicRoot);
    if (!manifestPath) continue;
    entries.push({
      id: station.id,
      name: station.meta?.name ?? humanize(station.id),
      description: station.meta?.description,
      playlist: manifestPath
    });
  }

  const manifest = { version: '1.0', stations: entries };
  if (opts.dryRun) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  await fs.mkdir(path.dirname(opts.stationsManifest), { recursive: true });
  await fs.writeFile(opts.stationsManifest, JSON.stringify(manifest, null, 2));
  console.log(
    `${colour.green('Wrote ')}${colour.blue(opts.stationsManifest)}${colour.green(
      ` with ${entries.length} station(s)`
    )}`
  );
}

function parseArgs(argv: string[]): CliOptions | null {
  const defaults: CliOptions = {
    stationsRoot: 'public/audio/radio',
    stationsManifest: 'public/audio/radio/stations.json',
    coversDir: 'public/audio/radio/covers',
    defaultArtist: 'Unknown Artist',
    metaPath: undefined,
    extractEmbedded: false,
    force: false,
    dryRun: false,
    stationId: undefined,
    convertOpus: false
  };

  const opts = { ...defaults };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        printHelp();
        return null;
      case '--audio':
      case '--stations-root':
        opts.stationsRoot = argv[++i] ?? opts.stationsRoot;
        break;
      case '--stations-manifest':
      case '--out':
        opts.stationsManifest = argv[++i] ?? opts.stationsManifest;
        break;
      case '--station':
        opts.stationId = argv[++i];
        break;
      case '--covers':
        opts.coversDir = argv[++i] ?? opts.coversDir;
        break;
      case '--default-artist':
        opts.defaultArtist = argv[++i] ?? opts.defaultArtist;
        break;
      case '--meta':
        opts.metaPath = argv[++i];
        break;
      case '--extract-embedded-covers':
        opts.extractEmbedded = true;
        break;
      case '--force':
        opts.force = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--convert-opus':
        opts.convertOpus = true;
        break;
      default:
        console.warn(`${colour.yellow('Unknown argument: ')}${colour.cyan(arg)}`);
        printHelp();
        return null;
    }
  }

  return opts;
}

function printHelp() {
  console.log(
    [
      colour.cyan('Build radio playlists per station directory.'),
      '',
      'Options:',
      '  --audio <dir>                 Audio root directory (default: public/audio/radio)',
      '  --stations-root <dir>         Alias for --audio.',
      '  --stations-manifest <file>    Stations manifest output (default: public/audio/radio/stations.json)',
      '  --out <file>                  Alias for --stations-manifest.',
      '  --station <id>                Only process the named station folder.',
      '  --covers <dir>                Covers directory (default: public/audio/radio/covers)',
      '  --default-artist <name>       Default artist if none provided (default: "Unknown Artist")',
      '  --meta <file>                 Optional JSON mapping { "<id>": { "title": "...", "artist": "...", "loop": true } }',
      '  --extract-embedded-covers     Try extracting embedded art when no cover exists',
      '  --force                       Recreate covers even if a WebP already exists',
      '  --convert-opus                Transcode non-Opus sources to .opus (keeps originals as fallbacks)',
      '  --dry-run                     Print manifest and playlist data without writing files',
      '  --help, -h                    Show this help',
      '',
      'Requires ffprobe and ffmpeg in PATH.'
    ].join('\n')
  );
}

async function discoverStations(root: string, stationId?: string): Promise<StationDefinition[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const directories = entries.filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'covers'
  );
  const stations: StationDefinition[] = [];
  for (const entry of directories) {
    if (stationId && entry.name !== stationId) continue;
    const dir = path.join(root, entry.name);
    const meta = await readStationMeta(dir);
    stations.push({ id: entry.name, dir, meta });
  }
  return stations.sort((a, b) => a.id.localeCompare(b.id));
}

async function readStationMeta(dir: string): Promise<StationMeta | undefined> {
  const file = path.join(dir, 'station.json');
  if (!(await exists(file))) return undefined;
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return isStationMeta(parsed) ? parsed : undefined;
  } catch (err) {
    console.warn(
      `${colour.yellow('Station meta read failed for ')}${colour.blue(file)}${colour.yellow(
        `: ${(err as Error).message}`
      )}`
    );
    return undefined;
  }
}

function isStationMeta(value: unknown): value is StationMeta {
  if (!value || typeof value !== 'object') return false;
  const { name, description } = value as Record<string, unknown>;
  if (name !== undefined && typeof name !== 'string') return false;
  if (description !== undefined && typeof description !== 'string') return false;
  return true;
}

async function buildStationPlaylist(
  station: StationDefinition,
  playlistPath: string,
  opts: CliOptions,
  overrides: Record<string, MetaOverride>,
  publicRoot: string
): Promise<RadioPlaylist | null> {
  const audioFiles = await listAudio(station.dir);
  if (audioFiles.length === 0) {
    console.warn(`${colour.yellow('No audio files found for ')}${colour.blue(station.id)}`);
    const empty: RadioPlaylist = { version: '1.0', tracks: [] };
    if (!opts.dryRun) {
      await fs.mkdir(path.dirname(playlistPath), { recursive: true });
      await fs.writeFile(playlistPath, JSON.stringify(empty, null, 2));
    }
    return empty;
  }
  const playlist = await assemblePlaylist(audioFiles, station, opts, overrides, publicRoot);
  if (opts.dryRun) {
    console.log(
      `${colour.cyan('Station ')}${colour.blue(station.id)}${colour.cyan(' playlist:')}`
    );
    console.log(JSON.stringify(playlist, null, 2));
    return playlist;
  }
  await fs.mkdir(path.dirname(playlistPath), { recursive: true });
  await fs.writeFile(playlistPath, JSON.stringify(playlist, null, 2));
  console.log(
    `${colour.green('Wrote ')}${colour.blue(playlistPath)}${colour.green(' for station ')}${colour.cyan(
      station.id
    )}`
  );
  return playlist;
}

async function assemblePlaylist(
  audioFiles: string[],
  station: StationDefinition,
  opts: CliOptions,
  overrides: Record<string, MetaOverride>,
  publicRoot: string
): Promise<RadioPlaylist> {
  const groups = groupByBase(audioFiles);
  const tracks: PlaylistTrack[] = [];
  const coverDirs = dedupe([opts.coversDir, path.join(station.dir, 'covers')]);

  for (const [id, files] of groups) {
    const originalPrimary = pickPrimary(files);
    const fileList = [...files];
    if (opts.convertOpus) {
      const converted = await ensureOpusVersion(fileList, station.dir, id, opts);
      if (converted && !fileList.includes(converted)) {
        fileList.push(converted);
      }
    }

    const primary = pickPrimary(fileList);
    if (!primary) continue;

    const fallbacks = fileList
      .filter((item) => item !== primary)
      .map((item) => toPublicPath(item, publicRoot))
      .filter((item): item is string => Boolean(item));

    const metaSource = originalPrimary ?? primary;
    const tags = metaSource ? await readTags(metaSource) : {};
    const src = toPublicPath(primary, publicRoot);
    if (!src) continue;
    const duration = await getDuration(primary);
    const loudness = await getLoudness(primary);

    const override = overrides[id] ?? {};
    const title = override.title ?? tags.title ?? humanize(id);
    const artist = override.artist ?? tags.artist ?? opts.defaultArtist;
    const loop = override.loop;
    const coverPath = await ensureCover(id, metaSource ?? primary, opts, coverDirs);
    const coverSrc = coverPath ? toPublicPath(coverPath, publicRoot) : null;

    tracks.push({
      id,
      title,
      artist,
      src,
      cover: coverSrc ?? undefined,
      duration,
      loudnessLufs: loudness ?? undefined,
      loop,
      fallbackSrc: fallbacks.length ? fallbacks : undefined
    });
  }

  tracks.sort((a, b) => a.id.localeCompare(b.id));
  return { version: '1.0', tracks };
}

async function ensureCover(
  id: string,
  audioFile: string,
  opts: CliOptions,
  searchDirs: string[]
): Promise<string | null> {
  await fs.mkdir(opts.coversDir, { recursive: true });
  const target = path.join(opts.coversDir, `${id}.webp`);
  if (!opts.force && (await exists(target))) {
    return target;
  }

  const existingCover = await findMatchingCoverInDirs(id, searchDirs);
  if (existingCover) {
    const ok = await convertCover(existingCover, target);
    return ok ? target : null;
  }

  if (opts.extractEmbedded) {
    const extracted = await extractEmbeddedCover(audioFile);
    if (extracted) {
      const ok = await convertCover(extracted, target);
      await fs.rm(extracted, { force: true });
      return ok ? target : null;
    }
  }

  return null;
}

async function findMatchingCoverInDirs(id: string, directories: string[]): Promise<string | null> {
  for (const dir of directories) {
    if (!dir) continue;
    for (const ext of COVER_EXT) {
      const file = path.join(dir, `${id}${ext}`);
      if (await exists(file)) {
        return file;
      }
    }
  }
  return null;
}

async function listAudio(audioDir: string): Promise<string[]> {
  const entries = await fs.readdir(audioDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && AUDIO_EXT.includes(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(audioDir, entry.name));
}

function groupByBase(files: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const id = path.basename(file, path.extname(file));
    const list = groups.get(id) ?? [];
    list.push(file);
    groups.set(id, list);
  }
  return groups;
}

function pickPrimary(files: string[]): string | null {
  if (files.length === 0) return null;
  const sorted = [...files].sort((a, b) => {
    const extA = path.extname(a).toLowerCase();
    const extB = path.extname(b).toLowerCase();
    return PREFERRED_AUDIO_ORDER.indexOf(extA) - PREFERRED_AUDIO_ORDER.indexOf(extB);
  });
  return sorted[0];
}

async function getDuration(file: string): Promise<number | undefined> {
  try {
    const { stdout } = await run('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      file
    ]);
    const seconds = parseFloat(stdout.trim());
    return Number.isFinite(seconds) ? Math.round(seconds) : undefined;
  } catch (err) {
    console.warn(
      `${colour.yellow('Duration probe failed for ')}${colour.blue(file)}${colour.yellow(
        `: ${(err as Error).message}`
      )}`
    );
    return undefined;
  }
}

async function getLoudness(file: string): Promise<number | undefined> {
  try {
    const { stderr } = await run('ffmpeg', [
      '-i',
      file,
      '-filter_complex',
      'ebur128=peak=true',
      '-f',
      'null',
      '-'
    ]);
    const match = stderr.match(/Integrated loudness:\s*(-?\d+\.?\d*) LUFS/i);
    return match ? parseFloat(match[1]) : undefined;
  } catch (err) {
    console.warn(
      `${colour.yellow('Loudness probe failed for ')}${colour.blue(file)}${colour.yellow(
        `: ${(err as Error).message}`
      )}`
    );
    return undefined;
  }
}

async function extractEmbeddedCover(audioFile: string): Promise<string | null> {
  const temp = path.join(path.dirname(audioFile), `${path.basename(audioFile)}.cover.tmp.png`);
  try {
    await run('ffmpeg', ['-i', audioFile, '-map', '0:v', '-frames:v', '1', temp, '-y']);
    return (await exists(temp)) ? temp : null;
  } catch {
    return null;
  }
}

async function convertCover(input: string, output: string): Promise<boolean> {
  try {
    await run('ffmpeg', [
      '-i',
      input,
      '-vf',
      `scale='min(${MAX_COVER_SIZE},iw)':'min(${MAX_COVER_SIZE},ih)':force_original_aspect_ratio=decrease`,
      '-frames:v',
      '1',
      '-y',
      '-c:v',
      'libwebp',
      '-lossless',
      '1',
      output
    ]);
    return true;
  } catch (err) {
    console.warn(
      `${colour.yellow('Cover convert failed for ')}${colour.blue(input)}${colour.yellow(
        `: ${(err as Error).message}`
      )}`
    );
    return false;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function loadMeta(metaPath: string): Promise<Record<string, MetaOverride>> {
  try {
    const raw = await fs.readFile(metaPath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(
      `${colour.yellow('Could not read meta file ')}${colour.blue(metaPath)}${colour.yellow(
        `: ${(err as Error).message}`
      )}`
    );
    return {};
  }
}

async function readTags(file: string): Promise<{ artist?: string; title?: string }> {
  try {
    const { stdout } = await run('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format_tags=artist,title:stream_tags=artist,title',
      '-of',
      'json',
      file
    ]);
    const parsed = JSON.parse(stdout) as {
      format?: { tags?: Record<string, string> };
      streams?: Array<{ tags?: Record<string, string> }>;
    };
    const formatTags = parsed.format?.tags ?? {};
    const streamTags = parsed.streams?.find((s) => s.tags)?.tags ?? {};
    const artist = pickTag(formatTags, 'artist') ?? pickTag(streamTags, 'artist');
    const title = pickTag(formatTags, 'title') ?? pickTag(streamTags, 'title');
    return { artist, title };
  } catch (err) {
    console.warn(
      `${colour.yellow('Tag read failed for ')}${colour.blue(file)}${colour.yellow(
        `: ${(err as Error).message}`
      )}`
    );
    return {};
  }
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function pickTag(tags: Record<string, string>, key: string): string | undefined {
  const direct = tags[key];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const upper = tags[key.toUpperCase()];
  if (typeof upper === 'string' && upper.trim()) return upper.trim();
  const lower = tags[key.toLowerCase()];
  if (typeof lower === 'string' && lower.trim()) return lower.trim();
  return undefined;
}

async function ensureOpusVersion(
  files: string[],
  stationDir: string,
  id: string,
  opts: CliOptions
): Promise<string | null> {
  const existing = files.find((file) => path.extname(file).toLowerCase() === '.opus');
  if (existing) return existing;
  const source = pickPrimary(files);
  if (!source) return null;
  const target = path.join(stationDir, `${id}.opus`);
  if (!opts.force && (await exists(target))) {
    return target;
  }
  const ok = await convertToOpus(source, target);
  return ok ? target : null;
}

async function convertToOpus(input: string, output: string): Promise<boolean> {
  try {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await run('ffmpeg', [
      '-i',
      input,
      '-map_metadata',
      '0',
      '-vn',
      '-c:a',
      'libopus',
      '-b:a',
      '96k',
      '-ar',
      '48000',
      '-vbr',
      'on',
      '-y',
      output
    ]);
    return true;
  } catch (err) {
    console.warn(
      `${colour.yellow('Opus convert failed for ')}${colour.blue(input)}${colour.yellow(
        `: ${(err as Error).message}`
      )}`
    );
    return false;
  }
}

function humanize(id: string): string {
  return id
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function toPublicPath(absPath: string, publicRoot: string): string | null {
  const rel = path.relative(publicRoot, absPath);
  if (rel.startsWith('..')) {
    console.warn(
      `${colour.yellow('File is outside public dir: ')}${colour.blue(absPath)}${colour.yellow('; skipping.')}`
    );
    return null;
  }
  return '/' + rel.split(path.sep).join('/');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
