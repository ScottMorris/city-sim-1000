// buildInfo.ts — which build of the app and the engine is actually running.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// This module exists because of a specific failure: a tile behaviour was fixed,
// the WASM rebuilt, and a browser tab kept running the previous engine. From
// inside the page there was no way to tell — the app looked current, the source
// on disk was current, and the two disagreed for an hour.
//
// `SimHost.version()` could not have caught it: it returns `CARGO_PKG_VERSION`,
// which only moves on a release. What distinguishes "the build I am running"
// from "the build on disk" is a fingerprint that changes every time, plus the
// timestamps to compare.

/** Short git SHA of the working tree Vite was started from, `-dirty` if unclean. */
declare const __BUILD_SHA__: string;
/** ISO time at which the Vite dev server or production build started. */
declare const __BUILD_TIME__: string;
/** ISO mtime of the compiled WASM as Vite saw it at startup, or `null`. */
declare const __WASM_BUILT_AT__: string | null;

export interface BuildInfo {
  /** Git SHA the bundle was built from. */
  sha: string;
  /** When the bundle was built (dev: when the server booted). */
  builtAt: string;
  /** When the WASM on disk was compiled, as of bundle build time. */
  wasmBuiltAtBundleTime: string | null;
  /** When this page actually loaded — the engine in memory is from this moment. */
  pageLoadedAt: string;
  /** `Last-Modified` of the WASM the worker actually fetched, if reported. */
  wasmLastModified: string | null;
  /** `CARGO_PKG_VERSION` of the running `city-sim-wasm`. */
  engineVersion: string | null;
  /** Git revision the running WASM was compiled from, `-dirty` if unclean. */
  engineSha: string | null;
}

const pageLoadedAt = new Date().toISOString();

let wasmLastModified: string | null = null;
let engineVersion: string | null = null;
let engineSha: string | null = null;

/** Recorded by the bridge once the worker reports what it loaded. */
export function recordEngineBuild(info: {
  lastModified?: string | null;
  version?: string | null;
  sha?: string | null;
}): void {
  if (info.lastModified !== undefined) wasmLastModified = info.lastModified;
  if (info.version !== undefined) engineVersion = info.version;
  if (info.sha !== undefined) engineSha = info.sha;
}

export function getBuildInfo(): BuildInfo {
  return {
    sha: typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : 'unknown',
    builtAt: typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : 'unknown',
    wasmBuiltAtBundleTime: typeof __WASM_BUILT_AT__ === 'string' ? __WASM_BUILT_AT__ : null,
    pageLoadedAt,
    wasmLastModified,
    engineVersion,
    engineSha
  };
}

/**
 * Whether the app bundle and the engine were built from different commits.
 *
 * Independent of [`isEngineStale`], which compares *times*: these two can carry
 * the same timestamp and still disagree, if the WASM was rebuilt from a
 * different checkout. `null` when either side is unknown, or when either is
 * `-dirty` — an uncommitted tree says nothing useful about whether the two
 * halves match, and claiming a mismatch there would cry wolf on every edit.
 */
export function isBuildMismatched(info: BuildInfo = getBuildInfo()): boolean | null {
  const { sha, engineSha: eng } = info;
  if (!eng || eng === 'unknown' || sha === 'unknown') return null;
  if (sha.endsWith('-dirty') || eng.endsWith('-dirty')) return null;
  return sha !== eng;
}

/**
 * Whether the engine running in this tab is older than the one on disk.
 *
 * The comparison that matters is **WASM last-modified versus page load**, not
 * bundle time: a module is instantiated once and lives for the tab's lifetime,
 * so `Cache-Control: no-cache` buys nothing without a reload. If the binary was
 * rebuilt after this page loaded, the tab is running yesterday's engine no
 * matter how current the source is.
 *
 * Returns `null` when it cannot be determined, so the overlay can say "unknown"
 * instead of a reassuring "up to date" it has not earned.
 */
export function isEngineStale(info: BuildInfo = getBuildInfo()): boolean | null {
  const built = info.wasmLastModified ?? info.wasmBuiltAtBundleTime;
  if (!built) return null;
  const builtMs = Date.parse(built);
  const loadedMs = Date.parse(info.pageLoadedAt);
  if (Number.isNaN(builtMs) || Number.isNaN(loadedMs)) return null;
  // One second of slack: `Last-Modified` has second resolution, so a WASM
  // written in the same second the page loaded is not evidence of staleness.
  return builtMs > loadedMs + 1000;
}
