// wireParse.ts — typed JSON parsing at the sim-wire trust boundary.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/**
 * Parse `json` (a payload from the WASM worker or Tauri plugin) as `T`.
 *
 * This is the one place both bridges cross the JSON-string trust boundary —
 * everything past `SimHost`'s `*_json()` getters (WASM) or a Tauri IPC
 * string field arrives as untyped text, so a bare `JSON.parse(...) as T`
 * asserts a shape without checking it. `parseWire` still trusts the engine
 * (this is not a validation library, and the two are compiled from the same
 * commit as the TS that reads them), but it runs the cheap structural
 * checks `opts` asks for and `console.warn`s on a mismatch instead of
 * silently returning a value that doesn't match `T` — the failure mode a
 * bare cast can't distinguish from "everything's fine".
 */
export function parseWire<T>(
  json: string,
  opts?: { requireArray?: boolean; requiredKeys?: readonly string[] }
): T {
  const parsed: unknown = JSON.parse(json);
  if (opts?.requireArray) {
    if (!Array.isArray(parsed)) {
      console.warn(`parseWire: expected an array, got ${typeof parsed}`);
    }
  } else if (opts?.requiredKeys) {
    for (const key of opts.requiredKeys) {
      if (typeof parsed !== 'object' || parsed === null || !(key in parsed)) {
        console.warn(`parseWire: expected key "${key}" on the parsed payload`);
      }
    }
  }
  return parsed as T;
}
