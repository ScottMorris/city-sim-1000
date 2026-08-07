// index.test.ts — pins TOOL_ID/VIEW_STRATUM_ID, the last unpinned hand-copies in guest-js, against their Rust source of truth.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/**
 * `TOOL_ID` and `VIEW_STRATUM_ID` (`index.ts`) are hand-copied discriminant
 * maps — `ts-rs` mirrors types, not `#[repr(u8)]` value tables, so they
 * can't be generated the way `generated/*.ts` is (see `index.ts`'s own doc
 * comment on that). `app/src/game/protocol/wireParity.json` is generated
 * from Rust (`crates/city-sim-core/tests/wire_parity.rs`'s `tools`/
 * `viewStrata` tables, the same source `app/src/game/protocol/
 * wireParity.test.ts` pins `TOOL_TO_U8`/`STRATUM_TO_U8` against) — this file
 * is the same pin for this package's own copy.
 */

import { describe, it, expect } from 'bun:test'
import { TOOL_ID, VIEW_STRATUM_ID } from './index'
import wireParityFixture from '../../../app/src/game/protocol/wireParity.json'

interface NameU8 {
  name: string
  u8: number
}

const fixture = wireParityFixture as { tools: NameU8[]; viewStrata: NameU8[] }

describe('TOOL_ID', () => {
  it('matches wireParity.json\'s tools table entry for entry, in Rust discriminant order', () => {
    for (const { name, u8 } of fixture.tools) {
      expect(TOOL_ID[name as keyof typeof TOOL_ID], `TOOL_ID.${name}`).toBe(u8)
    }
  })

  it('has exactly as many entries as the fixture — nothing added or dropped', () => {
    expect(Object.keys(TOOL_ID).length).toBe(fixture.tools.length)
  })
})

describe('VIEW_STRATUM_ID', () => {
  it('matches wireParity.json\'s viewStrata table', () => {
    for (const { name, u8 } of fixture.viewStrata) {
      expect(VIEW_STRATUM_ID[name as keyof typeof VIEW_STRATUM_ID], `VIEW_STRATUM_ID.${name}`).toBe(u8)
    }
  })

  it('has exactly as many entries as the fixture — nothing added or dropped', () => {
    expect(Object.keys(VIEW_STRATUM_ID).length).toBe(fixture.viewStrata.length)
  })
})
