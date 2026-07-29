# Snapshot fixtures

## `city_v4.csim` + `city_v4.expected`

A genuine pre-strata save, kept so the v4 → v5 migration can be demonstrated against a file this tree cannot produce.

**Generated on commit `303897ff090b93380c223b8c53a3ceba79b8afca`** — the last commit before #177 step 3 stratified `Tile` — by a throwaway `dump_v4_fixture` test that was deleted immediately afterwards. Neither file is regenerable from the current tree, and that is deliberate: a migration you can only demonstrate against your own output is not a migration.

- **`city_v4.csim`** — raw `snapshot::to_bytes` output, header version `4`. A 16×16 city, seed 42, 400 ticks.
- **`city_v4.expected`** — what that same tree put on the wire, as plain text so it can be read in a diff. Grid size, the five scalars, `state_hash`, the building list, and then one `tile` line per cell:

  ```
  tile <index> <kind name> <flags> <underground byte> <building id or 65535>
  ```

The city was authored to cover every producible occupant combination: bare land, water and trees; road, rail and both build orders of a level crossing; a lone hydro line, and a line over road, over rail, and over road + rail; a zone, a zone carrying a line, and a developed lot carrying a line; a 1×1 park, two 2×2 parks, a 2×2 school and a 2×2 coal plant; a pipe under a road and a lone pipe; a tree planted through a live line; water brushed over a live line; a line demoted to the flag by a later regrade; and a ghost park left behind by `remove_building`.

`snapshot::v4_fixture` loads the `.csim`, derives each tile's wire bytes through `display::wire_*`, and asserts they equal the `.expected` line — except for three documented normalisations, each a case where v4 had two spellings for one physical tile and the strata have one. See the `Normalisation` enum for what they are and why each collapses the way it does.
