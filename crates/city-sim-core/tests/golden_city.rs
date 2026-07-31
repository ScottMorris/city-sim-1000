// golden_city.rs — replay a committed command script, dump everything
// observable, and diff it against a committed expectation.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

//! **The golden city.**
//!
//! Three times during #177 someone wrote a probe that replayed a command list
//! on two builds and diffed the observables, used it to settle one question,
//! and deleted it. This is that probe, committed.
//!
//! Two files make it up and neither is Rust:
//!
//! - `tests/fixtures/golden_city.script` — a readable list of `(tool, x, y)`
//!   commands and tick counts. Adding a case is a line in a text file.
//! - `tests/fixtures/golden_city.expected` — everything the replayed city can
//!   be asked about, as plain diffable text: the wilderness score and its full
//!   breakdown, every `BudgetStats` field, population, jobs, money, the
//!   `state_hash`, the building list, and one line per tile giving terrain,
//!   density, development and the occupant set.
//!
//! ## Running it
//!
//! ```text
//! cargo test -p city-sim-core --test golden_city
//! ```
//!
//! ## Regenerating it
//!
//! ```text
//! GOLDEN=regen cargo test -p city-sim-core --test golden_city
//! ```
//!
//! **Regeneration is a deliberate act and must be justified in the commit
//! message**, naming which observable moved and why the new value is right.
//! The failure mode this file exists to catch is someone regenerating to turn
//! a red test green: the dump is a *derived* artefact, so a wrong derivation
//! and a stale expectation look identical from the outside. A regeneration
//! diff that nobody can explain is a bug report, not a merge.
//!
//! ## The one place this is not bit-exact
//!
//! Every float in the dump is printed to four decimals, and every sum, product
//! and comparison behind them is IEEE-exact — so the dump is reproducible on
//! any machine, with one caveat. `wilderness::compute_wilderness` calls
//! `f32::exp` for the patch bonus, and `exp` is a libm routine rather than an
//! IEEE-mandated operation: two platforms may disagree by an ulp. An ulp of an
//! f32 near 5.0 is ~5e-7 against a printed precision of 1e-4, so a disagreement
//! needs the true value to sit within an ulp of a rounding boundary. It has not
//! happened here, but if `patch` or `wilderness score` ever differ by exactly
//! one in the last printed digit on a new platform and nothing else moves,
//! that is this and not a regression.
//!
//! ## Why a dump and not assertions
//!
//! Unit tests assert what someone thought to assert; a full dump asserts
//! everything at once, including the things nobody thought of. The level
//! crossing whose minimap pixel moved rail-brown to road-grey during #177
//! changed no unit test and would have changed one line here.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::PathBuf;

use city_sim_core::buildings::BuildingInstance;
use city_sim_core::commands::apply_tool;
use city_sim_core::occupants::{iter_set, Network, Occupant, StructureLookup, Terrain};
use city_sim_core::sim::{state_hash, Simulation};
use city_sim_core::state::{GameState, Tile, FLAG_ABANDONED, FLAG_POWERED, FLAG_WATERED};
use city_sim_protocol::commands::{Tool, ViewStratum};

const SCRIPT: &str = include_str!("fixtures/golden_city.script");
const EXPECTED: &str = include_str!("fixtures/golden_city.expected");

/// One fixed tick, in real seconds. `Simulation::step` fires exactly one tick
/// per call at this `dt` and leaves the accumulator at zero, so a tick count
/// is exact rather than approximate.
const TICK_DT: f64 = 1.0 / 20.0;

// ---------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
enum Step {
    /// Apply a tool. Must succeed.
    Apply {
        tool: Tool,
        x: u32,
        y: u32,
        stratum: ViewStratum,
    },
    /// Apply a tool that must be refused; the message goes in the dump.
    Refuse {
        tool: Tool,
        x: u32,
        y: u32,
        stratum: ViewStratum,
    },
    /// Advance the simulation by this many fixed ticks.
    Tick(u32),
}

struct Script {
    width: u32,
    height: u32,
    seed: u32,
    steps: Vec<(usize, Step)>,
    /// FNV-1-64 over the *effective* directives only — comments and spacing
    /// are normalised away, so re-wording a comment does not demand a regen
    /// but changing a command does.
    hash: u64,
}

impl Script {
    fn ticks(&self) -> u32 {
        self.steps
            .iter()
            .map(|(_, s)| match s {
                Step::Tick(n) => *n,
                _ => 0,
            })
            .sum()
    }

    fn directives(&self) -> usize {
        self.steps.len()
    }
}

/// `Tool` has no `from_str`, and the script names tools so a human can read
/// it. The table is derived from the enum rather than written out, so renaming
/// a variant breaks the script loudly instead of silently.
fn tool_by_name(name: &str) -> Option<Tool> {
    (0u8..=u8::MAX)
        .filter_map(|v| Tool::try_from(v).ok())
        .find(|t| format!("{t:?}").eq_ignore_ascii_case(name))
}

fn parse_script(src: &str) -> Script {
    let mut width = None;
    let mut height = None;
    let mut seed = None;
    let mut steps: Vec<(usize, Step)> = Vec::new();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;

    for (n, raw) in src.lines().enumerate() {
        let line_no = n + 1;
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        // Normalised for the hash: one space between fields, lower case.
        let fields: Vec<&str> = line.split_whitespace().collect();
        for b in fields.join(" ").to_ascii_lowercase().bytes() {
            hash = hash.wrapping_mul(0x0100_0000_01b3) ^ b as u64;
        }

        let num = |i: usize| -> u32 {
            fields
                .get(i)
                .unwrap_or_else(|| {
                    panic!("golden_city.script:{line_no}: `{line}` is missing a field")
                })
                .parse()
                .unwrap_or_else(|_| {
                    panic!(
                        "golden_city.script:{line_no}: `{}` is not a number",
                        fields[i]
                    )
                })
        };

        // Every `Apply`/`Refuse` directive takes an optional trailing stratum
        // token — `surface` (the default, so every pre-existing line in this
        // file needs no edit) or `underground`. Only `Tool::Bulldoze` and
        // `Tool::WaterPipe` currently read it, but it is a field of the
        // directive itself, same as the wire command it stands in for.
        let stratum = |i: usize| -> ViewStratum {
            match fields.get(i) {
                None => ViewStratum::Surface,
                Some(s) if s.eq_ignore_ascii_case("surface") => ViewStratum::Surface,
                Some(s) if s.eq_ignore_ascii_case("underground") => ViewStratum::Underground,
                Some(s) => panic!(
                    "golden_city.script:{line_no}: `{s}` is not a stratum (surface|underground)"
                ),
            }
        };

        match fields[0].to_ascii_lowercase().as_str() {
            "grid" => {
                assert!(
                    width.is_none(),
                    "golden_city.script:{line_no}: `grid` twice"
                );
                width = Some(num(1));
                height = Some(num(2));
            }
            "seed" => {
                assert!(seed.is_none(), "golden_city.script:{line_no}: `seed` twice");
                seed = Some(num(1));
            }
            "tick" => steps.push((line_no, Step::Tick(num(1)))),
            "refuse" => {
                let tool = tool_by_name(fields[1]).unwrap_or_else(|| {
                    panic!(
                        "golden_city.script:{line_no}: `{}` is not a Tool",
                        fields[1]
                    )
                });
                steps.push((
                    line_no,
                    Step::Refuse {
                        tool,
                        x: num(2),
                        y: num(3),
                        stratum: stratum(4),
                    },
                ));
            }
            word => {
                let tool = tool_by_name(word).unwrap_or_else(|| {
                    panic!(
                        "golden_city.script:{line_no}: `{word}` is neither a directive nor a Tool"
                    )
                });
                steps.push((
                    line_no,
                    Step::Apply {
                        tool,
                        x: num(1),
                        y: num(2),
                        stratum: stratum(3),
                    },
                ));
            }
        }
    }

    Script {
        width: width.expect("golden_city.script: no `grid` directive"),
        height: height.expect("golden_city.script: no `grid` directive"),
        seed: seed.expect("golden_city.script: no `seed` directive"),
        steps,
        hash,
    }
}

/// The committed `golden_city.script` only ever spells the trailing stratum
/// token as `underground` or omits it — never `surface` (the default makes
/// it redundant) and never a typo — so the parser's panic arm for an invalid
/// token is otherwise never exercised by the suite. Pin it directly.
#[test]
#[should_panic(expected = "is not a stratum (surface|underground)")]
fn an_invalid_stratum_token_panics() {
    parse_script("grid 4 4\nseed 1\nBulldoze 0 0 sideways\n");
}

// ---------------------------------------------------------------------------
// The replay
// ---------------------------------------------------------------------------

struct Replay {
    sim: Simulation,
    /// One line per `refuse` directive: the command and the message it drew.
    refusals: Vec<String>,
}

fn replay(script: &Script) -> Replay {
    let mut sim = Simulation::new(script.width, script.height, script.seed);
    let mut refusals = Vec::new();

    for &(line_no, step) in &script.steps {
        match step {
            Step::Apply {
                tool,
                x,
                y,
                stratum,
            } => {
                let r = apply_tool(&mut sim.state, tool, x, y, stratum);
                assert!(
                    r.success,
                    "golden_city.script:{line_no}: `{tool:?} {x} {y}` was refused — {}\n\
                     A command the script asserts must work no longer works. Fix the engine \
                     or fix the script; do not regenerate the dump.",
                    r.message.as_deref().unwrap_or("(no message)")
                );
            }
            Step::Refuse {
                tool,
                x,
                y,
                stratum,
            } => {
                let r = apply_tool(&mut sim.state, tool, x, y, stratum);
                assert!(
                    !r.success,
                    "golden_city.script:{line_no}: `refuse {tool:?} {x} {y}` was ACCEPTED.\n\
                     A placement guard has gone. That is a finding, not a stale expectation."
                );
                // Only note the stratum when it's not the (overwhelmingly
                // common) Surface default, so this line's shape — and every
                // pre-existing entry in the committed dump — stays unchanged
                // for directives that don't care about layers.
                let stratum_note = match stratum {
                    ViewStratum::Surface => String::new(),
                    ViewStratum::Underground => " (underground)".to_string(),
                };
                refusals.push(format!(
                    "{tool:?} {x} {y}{stratum_note} -> {}",
                    r.message.as_deref().unwrap_or("(no message)")
                ));
            }
            Step::Tick(n) => {
                for _ in 0..n {
                    sim.step(TICK_DT);
                }
            }
        }
    }

    Replay { sim, refusals }
}

// ---------------------------------------------------------------------------
// The dump
// ---------------------------------------------------------------------------

/// Four decimals, with negative zero folded onto zero so a sign flip in a
/// value that is zero either way cannot show up as a diff.
fn f(v: f32) -> String {
    let v = if v == 0.0 { 0.0 } else { v };
    format!("{v:.4}")
}

/// `Tile::flags`' three derived per-tick bits as a fixed three-character
/// column: `POWERED WATERED ABANDONED`. The three structural bits that used
/// to share this byte (`ROAD_UNDERLAY`/`RAIL_UNDERLAY`/`POWER_OVERLAY`) are
/// gone — `occ` below is the whole story for what stands on a tile now, with
/// no "which spelling won the byte" question left to answer.
fn flag_glyphs(f: u8) -> String {
    const BITS: [(u8, char); 3] = [
        (FLAG_POWERED, 'P'),
        (FLAG_WATERED, 'W'),
        (FLAG_ABANDONED, 'A'),
    ];
    BITS.iter()
        .map(|&(bit, ch)| if f & bit != 0 { ch } else { '-' })
        .collect()
}

fn occupant_list(tile: &Tile) -> String {
    let names: Vec<&str> = iter_set(tile.occupants())
        .map(|o| match o {
            Occupant::Pipe => "Pipe",
            Occupant::Subway => "Subway",
            Occupant::Fibre => "Fibre",
            Occupant::Road => "Road",
            Occupant::Rail => "Rail",
            Occupant::ZoneResidential => "ZoneResidential",
            Occupant::ZoneCommercial => "ZoneCommercial",
            Occupant::ZoneIndustrial => "ZoneIndustrial",
            Occupant::Structure => "Structure",
            Occupant::PowerLine => "PowerLine",
            Occupant::Trees => "Trees",
        })
        .collect();
    if names.is_empty() {
        "-".to_string()
    } else {
        names.join(",")
    }
}

fn dump(script: &Script, r: &Replay) -> String {
    let s = &r.sim.state;
    let mut out = String::with_capacity(64 * 1024);

    out.push_str(
        "# golden_city.expected — everything observable after replaying golden_city.script.\n\
         #\n\
         # GENERATED FILE. Do not hand-edit.\n\
         #   run:        cargo test -p city-sim-core --test golden_city\n\
         #   regenerate: GOLDEN=regen cargo test -p city-sim-core --test golden_city\n\
         #\n\
         # Regeneration is a deliberate act. Every line that moves must be named and\n\
         # justified in the commit message. A diff nobody can explain is a bug report,\n\
         # not a merge — see the module note in tests/golden_city.rs.\n\
         #\n\
         # Tile line format:\n\
         #   tile <index> (<x>,<y>) terrain=<terrain> flags=[PWA] density=<density>\n\
         #       bid=<development> occ=<occupant set>\n\
         # Every field here is canonical tile state — there is no more derived wire\n\
         # byte to dump separately (#177's TS/wire follow-up deleted the projection;\n\
         # the wire now carries `occ`/`terrain`/`density` directly, see `crate::wire`).\n\
         \n",
    );

    writeln!(
        out,
        "script grid={}x{} seed={} ticks={} directives={} script_hash=0x{:016x}",
        script.width,
        script.height,
        script.seed,
        script.ticks(),
        script.directives(),
        script.hash
    )
    .unwrap();

    // --- refusals ----------------------------------------------------------
    out.push_str("\n[refusals]\n");
    for line in &r.refusals {
        writeln!(out, "refuse {line}").unwrap();
    }

    // --- scalars -----------------------------------------------------------
    out.push_str("\n[scalars]\n");
    writeln!(out, "tick {}", s.tick).unwrap();
    writeln!(out, "day {}", s.day).unwrap();
    writeln!(out, "money {}", s.money).unwrap();
    writeln!(out, "population {}", s.population).unwrap();
    writeln!(out, "jobs {}", s.jobs).unwrap();
    writeln!(out, "buildings {}", s.buildings.len()).unwrap();
    writeln!(out, "next_building_id {}", s.next_building_id).unwrap();
    writeln!(out, "tile_revision {}", s.tile_revision).unwrap();
    writeln!(out, "state_hash 0x{:016x}", state_hash(s)).unwrap();

    // --- utilities ---------------------------------------------------------
    out.push_str("\n[utilities]\n");
    writeln!(out, "power {}", s.utilities.power).unwrap();
    writeln!(out, "power_produced {}", s.utilities.power_produced).unwrap();
    writeln!(out, "power_used {}", s.utilities.power_used).unwrap();
    writeln!(out, "water {}", s.utilities.water).unwrap();
    writeln!(out, "water_produced {}", s.utilities.water_produced).unwrap();
    writeln!(out, "water_used {}", s.utilities.water_used).unwrap();

    // --- demand ------------------------------------------------------------
    out.push_str("\n[demand]\n");
    writeln!(out, "residential {}", f(s.demand.residential)).unwrap();
    writeln!(out, "commercial {}", f(s.demand.commercial)).unwrap();
    writeln!(out, "industrial {}", f(s.demand.industrial)).unwrap();

    // --- education ---------------------------------------------------------
    let e = &s.education;
    out.push_str("\n[education]\n");
    writeln!(out, "elementary_served {}", f(e.elementary_served)).unwrap();
    writeln!(out, "elementary_capacity {}", f(e.elementary_capacity)).unwrap();
    writeln!(out, "elementary_load {}", f(e.elementary_load)).unwrap();
    writeln!(out, "elementary_coverage {}", f(e.elementary_coverage)).unwrap();
    writeln!(out, "high_served {}", f(e.high_served)).unwrap();
    writeln!(out, "high_capacity {}", f(e.high_capacity)).unwrap();
    writeln!(out, "high_load {}", f(e.high_load)).unwrap();
    writeln!(out, "high_coverage {}", f(e.high_coverage)).unwrap();
    writeln!(out, "score {}", f(e.score)).unwrap();

    // --- budget — every field, none skipped --------------------------------
    let b = &s.budget;
    out.push_str("\n[budget]\n");
    writeln!(out, "revenue {}", f(b.revenue)).unwrap();
    writeln!(out, "expenses {}", f(b.expenses)).unwrap();
    writeln!(out, "net {}", f(b.net)).unwrap();
    writeln!(out, "net_per_day {}", f(b.net_per_day)).unwrap();
    writeln!(out, "net_per_month {}", f(b.net_per_month)).unwrap();
    writeln!(out, "revenue_base {}", f(b.revenue_base)).unwrap();
    writeln!(out, "revenue_pop {}", f(b.revenue_pop)).unwrap();
    writeln!(out, "revenue_commercial {}", f(b.revenue_commercial)).unwrap();
    writeln!(out, "revenue_industrial {}", f(b.revenue_industrial)).unwrap();
    writeln!(out, "revenue_tourism {}", f(b.revenue_tourism)).unwrap();
    writeln!(out, "expenses_transport {}", f(b.expenses_transport)).unwrap();
    writeln!(out, "expenses_buildings {}", f(b.expenses_buildings)).unwrap();
    writeln!(out, "expenses_policies {}", f(b.expenses_policies)).unwrap();
    writeln!(out, "maint_power {}", f(b.maint_power)).unwrap();
    writeln!(out, "maint_civic {}", f(b.maint_civic)).unwrap();
    writeln!(out, "maint_zones {}", f(b.maint_zones)).unwrap();
    writeln!(out, "maint_roads {}", f(b.maint_roads)).unwrap();
    writeln!(out, "maint_rail {}", f(b.maint_rail)).unwrap();
    writeln!(out, "maint_power_lines {}", f(b.maint_power_lines)).unwrap();
    writeln!(out, "maint_pipes {}", f(b.maint_pipes)).unwrap();
    writeln!(out, "maint_power_hydro {}", f(b.maint_power_hydro)).unwrap();
    writeln!(out, "maint_power_coal {}", f(b.maint_power_coal)).unwrap();
    writeln!(out, "maint_power_wind {}", f(b.maint_power_wind)).unwrap();
    writeln!(out, "maint_power_solar {}", f(b.maint_power_solar)).unwrap();
    writeln!(out, "maint_civic_park {}", f(b.maint_civic_park)).unwrap();
    writeln!(out, "maint_civic_pump {}", f(b.maint_civic_pump)).unwrap();
    writeln!(out, "maint_civic_tower {}", f(b.maint_civic_tower)).unwrap();
    writeln!(out, "maint_civic_school {}", f(b.maint_civic_school)).unwrap();
    writeln!(out, "maint_zones_res {}", f(b.maint_zones_res)).unwrap();
    writeln!(out, "maint_zones_com {}", f(b.maint_zones_com)).unwrap();
    writeln!(out, "maint_zones_ind {}", f(b.maint_zones_ind)).unwrap();

    // --- wilderness — score and the whole breakdown ------------------------
    let w = &s.wilderness;
    out.push_str("\n[wilderness]\n");
    writeln!(out, "score {}", f(w.score)).unwrap();
    writeln!(out, "trend {}", f(w.trend)).unwrap();
    writeln!(out, "fast_ema {}", f(w.fast_ema)).unwrap();
    writeln!(out, "slow_ema {}", f(w.slow_ema)).unwrap();
    writeln!(out, "seeded {}", w.seeded).unwrap();
    writeln!(out, "forests {}", f(w.breakdown.forests)).unwrap();
    writeln!(out, "parks {}", f(w.breakdown.parks)).unwrap();
    writeln!(out, "open_land {}", f(w.breakdown.open_land)).unwrap();
    writeln!(out, "water_edge {}", f(w.breakdown.water_edge)).unwrap();
    writeln!(out, "patch {}", f(w.breakdown.patch)).unwrap();
    writeln!(out, "fragmentation {}", f(w.breakdown.fragmentation)).unwrap();
    writeln!(out, "zones {}", f(w.breakdown.zones)).unwrap();
    writeln!(out, "industry {}", f(w.breakdown.industry)).unwrap();
    writeln!(out, "transport {}", f(w.breakdown.transport)).unwrap();
    writeln!(out, "power {}", f(w.breakdown.power)).unwrap();
    writeln!(out, "civic {}", f(w.breakdown.civic)).unwrap();

    // --- buildings ---------------------------------------------------------
    let mut buildings: Vec<&BuildingInstance> = s.buildings.iter().collect();
    buildings.sort_by_key(|b| b.id);
    out.push_str("\n[buildings]\n");
    for b in buildings {
        writeln!(
            out,
            "building {:<4} {:<17} at ({:>2},{:>2}) {:<16} health={:<3} trouble={}",
            b.id,
            format!("{:?}", b.kind),
            b.origin.0,
            b.origin.1,
            format!("{:?}", b.status),
            b.health,
            f(b.trouble_ticks)
        )
        .unwrap();
    }

    // --- tiles -------------------------------------------------------------
    out.push_str("\n[tiles]\n");
    for (idx, tile) in s.tiles.iter().enumerate() {
        let (x, y) = s.index_to_xy(idx);
        writeln!(
            out,
            "tile {idx:<5} ({x:>2},{y:>2}) terrain={terrain:<5} flags=[{glyphs}] density={density:<6} bid={bid:<5} occ={occ}",
            terrain = format!("{:?}", tile.terrain),
            glyphs = flag_glyphs(tile.flags),
            density = format!("{:?}", tile.density),
            bid = tile
                .building_id
                .map_or_else(|| "-".to_string(), |b| b.to_string()),
            occ = occupant_list(tile),
        )
        .unwrap();
    }

    out
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

fn expected_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/golden_city.expected")
}

/// Report the first handful of differing lines rather than two 400-line blobs.
fn diff_report(got: &str, want: &str) -> String {
    let g: Vec<&str> = got.lines().collect();
    let w: Vec<&str> = want.lines().collect();
    let mut report = String::new();
    let mut shown = 0;
    let mut total = 0;
    for i in 0..g.len().max(w.len()) {
        let (a, b) = (g.get(i).copied(), w.get(i).copied());
        if a == b {
            continue;
        }
        total += 1;
        if shown < 20 {
            let _ = writeln!(report, "  line {}:", i + 1);
            let _ = writeln!(report, "    want: {}", b.unwrap_or("<missing>"));
            let _ = writeln!(report, "    got:  {}", a.unwrap_or("<missing>"));
            shown += 1;
        }
    }
    if total > shown {
        let _ = writeln!(report, "  … and {} further differing lines", total - shown);
    }
    let _ = writeln!(report, "  {total} lines differ in total");
    report
}

#[test]
fn the_golden_city_matches_the_committed_dump() {
    let script = parse_script(SCRIPT);
    let r = replay(&script);
    let got = dump(&script, &r);

    if std::env::var("GOLDEN").as_deref() == Ok("regen") {
        std::fs::write(expected_path(), &got).expect("write golden_city.expected");
        eprintln!(
            "\n*** golden_city.expected REGENERATED ***\n\
             This is a deliberate act. `git diff` it, name every observable that moved,\n\
             and justify each in the commit message. If you cannot explain a line, you\n\
             have found a bug — do not commit the regeneration.\n"
        );
        return;
    }

    if got == EXPECTED {
        return;
    }

    // A changed script is the commonest cause and deserves its own message —
    // otherwise it reads as several hundred unrelated tile regressions.
    let stale_script = EXPECTED
        .lines()
        .find(|l| l.starts_with("script "))
        .is_some_and(|l| !l.contains(&format!("script_hash=0x{:016x}", script.hash)));

    let preamble = if stale_script {
        "golden_city.script has changed since golden_city.expected was cut.\n\
         If the change was intended, regenerate:\n\
           GOLDEN=regen cargo test -p city-sim-core --test golden_city\n\
         and justify the resulting diff in the commit message.\n"
    } else {
        "The golden city no longer dumps what it dumped when this expectation was cut,\n\
         and the script is unchanged — so the ENGINE moved. Read the diff before you\n\
         reach for GOLDEN=regen: a wrong derivation and a stale expectation look\n\
         identical from here, and only one of them should be fixed by regenerating.\n"
    };

    panic!("\n{preamble}\n{}", diff_report(&got, EXPECTED));
}

#[test]
fn the_golden_city_is_deterministic() {
    let script = parse_script(SCRIPT);
    let first = dump(&script, &replay(&script));
    let second = dump(&script, &replay(&script));
    assert_eq!(
        first.len(),
        second.len(),
        "two replays of the same seeded script produced dumps of different length"
    );
    if first != second {
        panic!(
            "two replays of the same seeded script disagree — the sim is not \
             deterministic:\n{}",
            diff_report(&second, &first)
        );
    }
}

// ---------------------------------------------------------------------------
// Coverage — the script must still build the states this architecture is about
// ---------------------------------------------------------------------------

/// Every tool applied at `(x, y)`, in script order. Refusals are excluded:
/// they change nothing.
fn tool_history(script: &Script) -> BTreeMap<(u32, u32), Vec<Tool>> {
    let mut history: BTreeMap<(u32, u32), Vec<Tool>> = BTreeMap::new();
    for &(_, step) in &script.steps {
        if let Step::Apply { tool, x, y, .. } = step {
            history.entry((x, y)).or_default().push(tool);
        }
    }
    history
}

/// Does some tile carry this exact run of tools, back to back?
///
/// Build order is the whole question for half the cases below — a crossing
/// built road-last and one built rail-last are the same tile afterwards — so
/// coverage for those has to be asked of the *script*, not of the final state.
fn some_tile_saw(history: &BTreeMap<(u32, u32), Vec<Tool>>, run: &[Tool]) -> bool {
    history
        .values()
        .any(|applied| applied.windows(run.len()).any(|w| w == run))
}

/// Every tool that stamps a footprint building, with the footprint it stamps.
///
/// Learned by asking the engine — place the tool on an empty map and read the
/// template behind whatever building appears — rather than by restating a
/// `Tool → TileKind` table here. A table would be the third copy of that mapping
/// in the tree and the only one nothing checks, so it would go stale silently and
/// take the coverage assertion below quietly with it. Tools that build nothing
/// (the zones, the carriageways, the brushes) simply do not appear.
fn footprint_tools() -> Vec<(Tool, (u32, u32))> {
    let mut out = Vec::new();
    for tool in (0u8..=u8::MAX).filter_map(|v| Tool::try_from(v).ok()) {
        let mut s = GameState::new(8, 8, 1);
        s.money = 10_000_000;
        if !apply_tool(&mut s, tool, 2, 2, ViewStratum::Surface).success {
            continue;
        }
        // A zone tool writes a tag and no building; only a footprint stamp does.
        if let Some(b) = s.buildings.first() {
            if let Some(t) = city_sim_core::buildings::get_building_template(b.kind) {
                out.push((tool, t.footprint));
            }
        }
    }
    out
}

/// Did one bulldozer click clear a **multi-tile** footprint from somewhere other
/// than its origin?
///
/// This case cannot be asked of [`some_tile_saw`], and that is the whole reason
/// it needs its own walk: `tool_history` keys runs by `(x, y)`, and the case
/// spans two tiles by definition — the stamp lands on the origin and the click
/// lands somewhere else inside the rect — so no per-tile run of tools can ever
/// express it. Nor can it be asked of the replayed city, because what has to be
/// pinned is that the *whole rect* went, and afterwards there is nothing left to
/// look at.
///
/// So the script is walked in order, tracking each live footprint rect, and a
/// `Bulldoze` landing inside one is matched to it. Returns the rect it cleared.
fn a_footprint_cleared_off_origin(script: &Script) -> Option<((u32, u32), (u32, u32))> {
    let footprints = footprint_tools();
    // Live rects, most recently stamped last: `(origin, (width, height))`.
    let mut live: Vec<((u32, u32), (u32, u32))> = Vec::new();
    for &(_, step) in &script.steps {
        let Step::Apply { tool, x, y, .. } = step else {
            continue;
        };
        if let Some(&(_, footprint)) = footprints.iter().find(|(t, _)| *t == tool) {
            live.push(((x, y), footprint));
            continue;
        }
        if tool != Tool::Bulldoze {
            continue;
        }
        let hit = live
            .iter()
            .position(|&((ox, oy), (w, h))| x >= ox && x < ox + w && y >= oy && y < oy + h);
        if let Some(i) = hit {
            let (origin, footprint) = live.remove(i);
            if footprint != (1, 1) && (x, y) != origin {
                return Some((origin, footprint));
            }
        }
    }
    None
}

#[test]
fn the_golden_city_still_covers_every_awkward_state() {
    use Tool::*;
    let script = parse_script(SCRIPT);
    let history = tool_history(&script);

    // --- build-order cases, asked of the script ---------------------------
    let orders: &[(&str, &[Tool])] = &[
        ("a level crossing built rail-last", &[Road, Rail]),
        ("a level crossing built road-last", &[Rail, Road]),
        ("a hydro line strung over a road", &[Road, PowerLine]),
        ("a road laid under a hydro line", &[PowerLine, Road]),
        ("a hydro line strung over a rail", &[Rail, PowerLine]),
        ("a hydro line strung over a zone", &[Commercial, PowerLine]),
        ("a zone drawn under a hydro line", &[PowerLine, Commercial]),
        ("trees planted through a live line", &[PowerLine, Tree]),
        ("water brushed over a live line", &[PowerLine, Water]),
        // The whole three-tool run, not just the first two: the fixtures README
        // and `docs/testing.md` both promise the pipe, so the pipe is asserted.
        (
            "a line demoted to its flag by a regrade, with a pipe under it",
            &[PowerLine, TerraformRaise, WaterPipe],
        ),
        ("a pipe buried under a road", &[Road, WaterPipe]),
        ("water brushed over a buried pipe", &[WaterPipe, Water]),
        ("a 1×1 structure razed (the v4 ghost)", &[Park, Bulldoze]),
        (
            "a lake paved and the pavement razed",
            &[Water, Road, Bulldoze],
        ),
        // #198: a surface bulldoze takes the road and leaves the pipe, then
        // an underground bulldoze on the same tile takes the pipe. (The
        // bulldozed-lake case above moved from this list to the refusals
        // check below — since #198, bulldozing bare open water is refused,
        // not a successful Apply, so it can no longer appear in a tool
        // history built from `Step::Apply` alone.)
        (
            "#198: a surface bulldoze leaves a buried pipe, an underground one takes it",
            &[Road, WaterPipe, Bulldoze, Bulldoze],
        ),
    ];
    for (what, run) in orders {
        assert!(
            some_tile_saw(&history, run),
            "golden_city.script no longer builds {what} ({run:?}). \
             Restore the case — the dump is only worth what the script covers."
        );
    }

    // --- structural cases, asked of the replayed city ---------------------
    let r = replay(&script);

    // A bulldozed lake is still a lake (`#177` step 4) — and since `#198`
    // open water carries nothing in any stratum, the click is refused rather
    // than silently doing nothing. `tool_history` only sees `Step::Apply`, so
    // this one has to be asked of the refusals instead of `orders` above.
    assert!(
        r.refusals
            .iter()
            .any(|line| line.starts_with("Bulldoze 1 9 ->")),
        "golden_city.script no longer refuses a bulldoze on bare open water — \
         restore `refuse Bulldoze 1 9`."
    );
    // #198: with nothing left in either stratum, a third click on the (20,13)
    // scenario tile is refused too, charging nothing.
    assert!(
        r.refusals
            .iter()
            .any(|line| line.starts_with("Bulldoze 20 13 (underground) ->")),
        "golden_city.script no longer refuses the empty-stratum bulldoze at \
         the end of the #198 scenario — restore `refuse Bulldoze 20 13 underground`."
    );

    let s = &r.sim.state;
    let lookup = StructureLookup::new(s);

    /// "Some tile in the city looks like this" — a named shape the golden
    /// city must still contain, whatever build order produced it.
    type Shape<'a> = (&'a str, &'a dyn Fn(&Tile) -> bool);

    let any = |pred: &dyn Fn(&Tile) -> bool| s.tiles.iter().any(pred);

    let structural: &[Shape] = &[
        ("a level crossing", &|t: &Tile| {
            t.has_occupant(Occupant::Road) && t.has_occupant(Occupant::Rail)
        }),
        ("a line over a road", &|t: &Tile| {
            t.has_occupant(Occupant::Road)
                && t.has_occupant(Occupant::PowerLine)
                && !t.has_occupant(Occupant::Rail)
        }),
        ("a line over a rail", &|t: &Tile| {
            t.has_occupant(Occupant::Rail)
                && t.has_occupant(Occupant::PowerLine)
                && !t.has_occupant(Occupant::Road)
        }),
        ("a line over a level crossing", &|t: &Tile| {
            t.has_occupant(Occupant::Road)
                && t.has_occupant(Occupant::Rail)
                && t.has_occupant(Occupant::PowerLine)
        }),
        ("a vacant zone carrying a line", &|t: &Tile| {
            t.zone_occupant().is_some()
                && t.has_occupant(Occupant::PowerLine)
                && t.building_id.is_none()
        }),
        ("a DEVELOPED lot carrying a line", &|t: &Tile| {
            t.zone_occupant().is_some()
                && t.has_occupant(Occupant::PowerLine)
                && t.building_id.is_some()
        }),
        ("a bare hydro line on open ground", &|t: &Tile| {
            t.occupants() == (1 << Occupant::PowerLine as u16) && t.terrain == Terrain::Land
        }),
        ("trees standing under a live line", &|t: &Tile| {
            t.has_occupant(Occupant::Trees) && t.has_occupant(Occupant::PowerLine)
        }),
        ("water carrying a live line", &|t: &Tile| {
            t.terrain == Terrain::Water && t.has_occupant(Occupant::PowerLine)
        }),
        ("a pipe under a road", &|t: &Tile| {
            t.has_occupant(Occupant::Pipe) && t.has_occupant(Occupant::Road)
        }),
        ("a lone pipe with nothing above it", &|t: &Tile| {
            t.occupants() == (1 << Occupant::Pipe as u16)
        }),
        ("a pipe under water", &|t: &Tile| {
            t.has_occupant(Occupant::Pipe) && t.terrain == Terrain::Water
        }),
        ("a lake left standing", &|t: &Tile| {
            t.terrain == Terrain::Water && t.occupants() == 0
        }),
        // A hydro line demoted by a regrade *and* carrying a pipe. The build
        // order is pinned above; this pins the tile the order produced, which is
        // the half a script walk cannot see.
        ("a demoted hydro line with a pipe under it", &|t: &Tile| {
            t.has_occupant(Occupant::Pipe)
                && t.has_occupant(Occupant::PowerLine)
                && t.terrain == Terrain::Land
        }),
        // An abandoned lot: the zone tag survives, the development does not, and
        // `ABANDONED` is standing. This is the one state in the gallery the
        // *simulation* produces rather than the script — no directive can ask
        // for it — so it is also the one most likely to vanish unnoticed if the
        // decay parameters or the run length move.
        ("an abandoned lot", &|t: &Tile| {
            t.zone_occupant().is_some() && t.building_id.is_none() && t.flags & FLAG_ABANDONED != 0
        }),
    ];
    for (what, pred) in structural {
        assert!(
            any(pred),
            "the replayed golden city no longer contains {what}. Either the script \
             stopped building it or the engine stopped producing it — check which \
             before touching the dump."
        );
    }

    // 1×1 and 2×2 footprints, both present and both stamped over their whole area.
    let footprints: Vec<(u32, u32)> = s
        .buildings
        .iter()
        .filter_map(|b| {
            city_sim_core::buildings::get_building_template(b.kind).map(|t| t.footprint)
        })
        .collect();
    assert!(
        footprints.contains(&(1, 1)),
        "no 1×1 footprint building in the golden city"
    );
    assert!(
        footprints.contains(&(2, 2)),
        "no 2×2 footprint building in the golden city"
    );

    // One click anywhere inside a multi-tile footprint clears the whole thing.
    let cleared = a_footprint_cleared_off_origin(&script);
    assert!(
        cleared.is_some(),
        "golden_city.script no longer bulldozes a multi-tile footprint from a tile \
         other than its origin. Restore the case — a 1×1 raze and a 2×2 raze go \
         down different paths in `remove_building`, and only the second one proves \
         the click does not have to find the origin."
    );
    let ((ox, oy), (w, h)) = cleared.expect("checked just above");
    for dy in 0..h {
        for dx in 0..w {
            let idx = s.tile_index(ox + dx, oy + dy).expect("in bounds");
            let t = &s.tiles[idx];
            assert!(
                !t.has_occupant(Occupant::Structure) && t.building_id.is_none(),
                "({},{}) still carries part of the {w}×{h} footprint stamped at \
                 ({ox},{oy}) after one bulldozer click inside it — the raze cleared \
                 the tile that was clicked and left the rest of the rect standing",
                ox + dx,
                oy + dy
            );
        }
    }

    // A power source deliberately left off the network, and one deliberately on
    // it. The isolated plant is ordinary play — a turbine dropped in a field —
    // and its wilderness penalty still counts, so the dump has to keep showing
    // it doing exactly that and no more. "Off the network" is asked as *nothing
    // adjacent to the footprint conducts power*, because a plant's own tiles
    // always read `POWERED`: `Tile::conducts` is true for anything with a
    // `building_id`, so a footprint is always its own conductor.
    let plants: Vec<&BuildingInstance> = s
        .buildings
        .iter()
        .filter(|b| {
            city_sim_core::buildings::get_building_template(b.kind)
                .is_some_and(|t| t.is_power_plant)
        })
        .collect();
    let connected = |b: &BuildingInstance| -> bool {
        let (w, h) = city_sim_core::buildings::get_building_template(b.kind)
            .expect("a plant has a template")
            .footprint;
        let (ox, oy) = b.origin;
        for dy in 0..h {
            for dx in 0..w {
                let (x, y) = (ox + dx, oy + dy);
                for (nx, ny) in [
                    (x.wrapping_sub(1), y),
                    (x + 1, y),
                    (x, y.wrapping_sub(1)),
                    (x, y + 1),
                ] {
                    let Some(idx) = s.tile_index(nx, ny) else {
                        continue;
                    };
                    // Its own footprint conducts by definition; skip it.
                    if s.tiles[idx].building_id == Some(b.id as u16) {
                        continue;
                    }
                    if s.tiles[idx].conducts(Network::Power) {
                        return true;
                    }
                }
            }
        }
        false
    };
    assert!(
        plants.iter().any(|b| !connected(b)),
        "every power plant in the golden city is wired to something. The script is \
         supposed to leave one deliberately off the network — an isolated source \
         that still carries its wilderness penalty — and both the fixtures README \
         and docs/testing.md say so."
    );
    assert!(
        plants.iter().any(|b| connected(b)),
        "no power plant in the golden city reaches the grid, so the isolated one \
         above is not a contrast with anything. The city is supposed to have both."
    );

    // --- the invariants the strata are supposed to make unrepresentable ---
    for (idx, t) in s.tiles.iter().enumerate() {
        let (x, y) = s.index_to_xy(idx);
        if t.has_occupant(Occupant::Structure) {
            assert!(
                t.building_id.is_some(),
                "({x},{y}) carries Occupant::Structure with no development behind it — \
                 that is the v4 ghost, and it is supposed to be unrepresentable"
            );
        }
        if let Some(bid) = t.building_id {
            assert!(
                s.buildings.iter().any(|b| b.id == bid as u32),
                "({x},{y}) points at building {bid}, which is not in state.buildings"
            );
        }
        // A structure tile must resolve to a real structure kind, or a
        // consumer resolving `Occupant::Structure` to a `TileKind` (the
        // renderer, the wire's legacy exporter) silently falls through.
        if t.has_occupant(Occupant::Structure) {
            assert!(
                lookup.structure_kind(t).is_some(),
                "({x},{y}) is a structure whose kind cannot be resolved"
            );
        }
    }

    // Build-order independence for a level crossing — the delta that moved a
    // minimap pixel during #177 — no longer needs a dedicated check here: a
    // union of occupant bits is commutative, so two tiles built in opposite
    // orders producing the same `occupants()` is now a fact about how a set
    // works, not a behaviour a script has to exercise and a test has to catch
    // regressing. The `orders` assertions above already require the script to
    // build a crossing both ways; there is nothing left to compare it against.
}

/// The dump has to actually contain what it promises, or a silently truncated
/// section would pass every diff for ever.
#[test]
fn the_dump_has_a_line_for_every_tile_and_every_section() {
    let script = parse_script(SCRIPT);
    let text = dump(&script, &replay(&script));
    for section in [
        "[refusals]",
        "[scalars]",
        "[utilities]",
        "[demand]",
        "[education]",
        "[budget]",
        "[wilderness]",
        "[buildings]",
        "[tiles]",
    ] {
        assert!(text.contains(section), "the dump is missing {section}");
    }
    let tiles = text.lines().filter(|l| l.starts_with("tile ")).count();
    assert_eq!(
        tiles as u32,
        script.width * script.height,
        "one line per tile, and no more"
    );
    assert!(
        text.lines().any(|l| l.starts_with("state_hash ")),
        "the dump must carry the state hash"
    );
}
