// replay.ts — run one command script through both engines and diff the answers.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { Engine, Headline, rustEngine, tsEngine } from './engines';
import { describeFacts, factsDiff, TileFacts } from './tileFacts';
import { Tool } from '../toolTypes';

export interface Command {
  tool: Tool;
  x: number;
  y: number;
}

export const cmd = (tool: Tool, x: number, y: number): Command => ({ tool, x, y });

export interface Disagreement {
  /** Which predicate disagreed — `accepted`, a tile fact key, or a headline key. */
  predicate: string;
  /** Where in the script, and on which tile if applicable. */
  where: string;
  rust: string;
  ts: string;
}

export interface ReplayOptions {
  width?: number;
  height?: number;
  seed?: number;
  /**
   * Ticks to run after the script.
   *
   * Kept below 40 by default — `simulation.ts` delays zone growth by
   * `ticksPerSecond * 2` ticks, so a shorter run compares the utility networks
   * and the placement outcomes without the RNG-driven growth roll on top.
   * Scenarios that want growth ask for it explicitly.
   */
  ticks?: number;
  /** Compare per-tile facts (default true). */
  compareTiles?: boolean;
  /** Compare headline scalars (default true). */
  compareHeadline?: boolean;
  /**
   * Headline keys to leave out, each one a *named, reported* drift.
   *
   * Nothing may be dropped here silently: every exclusion a scenario passes is
   * a constant in `crossEngineParity.test.ts` with the drift written out, and
   * a companion test pins the disagreement so that fixing the engine makes the
   * harness say the exclusion is now stale.
   */
  ignoreHeadline?: readonly (keyof Headline)[];
}

function headlineKeys(): (keyof Headline)[] {
  return [
    'money',
    'population',
    'jobs',
    'powerProduced',
    'powerUsed',
    'powerBalance',
    'waterProduced',
    'waterUsed',
    'waterBalance'
  ];
}

/**
 * Replay `script` on a fresh pair of engines and collect every disagreement.
 *
 * Three classes of observable, in the order a player would notice them:
 *
 * 1. **`accepted`** — did the tool go through? Compared per command, because a
 *    guard that only one engine enforces shows up here first and everything
 *    downstream is then a consequence rather than a separate finding.
 * 2. **tile facts** — what ended up on each tile, in the spelling-agnostic
 *    vocabulary of `tileFacts.ts`.
 * 3. **headline scalars** — money, population, jobs, and the power and water
 *    ledgers.
 */
export function replay(script: Command[], opts: ReplayOptions = {}): Disagreement[] {
  const width = opts.width ?? 12;
  const height = opts.height ?? 12;
  const seed = opts.seed ?? 7;
  const ticks = opts.ticks ?? 0;
  const ignore = new Set<keyof Headline>(opts.ignoreHeadline ?? []);

  const rust = rustEngine(width, height, seed);
  const ts = tsEngine(width, height, seed);
  const found: Disagreement[] = [];

  script.forEach((c, i) => {
    const r = rust.apply(c.tool, c.x, c.y);
    const t = ts.apply(c.tool, c.x, c.y);
    if (r !== t) {
      found.push({
        predicate: 'accepted',
        where: `step ${i}: ${c.tool} at (${c.x},${c.y})`,
        rust: String(r),
        ts: String(t)
      });
    }
  });

  for (let i = 0; i < ticks; i++) {
    rust.tick();
    ts.tick();
  }

  if (opts.compareTiles !== false) {
    found.push(...diffTiles(rust, ts));
  }

  if (opts.compareHeadline !== false) {
    const rh = rust.headline();
    const th = ts.headline();
    for (const key of headlineKeys()) {
      if (ignore.has(key)) continue;
      // Money is the one scalar the two engines cannot hold identically: Rust
      // keeps whole credits in an `i64` with a separate `money_frac`
      // accumulator, TypeScript keeps a float. Comparing the whole-credit part
      // is exact on everything a player can see; a sub-credit divergence is
      // invisible here by construction, and no other scalar is floored.
      const r = key === 'money' ? Math.floor(rh[key]) : rh[key];
      const t = key === 'money' ? Math.floor(th[key]) : th[key];
      if (r !== t) {
        found.push({
          predicate: key,
          where: `after ${script.length} commands and ${ticks} ticks`,
          rust: String(rh[key]),
          ts: String(th[key])
        });
      }
    }
  }

  return found;
}

function diffTiles(rust: Engine, ts: Engine): Disagreement[] {
  const rf = rust.facts();
  const tf = ts.facts();
  const out: Disagreement[] = [];
  for (let i = 0; i < rf.length; i++) {
    const keys = factsDiff(rf[i], tf[i]);
    if (keys.length === 0) continue;
    const x = i % rust.width;
    const y = Math.floor(i / rust.width);
    out.push({
      predicate: keys.join(','),
      where: `tile (${x},${y})`,
      rust: describeFacts(rf[i]),
      ts: describeFacts(tf[i])
    });
  }
  return out;
}

/** Group disagreements by predicate — the shape a report wants. */
export function summarise(found: Disagreement[]): string {
  if (found.length === 0) return 'no disagreements';
  const byPredicate = new Map<string, Disagreement[]>();
  for (const d of found) {
    const list = byPredicate.get(d.predicate) ?? [];
    list.push(d);
    byPredicate.set(d.predicate, list);
  }
  const lines: string[] = [];
  for (const [predicate, list] of byPredicate) {
    lines.push(`  ${predicate} — ${list.length} disagreement(s):`);
    for (const d of list.slice(0, 6)) {
      lines.push(`    ${d.where}: rust=${d.rust} ts=${d.ts}`);
    }
    if (list.length > 6) lines.push(`    …and ${list.length - 6} more`);
  }
  return lines.join('\n');
}

/**
 * A tiny deterministic generator, so a fuzz scenario is reproducible from its
 * seed alone. Numerical Recipes' LCG — the harness only needs a stable stream,
 * not statistical quality.
 */
export class Lcg {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0;
    return this.s;
  }
  int(maxExclusive: number): number {
    return this.next() % maxExclusive;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
}

/** A reproducible random script over `palette` on a `size`×`size` map. */
export function fuzzScript(
  seed: number,
  length: number,
  size: number,
  palette: readonly Tool[]
): Command[] {
  const rng = new Lcg(seed);
  const script: Command[] = [];
  for (let i = 0; i < length; i++) {
    script.push(cmd(rng.pick(palette), rng.int(size), rng.int(size)));
  }
  return script;
}
