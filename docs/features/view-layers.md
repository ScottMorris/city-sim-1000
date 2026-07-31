# View Layers — Strata and Overlays as First-Class State

**Status:** implemented, client-side (#197 — `ViewStratum`/`MinimapOverlay` split, tool-implied switching, the tool/stratum click-guard, and the HUD stratum badge). The engine never hears about the stratum yet: `SimCommand::ApplyTool` still has no `stratum` field, so the bulldozer stays view-blind in Rust. That wire-up is `layer-scoped-bulldozer.md`'s job (#198), which depends on the model defined here.

## Purpose

Give the game an explicit, durable answer to "what is the player looking at, and what may their tools touch?" Today that answer is smeared across a minimap setting, a tool auto-switch, and an engine comment that assumes an invariant nobody enforces. This document separates the two ideas that are currently conflated and promotes them to first-class app state, so that every current and future layer-dependent rule (bulldozing, pipe laying, subway, fibre) hangs off one well-defined enum instead of a cosmetic preference.

## The two axes (and how they got conflated)

`MinimapMode` (`app/src/game/gameState.ts:67`) is one enum with seven values: `base | power | water | alerts | education | wilderness | underground`. Six of those are **data overlays** — read-only diagnostic filters painted over the same world. The seventh, `underground`, is categorically different: it is an **edit stratum** — it changes what the main renderer draws *and* what tools should be allowed to touch. It ended up inside the minimap settings only because the minimap is where the mode chips live, and "minimap setting" sounds cosmetic — which is exactly why it stayed client-side and the engine never heard about it, producing the bulldozer regression.

Genre precedent is unambiguous that these are two independent axes (survey: SimCity 2000/3000/4, SimCity 2013, Cities: Skylines 1/2, OpenTTD, Workers & Resources, Timberborn, Factorio):

* **Edit stratum** is first-class mode state, and the genre flipped polarity on how it's entered. Classic titles used an explicit toggle (SC2000's Show Underground button, SC3000's Layers button, Workers & Resources' F3 editor mode). From SimCity 4 onward, **selecting a stratum-bound tool switches the view automatically** — SC4's subway/pipe tools force the Underground View (built-in and unconditional), and C:S1's water-pipe tool auto-activates the underground view the same way. The explicit toggle survives where tool selection is ambiguous about stratum — most notably the **bulldozer** (C:S1's underground-bulldozing toggle, added in patch 1.7.0 because tunnels were previously undeletable; C:S2's whole-view Underground Mode, surface greyed, underground outlined).
* **Data overlays** are a separate system in every game studied — SimCity's query/graph windows and Data Views, C:S Info Views, SimCity 2013's data layers. They answer "show me X about the city" and never gate what tools may touch. Auto-*opening* a relevant overlay on tool selection (C:S2's "associated info views" rule, SimCity 2013 throughout) is established and fine *because* they are read-only.
* The anti-patterns, each remembered as a bug or design flaw: cross-layer leakage (SC3000 terraforming silently destroys unseen subways/pipes — its manual literally warns players to check the underground view after terraforming; SC4 hybrid objects need bulldozing in *both* views to fully clear); overlays that quietly grant edit power (C:S1 lets you bulldoze pipes from inside the read-only Water/Heating info views — a perennial source of player confusion); and mode state that isn't loudly visible (Timberborn players demolish the wrong things while a layer view is active, and an on-screen active-layer warning is a standing feature request). Our view-blind `bulldoze()` is the first family of bug; the invariant every one of these violates is *the demolition tool never destroys what the player cannot currently see*.

## Proposed model

### Axis 1 — `ViewStratum` (edit scope; first-class, sticky, on the wire when it matters)

```
ViewStratum = 'surface' | 'underground'
```

* **`surface`** (default): the renderer draws the world normally; tools edit the surface **and overhead** strata. Overhead is deliberately part of the surface view — power lines are placed, seen, and bulldozed from it. Views map to *sets* of strata; they are not 1:1 with the tile model's three occupant sets.
* **`underground`**: surface dims (current behaviour), underground occupants render; tools edit the underground stratum only.
* Extensible: a future subway ships either as another occupant in the one underground view (the tile model already reserves `Occupant::Subway` and `Occupant::Fibre`) or, if depth separation earns its keep, as further values (`'underground-transit'`). No above-ground strata are anticipated — aircraft and similar are animation entities, not map state, and never enter this model.
* Lives in **app state, not minimap settings** — a top-level field alongside the active tool (owned by `main.ts`, like camera state), not persisted into `ClientState` with cosmetic preferences. Whether it should persist across sessions at all is a UX choice; the default answer is no (always start at surface), which also sidesteps save-migration.
* **Crosses the wire per command**, not as ambient engine state: `ApplyTool` gains a `stratum` field (see `layer-scoped-bulldozer.md`). The engine stays a pure function of its command stream — replay, parity, and undo remain exact — while honouring the rule that a command only touches the stratum it names.

### Axis 2 — `MinimapOverlay` (read-only; stays a minimap/client setting)

```
MinimapOverlay = 'base' | 'power' | 'water' | 'alerts' | 'education' | 'wilderness'
```

* Purely diagnostic; never gates tools. Selecting the `water` overlay from the surface view shows pipe reach tint — it reveals, it does not make underground editable. The bulldozer's scope follows `ViewStratum` alone.
* Orthogonal by construction: any overlay is meaningful in either stratum view (the water overlay is arguably *most* useful while underground).

### Entry points for the underground stratum

Both current affordances are kept, now writing the new state. **Tool-implied switching is a first-class pattern here, deliberately preserved** — not merely sugar on the toggle:

1. **Tool-implied** (primary): selecting a tool implies the stratum it edits, and the view follows — the pipe tool takes you underground (today's `main.ts:1178-1189` behaviour), a surface tool brings you back. This is the established genre pattern from SimCity 4 onward (subway/pipe tools force the Underground View) through Cities: Skylines (pipe tool auto-activates the underground view). The invariant it buys is the one this whole document exists for: *the player is always looking at the layer their active tool edits.* The bulldozer is the deliberate exception: it never implies a stratum, it inherits whichever one is active — that is what makes it layer-scoped. (Genre alternative considered: C:S gives the bulldozer its own underground toggle instead — but C:S needs that because it has no ambient stratum state at all outside the bulldozer; we already have the ambient state, and bulldoze-follows-view is the SC2000/SC4 lineage. One tool, no extra toggle.)
2. **Explicit toggle** (complement): the current minimap "Underground" chip becomes a stratum toggle (visually distinct from the overlay chips), and deserves a hotkey — for inspecting, bulldozing underground, and any future workflow where no stratum-implying tool is in hand. A persistent on-screen indicator (e.g. HUD badge, plus the existing surface dimming) must make the active stratum unmistakable, since it determines what the bulldozer destroys.

The two compose into one rule: **tools with a home stratum set the stratum; stratum-neutral tools (bulldoze, inspect) follow it.**

### Rules the model must enforce (currently unenforced or leaky)

* **Bulldozer follows the stratum** — the headline defect; see `layer-scoped-bulldozer.md`.
* **Surface tools while underground**: **resolved, but not as recommended below.** Tool *selection* still flips the view (unchanged, existing behaviour) — but for the gap this bullet was really about, a tool already armed before the player manually toggles the view away, discussion landed on refusal instead: `main.ts`'s `applyCurrentTool` checks `requiredStratumForTool(activeTool)` against the live `ViewStratum` and refuses the click with a toast hint if they've drifted apart, rather than snapping the view back or deselecting the tool. Right-button quick-bulldoze is unaffected either way — `Bulldoze`'s required stratum is `null`, so it never trips the guard, which is the point of it being stratum-neutral.
* **Pipe tool from the surface**: closed by the same guard — `Tool::WaterPipe` requires `underground`, so a click after manually flipping back to base is refused rather than silently landing on an invisible layer. `SPEC.md`'s "Requires Underground View" is now an enforced client-side rule, not just an auto-switch side effect.
* **No cross-stratum side effects, stated as an invariant**: still open. (Terraforming destroying unseen pipes is SC3000's most-warned-about behaviour; if terrain edits ever need to disturb pipes, that must be visible and deliberate, not incidental.) This belongs in `docs/tile-model.md` beside the bulldozer rule, and in engine tests — tracked with the rest of the engine-side wiring in `layer-scoped-bulldozer.md`/#198, since it's a Rust-side rule.

## Known bugs fixed in passing

* `app/src/game/clientState.ts`'s minimap-mode sanitiser allow-list was missing `'wilderness'`, so a save made in wilderness overlay mode silently reset to `base` on load. Fixed: `MINIMAP_OVERLAYS` (`gameState.ts`) is now the one list both `clientState.ts`'s sanitiser and `minimap.ts`'s chip set read.
* `app/src/ui/hud.ts`'s dead "Coming soon: pipes and underground view." branch (`ToolDetails.unavailable` was declared but never assigned) is removed, replaced by the loud stratum badge described above.

## Migration — what shipped

1. ✅ `ViewStratum` is `main.ts` app state, module-level alongside the active tool.
2. ✅ `MinimapMode` split into `MinimapOverlay` (six values) + `ViewStratum`; `ClientState` never persists stratum (a save's old `mode: 'underground'` key just has no `overlay` field to migrate — the default wins).
3. ✅ Renderer/minimap take `(stratum, overlay)` instead of one `overlayMode` string.
4. ✅ Tool/view consistency guards (see above). ❌ **Not done**: wiring `stratum` into `ApplyTool` itself — the engine stays view-blind. That's `layer-scoped-bulldozer.md`/#198, unstarted.
5. ✅ `docs/tile-model.md`, `SPEC.md`, and `app/public/manual.html` updated to describe the two-axis model.

## Non-goals

* New overlays, new strata, or subway/fibre gameplay — this defines the frame they will land in, nothing more.
* Moving overlay rendering into the engine; overlays remain a pure client concern.
* An "overhead" view — overhead is edited from the surface view by design.
