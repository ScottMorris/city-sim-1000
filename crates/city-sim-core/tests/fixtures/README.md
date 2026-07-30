# Test fixtures

`golden_city.*` asks *"does this tree still produce the same city it produced yesterday?"* — a regression net over the current engine, regenerated on purpose when the engine deliberately changes.

This directory used to also hold `city_v4.csim`/`city_v4.expected`, a genuine pre-strata save proving the v4 → v5 migration against a file this tree could no longer produce. Both files, and the `snapshot::v4_fixture` test that read them, were deleted once the wire itself moved onto occupant bits (`crates/city-sim-protocol/src/tile_buffer.rs`'s live layout, 8 → 9 bytes/tile) — the fixture's entire premise was proving the wire *didn't* change across the #177 step-3 migration, which that flip deliberately un-proves. Old `.citysim` saves still import byte-for-byte, just through the now-separately-frozen `legacy_tile_buffer.rs`, exercised by `import.rs`'s own round-trip tests instead.

## `golden_city.script` + `golden_city.expected`

**The golden city.** A committed command script and a committed dump of everything observable after replaying it. `tests/golden_city.rs` is the harness.

```bash
cargo test -p city-sim-core --test golden_city                 # run it
GOLDEN=regen cargo test -p city-sim-core --test golden_city    # regenerate the dump
```

**Regeneration is a deliberate act.** The dump is a *derived* artefact, so a wrong derivation and a stale expectation look identical from the outside — which makes "regenerate until green" the exact failure mode this fixture exists to prevent. Every line that moves must be named and justified in the commit message; a diff nobody can explain is a bug report, not a merge.

- **`golden_city.script`** — data, not code. A readable list of `(tool, x, y)` commands and tick counts, so a case can be added without touching Rust:

  ```
  grid <w> <h>            the map size
  seed <n>                the PRNG seed
  tick <n>                advance the sim by n fixed ticks
  <Tool> <x> <y>          apply a tool; MUST succeed or the harness panics
  refuse <Tool> <x> <y>   apply a tool that MUST be refused; the refusal
                          message is recorded in the dump
  ```

  Tool names are the `city_sim_protocol::commands::Tool` variants, and the harness derives the name table from the enum rather than restating it — so renaming a tool breaks the script loudly.

- **`golden_city.expected`** — generated text, one thing per line so a diff points at the thing that moved: the script's identity and a hash of its effective directives; every refusal and its message; the scalars (tick, day, money, population, jobs, building count, `state_hash`); the utility, demand and education blocks; **every** `BudgetStats` field; the wilderness score, trend, EMAs and full breakdown; the building list; and one line per tile:

  ```
  tile <index> (<x>,<y>) terrain=<Land|Water> flags=[PWA] density=<n> bid=<development> occ=<occupant set>
  ```

  `flags` is the three derived per-tick bits (`POWERED`/`WATERED`/`ABANDONED`) as fixed glyphs, `-` where unset. `terrain`, `density`, `bid` and `occ` are the canonical, authored tile fields directly — there is no derived `kind`/wire-flags byte left to disagree with them, since `display.rs`'s precedence ladder (the thing this file's own two-halves-of-a-line comparison used to exist to catch drifting) is deleted along with the flattened wire format it derived. `occ` is now the whole story for what stands on a tile.

The city is 24×16 — not square, so a transposed x/y cannot pass unnoticed — seeded, and run for 400 ticks in two stretches, so the gallery of awkward states is built into a *live* city rather than a static one. It covers: a level crossing in both build orders and a third carrying a hydro line; a line over a road, over a rail, over a level crossing, over a vacant zone and over a lot that then develops under it; a road laid under an existing line; a lone line; a line demoted to its flag by a later regrade, with a pipe under it; trees planted through a live line; water brushed over a live line; a pipe under a road, a lone pipe and a pipe under water; 1×1 and 2×2 footprints (park, pump, large park, two schools, coal plant, wind turbine); a 1×1 structure razed, where v4 left a scoring ghost; a 2×2 footprint cleared by one click anywhere inside it; a bulldozed lake that is still a lake; a lake paved and the pavement razed, which is not; an abandoned lot; and a power plant deliberately left off the network.

**Reproducibility caveat.** Floats print to four decimals and everything behind them is IEEE-exact, with one exception: the wilderness patch bonus goes through `f32::exp`, which is a libm routine and may differ by an ulp between platforms. An ulp there is ~5e-7 against a printed precision of 1e-4, so it would take a value sitting on a rounding boundary to show. If `patch` or the wilderness `score` ever differ by one in the last digit on a new platform and *nothing else moves*, that is this and not a regression.

Three companion tests keep the fixture honest rather than merely stable: `the_golden_city_is_deterministic` replays twice and diffs; `the_golden_city_still_covers_every_awkward_state` asserts each case above is *still* built, so a well-meaning edit cannot quietly delete coverage while leaving the dump green; and `the_dump_has_a_line_for_every_tile_and_every_section` catches a silently truncated dump.

The coverage test asks each case in whichever of four ways can actually see it, and the choice matters — three cases were once listed here and asserted nowhere:

- **Build-order cases, against the script.** A crossing built road-last and one built rail-last are the same tile afterwards, so these have to be asked as *runs of tools on one tile*: `[Rail, Road]`, `[PowerLine, TerraformRaise, WaterPipe]`, and so on.
- **Structural cases, against the replayed city.** "Some tile looks like this" — a lone pipe, water carrying a live line, a lake left standing, a demoted line with a pipe under it, an abandoned lot. The abandoned lot is the only case in the gallery the *simulation* produces rather than the script, so it is also the one likeliest to disappear if the run length or the decay parameters move.
- **The 2×2 raze, against the script in order.** This one fits neither of the above: the tool history is keyed by `(x, y)` and the case spans two tiles by definition — the stamp lands on the origin, the click lands elsewhere inside the rect — so no per-tile run can express it, and afterwards there is nothing left in the city to look at. The script is walked in order instead, tracking live footprint rects, and the whole rect is then checked clear. The footprint sizes are learned by asking the engine rather than from a `Tool → TileKind` table restated here, which would be a fourth copy of that mapping and the only one nothing checks.
- **The isolated power plant, against adjacency.** Asked as *nothing next to its footprint conducts power*, because a plant's own tiles always read `POWERED` — `Tile::conducts` is true for anything with a `building_id`, so a footprint is always its own conductor. The connected coal plant is asserted too, so the isolated turbine is a contrast with something.

All four were checked by deleting the case and watching the test fail: dropping `ParkLarge 2 10` / `Bulldoze 3 11`, dropping `WaterPipe 3 6`, wiring the turbine to a line, and shortening the final `tick`. In each case the dump was regenerated first, so the diff test stayed green and the coverage test was the only thing that caught it — which is exactly the failure mode it exists for.
