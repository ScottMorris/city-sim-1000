# Mobile Web — Execution Map (Task Breakdown)

**Scope:** a touch-friendly, offline-capable mobile web version of City Sim 1000,
shipped as the existing PWA — **no Tauri work required**. Everything here runs in the
browser and carries forward unchanged into a future Tauri Android build (same webview
code; bridge selection is already a runtime decision in `main.ts`). iOS is explicitly
out of scope for now; Tauri supports it, so it can be added later once Android works.

> **How to use this:** Work top-to-bottom within a phase; respect `deps`. Each task has
> a **DoD** (definition of done) that must be green before checking it. Task IDs
> (`M0-1`…) are stable so this doc can be mechanically promoted to a GitHub epic +
> sub-issues later.

**Legend:** `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked
**Global gate:** every task ends green on `bun run test` and `bun run lint`.

**Guiding decisions (settled):**
- **Capability detection, not UA sniffing.** Two independent axes: *input mode*
  (touch vs. mouse — `(pointer: coarse)` / `navigator.maxTouchPoints`) and *layout
  mode* (compact vs. full — viewport dimensions). A tablet gets full layout with
  touch-sized targets; a desktop touchscreen gets full layout with touch gestures.
- **Both portrait and landscape are supported.** No orientation lock, no nudge
  prompt — the compact layout must work in both.
- **Autosave is a cross-platform feature**, not a mobile-only one. Desktop browser
  sessions currently lose unsaved progress too; fix it once for everyone.
- **Radio is off by default.** Audio work is gated on the user enabling it; radio
  assets must never be part of the offline precache.

---

## Phase M0 — Detection + viewport foundations
*Goal: the app knows what it's running on and renders correctly inside mobile browser
chrome. No visible UI changes on desktop.*

- [x] **M0-0 · Test prep: persistence back-fill + camera math unit tests.** The mobile
  work refactors exactly the untested areas. Before touching them: `persistence.test.ts`
  covering `deserialize` back-fill behaviour (old saves gain new settings fields with
  defaults — M0-2 relies on this), and `camera.ts` unit tests for screen↔tile
  conversion and zoom-about-a-point (the maths M1-2's pinch-zoom builds on).
  `deps:` none.
  **DoD:** a save predating a known settings field deserializes with the default
  applied; camera round-trip and zoom-anchor invariants covered; both suites green.
- [x] **M0-1 · Input/layout mode detection module.** `src/ui/deviceMode.ts` (or
  similar): derives `inputMode: 'touch' | 'mouse'` from `(pointer: coarse)` +
  `maxTouchPoints`, and `layoutMode: 'compact' | 'full'` from viewport dimensions
  (media query / `ResizeObserver`); emits change events (rotation, window resize,
  mouse plugged into a tablet). `deps:` none.
  **DoD:** unit tests cover the derivation matrix; modes re-evaluate live on viewport
  and pointer-capability changes. (#92)
- [x] **M0-2 · Settings override + dev param.** `ui: 'auto' | 'desktop' | 'mobile'`
  setting (auto = M0-1 detection) with a `createDefault*` factory in `gameState.ts`,
  back-fill in `persistence.deserialize`, and a control in the settings modal.
  `?ui=mobile|desktop` query param forces a mode for dev testing (same pattern as
  `?bridge=tauri`). `deps:` M0-1.
  **DoD:** old saves load with the field defaulted; the query param wins over the
  setting; `bun run lint` clean. (#93)
- [x] **M0-3 · Viewport meta + safe areas.** Add `viewport-fit=cover` to the viewport
  meta in `index.html`; pad HUD/toolbar with `env(safe-area-inset-*)`; replace any
  `100vh`-style sizing with `dvh`/`svh` or `visualViewport` so the layout survives
  the mobile address bar showing/hiding. `deps:` none.
  **DoD:** in standalone PWA mode on a notched phone, no controls sit under the
  notch/home bar; toggling browser chrome doesn't leave dead space or clipped UI. (#89)
- [x] **M0-4 · Suppress competing browser gestures.** `touch-action: none` on the
  canvas wrapper, `overscroll-behavior: none` (kills pull-to-refresh mid-pan),
  `user-select: none` + context-menu suppression on HUD chrome, and an edge inset so
  painting near screen edges doesn't fight Android's back-swipe gesture. `deps:` none.
  **DoD:** on-device: pull-to-refresh, double-tap zoom, long-press text selection,
  and accidental back-navigation no longer trigger during play. (#89)
- [x] **M0-5 · Resize contract hardening.** Pixi already uses `resizeTo`; make the
  toolbar-height CSS variables (`--toolbar-base-height` etc., measured in `main.ts`)
  re-measure on viewport resize and layout-mode changes, including rotation.
  `deps:` M0-1. **DoD:** rotating portrait↔landscape mid-game leaves camera, HUD,
  and toolbar layout correct in both orientations with no reload. (#94)

## Phase M1 — Touch input
*Goal: the game is fully playable with fingers. Desktop mouse behaviour unchanged;
desktop touchscreens get these gestures for free (input handling is already
PointerEvents in `main.ts`).*

- [x] **M1-1 · Gesture disambiguation: one finger = tool, two fingers = pan/zoom.**
  In touch input mode, single-pointer tap/drag drives the active tool (as drag-paint
  does today); a second pointer cancels any in-progress paint and switches to
  camera control. `deps:` M0-1.
  **DoD:** starting a two-finger gesture mid-paint never leaves stray tiles (the
  in-flight paint is undone or never committed); mouse path untouched. (#67, #96)
- [x] **M1-2 · Pinch-zoom + two-finger pan.** Track two active pointers; scale the
  camera around the gesture midpoint, pan with the midpoint delta. Respect the
  existing `zoomSensitivity` setting. `deps:` M1-1.
  **DoD:** pinch keeps the point under the fingers stationary (no drift); wheel zoom
  on desktop unchanged. (#68, #97)
- [x] **M1-3 · Tap slop + touch-appropriate defaults.** A small movement tolerance so
  a slightly-moving finger registers as a tap, not a one-tile drag-paint; deeper
  default camera zoom on compact layouts so tiles are finger-sized. `deps:` M1-1.
  **DoD:** on-device, single-tile placement is reliable at default zoom; slop does
  not affect mouse input. (#69, #98)
- [ ] **M1-4 · Hover replacement.** Hovered-tile preview, tooltips, and `toolInfo`
  hover details don't exist on touch — surface the equivalent via tap feedback
  (e.g. tile inspect on tap with an inspect tool, tool details shown in the picker,
  M2-2). `deps:` M1-1, M2-2.
  **DoD:** every piece of information currently reachable only by hover has a touch
  path; documented in the manual.

## Phase M2 — Compact UI shell
*Goal: tools get out of the way on small screens. The compact layout is a different
shell around the same `toolbar.ts` tool groups and callbacks — not a fork that drifts
when tools are added.*

- [x] **M2-1 · Compact toolbar shell.** Bottom-anchored current-tool button (thumb
  zone) that opens a bottom sheet/drawer rendering the existing `groupedTools`
  groups; picking a tool closes the sheet. Admin/overlay/radio groups collapse
  behind the sheet or a secondary button. Hit targets ≥ ~44px. `deps:` M0-1, M0-3.
  **DoD:** every tool and admin action reachable in compact mode; adding a tool to
  `groupedTools` appears in both shells with no extra wiring; full layout unchanged. (#103)
- [x] **M2-2 · Tool info in the picker.** No hover on touch, so instead of a
  highlight-driven reveal, every button in the compact sheet shows its own cost
  directly (`toolbar.ts`'s `createToolButton`, sourced from the same
  `toolInfo.ts` `getToolDetails` the desktop hover card uses) — free tools like
  Inspect just show no badge. The current-tool dock button carries the cost
  forward too (e.g. "Road · $5.00"), so it stays visible after the sheet closes,
  right up to tapping the canvas. Full description/hints text intentionally left
  out of the tiny grid buttons; cost was the DoD and what M2-4 actually left with
  no compact-mode home. `deps:` M2-1.
  **DoD:** cost is visible before placing in compact mode. (#108)
- [x] **M2-3 · Prominent undo.** Surface the existing undo (P5-5) as a visible button
  in the compact HUD — mis-taps cost money and undo is the cheap fix. `deps:` M2-1.
  **DoD:** undo reachable in one tap; shows the same "Undone" notification.
- [x] **M2-4 · Minimap + inspector in compact mode.** On-device testing found the
  minimap and the tile inspector — not the news ticker, which turned out fine as-is —
  were the real offenders: both float over `#canvas-wrapper` in the same bottom
  corner and visibly collided. Implemented as one shared tabbed panel ("Map" /
  "Inspect") instead of two independent floats; closed by default, and tapping a
  tile with the Inspect tool active auto-switches to the Inspect tab. The
  always-visible desktop tool-info card is suppressed in compact mode (see M2-2).
  Also hides the footer (cosmetic tagline + GitHub link, permanently buried under
  the fixed compact toolbar dock anyway) to reclaim its flow height for the canvas.
  `deps:` M2-1. **DoD:** neither element occludes the canvas by default on a
  phone-sized viewport in either orientation. (#104)
- [ ] **M2-5 · Responsive modals + manual.** Settings/budget/bylaws modals size to
  small viewports in both orientations. `manual.html` is a separate document in an
  iframe — give it its own viewport meta and mobile styles, and document the touch
  controls (M1) in it. `deps:` M1-2, M2-1.
  **DoD:** all modals usable on a 360×640 viewport, portrait and landscape; manual
  readable without horizontal scrolling and covers touch controls.

## Phase M3 — Autosave + storage durability
*Goal: nobody loses a city — on any platform. Mobile browsers discard background tabs
aggressively, and desktop browser sessions currently don't autosave either.*

- [ ] **M3-1 · Autosave (all platforms).** Periodic autosave to localStorage (existing
  serialize path) plus save-on-`visibilitychange`/`pagehide`. Applies to desktop and
  mobile alike. Pause the sim (and radio, if playing) while hidden. `deps:` none.
  **DoD:** backgrounding the tab mid-game and having it discarded loses at most the
  last few seconds; desktop refresh mid-game restores the city; no save spam while
  the tab stays visible.
- [ ] **M3-2 · Durable storage request.** Call `navigator.storage.persist()` (once,
  post-first-save) to reduce eviction risk; surface quota problems as a notification
  rather than a silent failure. `deps:` M3-1.
  **DoD:** persistence request made and result logged; a failed save (quota) tells
  the player to export.
- [ ] **M3-3 · Share-based save export on touch.** The download/upload save flow is
  awkward on phones — offer Web Share API export where available, falling back to
  the existing download path. `deps:` M0-1.
  **DoD:** on Android, "export save" opens the share sheet; desktop behaviour
  unchanged.

## Phase M4 — Offline payload + performance + audio
*Goal: fast first load on cell data, sane battery/memory behaviour on mid-tier
hardware.*

- [ ] **M4-1 · Service worker precache audit.** Precache the essential payload (JS,
  WASM from `app/src/wasm/`, icons, manual); **exclude radio audio entirely** —
  radio is off by default, so stations load/cache on demand only when the player
  turns it on. Verify WASM cache-busts correctly across `build:wasm` outputs.
  `deps:` none.
  **DoD:** fresh install size measured and documented here; airplane-mode reload
  works with radio never having been enabled; a rebuilt WASM bundle is picked up
  after SW update, not served stale.
- [ ] **M4-2 · Resolution cap + idle throttling.** Cap the Pixi canvas resolution
  (devicePixelRatio ≤ 2) and throttle the rAF loop when nothing is animating.
  `deps:` none.
  **DoD:** measurable frame-time improvement on a DPR-3 device with no visible
  quality loss; no regression in desktop rendering.
- [ ] **M4-3 · Mid-tier device pass.** Profile on a mid-range Android phone (not a
  flagship): sustained FPS at default map size, memory headroom, thermal behaviour
  over ~15 min. Record findings here; fix what's cheap, file the rest. `deps:`
  M4-2. **DoD:** playable (30fps+) on the chosen reference device; findings noted
  in this doc.
- [ ] **M4-4 · Gesture-gated audio start.** Mobile browsers require a user gesture
  before audio plays. Radio is off by default, so this only bites when the player
  enables it — make sure enabling radio (a tap) is itself the gesture, handle the
  rejected-`play()` promise gracefully, and re-acquire audio after interruptions
  (e.g. a phone call). `deps:` M2-1.
  **DoD:** enabling radio on-device starts playback first try; an interruption
  doesn't leave the UI claiming it's playing silence.

## Phase M5 — Testing + dev loop
*Goal: the mobile experience can't silently regress.*

- [x] **M5-1 · LAN dev loop documented.** `bun run dev -- --host` + phone-on-LAN, and
  `chrome://inspect` USB debugging, documented in the README dev section (note the
  existing `debug-pointer` localStorage flag). `deps:` none.
  **DoD:** a fresh contributor can iterate on a phone against the dev server from
  the docs alone.
- [ ] **M5-2 · Playwright mobile emulation tests.** CI coverage with a touch +
  phone-viewport context, both orientations: compact layout renders, tool sheet
  opens/picks, pinch-zoom and two-finger pan work, autosave fires on
  `visibilitychange`. `deps:` M1-2, M2-1, M3-1.
  **DoD:** suite green in CI; a deliberate compact-layout break fails it.
- [ ] **M5-3 · Docs sync.** README, `manual.html`, and SPEC updated to describe the
  mobile mode, detection/override behaviour, and autosave. `deps:` M2-5, M3-1.
  **DoD:** shipped alongside the final feature PR, per repo convention.

---

## Relationship to the Tauri/Android plan
This plan is deliberately Tauri-free: everything ships and is testable as the PWA.
The later Android build (see `rust-migration-plan.md` Phase 4 and the future host-app
work) reuses all of it — the same webview code, with `TauriSimBridge` selected at
runtime. Tauri-specific follow-ups deferred until then: checked-in `src-tauri` host
app, `tauri android init`, plugin-backed persistence (webview storage eviction),
store packaging/signing, and **P4-3 cross-platform determinism on ARM** (prerequisite
for saves/replays moving between phone and desktop).

## Decisions still open (resolve before the phase that needs them)
- **Compact-layout breakpoint** — the viewport threshold (and whether tablets ever
  auto-select compact). *Needed by M0-1.*
- **Autosave cadence + slot model** — interval, and whether autosave overwrites the
  manual save slot or gets its own. *Needed by M3-1.*
- **Reference mid-tier device** for the M4-3 pass. *Needed by M4-3.*

## GitHub epic
Promoted: epic [#61](https://github.com/ScottMorris/city-sim-1000/issues/61), one
sub-issue per task (`M0-1` = #62 … `M5-3` = #85), all under the `mobile-web` label.
Check tasks off here **and** close the matching issue; rationale stays in this doc.
