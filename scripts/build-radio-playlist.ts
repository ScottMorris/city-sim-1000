#!/usr/bin/env -S node --experimental-import-meta-resolve
/**
 * Build a radio playlist JSON from audio files under public/audio/radio.
 * - Extracts duration (ffprobe) and loudness (ffmpeg ebur128).
 * - Converts matching covers to 256px WebP (or extracts embedded art when flagged).
 * - Writes playlist.json with fields expected by the radio widget.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

interface CliOptions {
  audioDir: string;
  coversDir: string;
  output: string;
  defaultArtist: string;
  metaPath?: string;
  extractEmbedded: boolean;
  force: boolean;
  dryRun: boolean;
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

  const audioFiles = await listAudio(opts.audioDir);
  if (audioFiles.length === 0) {
    console.error(`${colour.red('No audio files found in ')}${colour.blue(opts.audioDir)}`);
    return;
  }

  const groups = groupByBase(audioFiles);
  const tracks = [];

  for (const [id, files] of groups) {
    const primary = pickPrimary(files);
    if (!primary) continue;

    const fallback = files
      .filter((f) => f !== primary)
      .map((f) => toPublicPath(f, publicRoot))
      .filter(Boolean) as string[];

    const tags = await readTags(primary);
    const src = toPublicPath(primary, publicRoot);
    const duration = await getDuration(primary);
    const loudness = await getLoudness(primary);

    const override = metaOverrides[id] ?? {};
    const title = override.title ?? tags.title ?? humanize(id);
    const artist = override.artist ?? tags.artist ?? opts.defaultArtist;
    const loop = override.loop;

    const coverPath = await ensureCover(id, primary, opts);
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
      fallbackSrc: fallback.length ? fallback : undefined
    });
  }

  tracks.sort((a, b) => a.id.localeCompare(b.id));

  const playlist = { version: '1.0', tracks };
  if (opts.dryRun) {
    console.log(JSON.stringify(playlist, null, 2));
    return;
  }

  await fs.mkdir(path.dirname(opts.output), { recursive: true });
  await fs.writeFile(opts.output, JSON.stringify(playlist, null, 2));
  console.log(
    `${colour.green('Wrote ')}${colour.blue(opts.output)}${colour.green(' with ')}${colour.cyan(
      `${tracks.length}`
    )}${colour.green(' track(s).')}`
  );
}

function parseArgs(argv: string[]): CliOptions | null {
  const defaults: CliOptions = {
    audioDir: 'public/audio/radio',
    coversDir: 'public/audio/radio/covers',
    output: 'public/audio/radio/playlist.json',
    defaultArtist: 'Unknown Artist',
    metaPath: undefined,
    extractEmbedded: false,
    force: false,
    dryRun: false
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
        opts.audioDir = argv[++i] ?? opts.audioDir;
        break;
      case '--covers':
        opts.coversDir = argv[++i] ?? opts.coversDir;
        break;
      case '--out':
        opts.output = argv[++i] ?? opts.output;
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
      colour.cyan('Build radio playlist JSON.'),
      '',
      'Options:',
      '  --audio <dir>                 Audio directory (default: public/audio/radio)',
      '  --covers <dir>                Covers directory (default: public/audio/radio/covers)',
      '  --out <file>                  Output playlist path (default: public/audio/radio/playlist.json)',
      '  --default-artist <name>       Default artist if none provided (default: "Unknown Artist")',
      '  --meta <file>                 Optional JSON mapping { "<id>": { "title": "...", "artist": "...", "loop": true } }',
      '  --extract-embedded-covers     Try extracting embedded art when no cover exists',
      '  --force                       Recreate covers even if a WebP already exists',
      '  --dry-run                     Print playlist JSON to stdout without writing files',
      '  --help, -h                    Show this help',
      '',
      'Requires ffprobe and ffmpeg in PATH.'
    ].join('\n')
  );
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

async function listAudio(audioDir: string): Promise<string[]> {
  const entries = await fs.readdir(audioDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && AUDIO_EXT.includes(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(audioDir, e.name));
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

async function ensureCover(id: string, audioFile: string, opts: CliOptions): Promise<string | null> {
  await fs.mkdir(opts.coversDir, { recursive: true });
  const target = path.join(opts.coversDir, `${id}.webp`);
  if (!opts.force && (await exists(target))) {
    return target;
  }

  const existingCover = await findMatchingCover(id, opts.coversDir);
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

async function findMatchingCover(id: string, coversDir: string): Promise<string | null> {
  for (const ext of COVER_EXT) {
    const file = path.join(coversDir, `${id}${ext}`);
    if (await exists(file)) {
      return file;
    }
  }
  return null;
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
      `${colour.yellow('File is outside public dir: ')}${colour.blue(absPath)}${colour.yellow(
        '; skipping.'
      )}`
    );
    return null;
  }
  return '/' + rel.split(path.sep).join('/');
}

async function readTags(file: string): Promise<{ artist?: string; title?: string }> {
  try {
    const { stdout } = await run('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format_tags=artist,title',
      '-of',
      'json',
      file
    ]);
    const parsed = JSON.parse(stdout) as { format?: { tags?: Record<string, string> } };
    const tags = parsed.format?.tags ?? {};
    const artist = tags.artist || tags.ARTIST;
    const title = tags.title || tags.TITLE;
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

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
