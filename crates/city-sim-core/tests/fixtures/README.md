# Test fixtures

Two families live here, and they answer different questions. `city_v4.*` asks *"does a save written by the old tree still load as the same city?"* — it is a one-way migration proof and cannot be regenerated. `golden_city.*` asks *"does this tree still produce the same city it produced yesterday?"* — it is a regression net over the current engine and is regenerated on purpose.

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
  tile <index> (<x>,<y>) <terrain> kind=<wire kind>(<byte>) flags=<hex>[PWArlp] ug=<byte> bid=<development> occ=<occupant set>
  ```

  `kind`, `flags` and `ug` are the **derived** wire bytes (`display.rs`) — what a renderer actually sees. `terrain`, `occ` and `bid` are the **canonical** tile. Having both on one line is the point: a derivation that drifts from the strata under it shows up as the two halves of a line disagreeing.

The city is 24×16 — not square, so a transposed x/y cannot pass unnoticed — seeded, and run for 400 ticks in two stretches, so the gallery of awkward states is built into a *live* city rather than a static one. It covers: a level crossing in both build orders and a third carrying a hydro line; a line over a road, over a rail, over a level crossing, over a vacant zone and over a lot that then develops under it; a road laid under an existing line; a lone line; a line demoted to its flag by a later regrade, with a pipe under it; trees planted through a live line; water brushed over a live line; a pipe under a road, a lone pipe and a pipe under water; 1×1 and 2×2 footprints (park, pump, large park, two schools, coal plant, wind turbine); a 1×1 structure razed, where v4 left a scoring ghost; a 2×2 footprint cleared by one click anywhere inside it; a bulldozed lake that is still a lake; a lake paved and the pavement razed, which is not; an abandoned lot; and a power plant deliberately left off the network.

**Reproducibility caveat.** Floats print to four decimals and everything behind them is IEEE-exact, with one exception: the wilderness patch bonus goes through `f32::exp`, which is a libm routine and may differ by an ulp between platforms. An ulp there is ~5e-7 against a printed precision of 1e-4, so it would take a value sitting on a rounding boundary to show. If `patch` or the wilderness `score` ever differ by one in the last digit on a new platform and *nothing else moves*, that is this and not a regression.

Three companion tests keep the fixture honest rather than merely stable: `the_golden_city_is_deterministic` replays twice and diffs; `the_golden_city_still_covers_every_awkward_state` asserts each case above is *still* built, so a well-meaning edit cannot quietly delete coverage while leaving the dump green; and `the_dump_has_a_line_for_every_tile_and_every_section` catches a silently truncated dump.

The coverage test asks each case in whichever of four ways can actually see it, and the choice matters — three cases were once listed here and asserted nowhere:

- **Build-order cases, against the script.** A crossing built road-last and one built rail-last are the same tile afterwards, so these have to be asked as *runs of tools on one tile*: `[Rail, Road]`, `[PowerLine, TerraformRaise, WaterPipe]`, and so on.
- **Structural cases, against the replayed city.** "Some tile looks like this" — a lone pipe, water carrying a live line, a lake left standing, a demoted line with a pipe under it, an abandoned lot. The abandoned lot is the only case in the gallery the *simulation* produces rather than the script, so it is also the one likeliest to disappear if the run length or the decay parameters move.
- **The 2×2 raze, against the script in order.** This one fits neither of the above: the tool history is keyed by `(x, y)` and the case spans two tiles by definition — the stamp lands on the origin, the click lands elsewhere inside the rect — so no per-tile run can express it, and afterwards there is nothing left in the city to look at. The script is walked in order instead, tracking live footprint rects, and the whole rect is then checked clear. The footprint sizes are learned by asking the engine rather than from a `Tool → TileKind` table restated here, which would be a fourth copy of that mapping and the only one nothing checks.
- **The isolated power plant, against adjacency.** Asked as *nothing next to its footprint conducts power*, because a plant's own tiles always read `POWERED` — `Tile::conducts` is true for anything with a `building_id`, so a footprint is always its own conductor. The connected coal plant is asserted too, so the isolated turbine is a contrast with something.

All four were checked by deleting the case and watching the test fail: dropping `ParkLarge 2 10` / `Bulldoze 3 11`, dropping `WaterPipe 3 6`, wiring the turbine to a line, and shortening the final `tick`. In each case the dump was regenerated first, so the diff test stayed green and the coverage test was the only thing that caught it — which is exactly the failure mode it exists for.

## `city_v4.csim` + `city_v4.expected`

A genuine pre-strata save, kept so the v4 → v5 migration can be demonstrated against a file this tree cannot produce.

**Generated on the commit `fix(sim): read every stratum, so no feature goes uncounted`** — step 2 of #177, the last commit before step 3 stratified `Tile` — by a throwaway `dump_v4_fixture` test that was deleted immediately afterwards. Neither file is regenerable from the current tree, and that is deliberate: a migration you can only demonstrate against your own output is not a migration.

The baseline is cited by commit *subject* rather than by hash, here and in `src/display.rs`, `src/snapshot.rs`, `src/commands.rs` and `src/wilderness.rs`. A hash on a branch that gets rebased stops resolving — the subject survives the rebase and survives the merge to `main`, where the same commit lands with the same message. There is no `dump_v4_fixture` left in the tree to regenerate the header from, so nothing can reintroduce a hash here.

- **`city_v4.csim`** — raw `snapshot::to_bytes` output, header version `4`. A 16×16 city, seed 42, 400 ticks.
- **`city_v4.expected`** — what that same tree put on the wire, as plain text so it can be read in a diff. Grid size, the five scalars, `state_hash`, the building list, and then one `tile` line per cell:

  ```
  tile <index> <kind name> <flags> <underground byte> <building id or 65535>
  ```

The city was authored to cover every producible occupant combination: bare land, water and trees; road, rail and both build orders of a level crossing; a lone hydro line, and a line over road, over rail, and over road + rail; a zone, a zone carrying a line, and a developed lot carrying a line; a 1×1 park, two 2×2 parks, a 2×2 school and a 2×2 coal plant; a pipe under a road and a lone pipe; a tree planted through a live line; water brushed over a live line; a line demoted to the flag by a later regrade; and a ghost park left behind by `remove_building`.

`snapshot::v4_fixture` loads the `.csim`, derives each tile's wire bytes through `display::wire_*`, and asserts they equal the `.expected` line — except for three documented differences. Two are normalisations: v4 had two spellings for one physical tile and the strata have one. The third, the ghost park, is not a spelling collapse — it deletes an occupant that should never have survived its own demolition, so the loaded city's wilderness score moves. That is the intended fix, and it is delta 3 of the module note in `src/display.rs`. See the `Normalisation` enum for the details of each.
