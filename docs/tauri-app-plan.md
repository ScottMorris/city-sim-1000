# Tauri App — Execution Map (Task Breakdown)

**Scope:** the native City Sim 1000 app — a checked-in Tauri v2 host app around the existing webview game, desktop OS integration, packaging and release CI for Linux/Windows/macOS, a Steam release, and an Android build. iOS and macOS signing/notarisation are tracked but parked behind the Apple developer account decision.

**Where this starts from.** The Rust migration ([`rust-migration-plan.md`](./rust-migration-plan.md)) already delivered the hard parts: `crates/tauri-plugin-city-sim` runs `city-sim-core` natively (P4-1) and `TauriSimBridge` auto-detects the runtime (P4-2). The mobile-web epic (#61) made the frontend touch-ready, safe-area-aware, offline-capable, and autosaving. What was explicitly deferred — and is exactly this plan's scope — is the checked-in `src-tauri` host app, `tauri android init`, plugin-backed persistence, store packaging/signing, and P4-3 cross-platform determinism.

**Org conventions this plan follows.** The liminal-hq org review (2026-07) established the patterns to copy: `threshold` is the reference implementation (the only org app shipping desktop + Android end-to-end; its `release-build.yml` is the skeleton to fork), `emoji-nook` is the canonical lightweight release template (version-sync shell scripts, reusable AppImage workflow), `spindle/docs/release-workflow-plan.md` is the org's own cross-repo release-workflow comparison, and `foyer` is the precedent for a Bun-based Tauri app. Conventions adopted wholesale: `ca.liminalhq.*` identifiers, full bundle metadata (publisher "Liminal HQ"), three-file capability split (`default.json` / `desktop.json` / `mobile.json`), cfg-gated platform plugins, shared CI images (`ghcr.io/liminal-hq/tauri-ci-desktop` / `-mobile`, see #131), three-job release shape (prepare → build matrix → publish) with one rolled-up `SHA256SUMS` and idempotent re-runs, `distribution/whatsnew/` Play copy, and `$GITHUB_STEP_SUMMARY` blocks on every job.

**What the org has never done** (i.e. genuinely new plumbing, not copyable): Steam (no Steamworks anywhere), macOS builds (no Tauri repo has a macOS leg), the updater (deliberately unused org-wide, `includeUpdaterJson: false` everywhere), Windows code signing, and game-shaped concerns (fullscreen, gamepad, WebGL, large assets, save-file conventions).

> **How to use this:** Work top-to-bottom within a phase; respect `deps`. Each task has a **DoD** (definition of done) that must be green before checking it. Task IDs (`T0-1`…) are stable so this doc can be mechanically promoted to a GitHub epic + sub-issues (see the promotion section at the end).

**Legend:** `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked
**Global gate:** every task ends green on `bun run test`, `bun run lint`, and `cargo test --workspace`.

**Guiding decisions (settled):**
- **Host app lives at `app/src-tauri/`**, consuming `tauri-plugin-city-sim` by path. The repo keeps its own monorepo shape and Bun — no restructure to the org's pnpm `apps/` layout (foyer is the org precedent for Bun + Tauri).
- **Native file saves are the keystone integration.** Saves move from IndexedDB to real CSAV files under the app data dir when running under Tauri. This one change unlocks Steam Cloud (Auto-Cloud on the save directory), survives Android WebView storage eviction, and enables file associations. The web/PWA path keeps IndexedDB unchanged.
- **A distribution-channel build flag** (`github` / `steam` / `play`) is the single switch that gates the updater (GitHub builds only), Steamworks linkage (Steam builds only), and store-specific links. Steam and Play handle their own updates — the updater must never run there.
- **No service worker inside Tauri.** The Tauri build variant disables `vite-plugin-pwa`; a stale Workbox cache inside a wrapped webview is pure downside.
- **Steamworks lives in `liminal-hq/tauri-plugins-workspace`** as a reusable org plugin, not a city-sim local (design draft in Appendix A).
- **Achievements are an engine feature, not a Steam feature.** `city-sim-core` owns milestone detection; Steam (and later Play Games, and an in-game trophy panel on web) merely mirror it.
- **The Steam phase is gated on a spike** (T4-1): Tauri's Linux webview (webkit2gtk) is not part of the Steam Linux Runtime, and overlay injection over webviews is unreliable. Nothing else in Phase T4 gets detailed until the spike answers both.

---

## Phase T0 — Host app shell
*Goal: `bun run dev:desktop` opens the game in a native window playing through `TauriSimBridge`, from a checked-in, org-conventional host app. No OS integration yet.*

- [ ] **T0-1 · Checked-in host app at `app/src-tauri/`.** `tauri.conf.json` (`$schema` v2, `ca.liminalhq.*` identifier — see open decisions, full bundle metadata, `bundle.targets: "all"`), `main.rs` registering `tauri_plugin_city_sim::init()`, `frontendDist` pointing at `app/dist`, `beforeDevCommand`/`beforeBuildCommand` proxying to Bun, root scripts `dev:desktop` / `build:desktop`. `deps:` none.
  **DoD:** `bun run dev:desktop` plays the game with the Tauri bridge auto-detected (`__TAURI_INTERNALS__` path in `main.ts`); `cargo check --workspace` includes the host app; README dev section documents the loop.
- [ ] **T0-2 · Capability split + cfg-gated plugins.** `capabilities/default.json` / `desktop.json` (`platforms: [linux, macOS, windows]`) / `mobile.json` (`platforms: [android, iOS]`) per the threshold pattern; platform-conditional plugin deps in `Cargo.toml` from day one so Android doesn't require a refactor. `deps:` T0-1.
  **DoD:** capabilities validate at build; a desktop-only plugin (T1-4's `window-state`) demonstrates the cfg gate.
- [ ] **T0-3 · Icon pipeline.** Feed the existing 🏙️ icon source through `tauri icon` (icns/ico/png set, Android adaptive icons later); wire into the existing `build:favicon` script family so one source drives PWA and native. `deps:` T0-1.
  **DoD:** native window/taskbar/dock shows the real icon on all three desktop OSes.
- [ ] **T0-4 · Tauri build variant without the service worker.** Vite mode/env that skips `vite-plugin-pwa` registration for `frontendDist` builds; assert at runtime that no SW is registered under Tauri. `deps:` T0-1.
  **DoD:** Tauri build contains no Workbox precache; PWA build unchanged (existing precache test still green).
- [ ] **T0-5 · Fix #178 — full-fidelity tile mirror over the Channel.** The tick event must carry the same SoA tile buffer the WASM path sends (`kind`, `flags`, `happiness`, `elevation`, `building_id`, `underground`, `wilderness`), not the kind-byte projection that loses road/rail/hydro coexistence. Existing issue #178 has the fix sketch. `deps:` T0-1 (for on-device verification; the plugin change itself has no dep).
  **DoD:** #178's three repro cases render identically under `?bridge=tauri` and the WASM path; `tileRenderUtils` parity test extended to the Tauri event shape.
- [ ] **T0-6 · Debug tooling parity.** Register `tauri-plugin-mcp-bridge` under `#[cfg(debug_assertions)]` (org pattern) so the existing `?mcp` test bridge and the city-sim MCP server work against the native app in dev. `deps:` T0-1.
  **DoD:** the MCP smoke flow (screenshot + `get_state`) works against a debug desktop build; release builds contain no MCP surface.

## Phase T1 — Desktop OS integration
*Goal: the wrapper behaves like an installed app, not a kiosked website. Everything here is desktop; Android picks up the same persistence layer in T5.*

- [ ] **T1-1 · Native save storage (the keystone).** When the Tauri bridge is active, saves are CSAV files in `appDataDir/saves/` via the fs plugin: manual slots, the autosave slot, and export/import all flow through one native-backed implementation of the existing `saveStore` interface. One-time migration offers to copy IndexedDB saves to disk on first native run. Web path untouched. `deps:` T0-1.
  **DoD:** save → quit → relaunch restores from disk; autosave cadence + `pagehide`-equivalent flush (window close) proven; migration round-trips a browser save byte-identically (CSAV container unchanged).
- [ ] **T1-2 · Native open/save dialogs.** Dialog plugin replaces the `<a download>` / file-input flow under Tauri for save export/import and replay files; Web Share / download paths remain for PWA. `deps:` T1-1.
  **DoD:** export writes where the user chose; import loads a `.citysim` picked in the native dialog; web behaviour byte-identical to today.
- [ ] **T1-3 · File associations + single instance + deep link.** Register the save and replay file extensions (`bundle.fileAssociations`) so double-click opens the game and loads the file; `single-instance` focuses the running window and routes the path to it instead of spawning a second sim; `deep-link` scheme for future share links. `deps:` T1-1.
  **DoD:** double-clicking a save with the app closed boots into that city; with the app open, focuses and prompts to load; second launch never corrupts the autosave.
- [ ] **T1-4 · Windowing.** `window-state` (desktop cfg-gated) persists size/position/monitor; sane `minWidth`/`minHeight`; fullscreen toggle (F11 / ⌃⌘F) surfaced in settings + hotkeys; macOS app menu (About / Quit / minimise — macOS feels broken without it); close requests flush the autosave before exit. `deps:` T0-2.
  **DoD:** quit → relaunch restores window geometry; fullscreen round-trips; closing mid-game loses at most the autosave interval (matching the browser guarantee).
- [ ] **T1-5 · OS notifications for backgrounded alerts.** Sim alerts (power/water deficit, budget crisis) surface as native notifications only while the window is unfocused/minimised — the native sim thread already keeps ticking. Respect a settings toggle; batch to avoid spam. `deps:` T0-1.
  **DoD:** deficit while minimised raises one notification; focused play raises none; toggle off silences all.
- [ ] **T1-6 · Native logging.** Log plugin wired to the existing console diagnostics so desktop bug reports have a log file; log location documented in the manual. `deps:` T0-1.
  **DoD:** engine + bridge errors land in a rotating log file on all three desktop OSes.
- [ ] **T1-7 · Screensaver/sleep inhibit while simulating (optional).** A settings-gated "keep display awake while the sim runs" — a city sim is watched idle, unlike a utility app. Skip if no maintained plugin fits; record the decision here. `deps:` T0-1.
  **DoD:** with the toggle on, display stays awake during unattended fast-forward; off by default.

## Phase T2 — Packaging + release CI
*Goal: every merge can produce installable desktop artifacts for Linux/Windows/macOS; determinism is proven on every shipping platform. Forks threshold's `release-build.yml` skeleton; folds in #131.*

- [ ] **T2-1 · Version sync.** Adopt emoji-nook's `check-release-versions.sh` / `prepare-release-version.sh` pattern across root `package.json`, `app/package.json`, `tauri.conf.json`, and the host `Cargo.toml`; wire as `bun run release:version:check` / `release:version:prepare` and into CI. `deps:` T0-1.
  **DoD:** a deliberate version drift fails CI; the prepare script bumps everything atomically.
- [ ] **T2-2 · Desktop build matrix in the release workflow.** Fork threshold's shape minus the Wear legs: `prepare-release` (tag `v*` + `workflow_dispatch`, ancestor-of-main check, create-or-reuse release) → `build-desktop` matrix (ubuntu-24.04, ubuntu-24.04-arm, windows-latest x64 + arm64, **macos-14** — an org first, unsigned/ad-hoc for now) via `tauri-action`, new-format AppImage enabled → `publish-release` with rolled-up `SHA256SUMS`, asset-replacement on re-run, step summaries everywhere. Linux jobs run in `ghcr.io/liminal-hq/tauri-ci-desktop` (#131). `deps:` T0-1, T2-1.
  **DoD:** one tagged release carries AppImage/deb/rpm, msi/nsis, and dmg/app artifacts plus `SHA256SUMS`; re-running the workflow is idempotent.
- [ ] **T2-3 · PR-gate desktop build check.** A CI job that compiles the host app (`cargo check` + a Linux `tauri build` smoke) so plugin/host drift can't land silently; adopts the shared images per #131. `deps:` T0-1.
  **DoD:** breaking the host app fails PR CI in minutes, not at release time.
- [ ] **T2-4 · Renderer smoke test per platform.** Launch the built app headless-ish on each desktop OS in CI, assert the Pixi canvas actually rendered (webkit2gtk WebGL has known DMA-BUF flakiness on Linux; WebView2/WKWebView need their own proof). Reuse the `?mcp`/mcp-bridge screenshot hook from T0-6, or `tauri-driver` where simpler. Document known env-var workarounds (`WEBKIT_DISABLE_DMABUF_RENDERER`) if needed. `deps:` T0-6, T2-2.
  **DoD:** each matrix leg fails if the map doesn't render; Linux flakiness (if any) documented with the workaround applied deliberately, not by accident.
- [ ] **T2-5 · P4-3 — cross-platform determinism, completed.** Extend the golden-hash CI matrix from linux x64/arm64 to windows + macOS runners, and add the wasm-vs-native comparison (same seed + command log → identical hash in the browser WASM build and the native plugin). This closes the last open task in [`rust-migration-tasks.md`](./rust-migration-tasks.md) and is a hard prerequisite for saves/replays roaming between phone, desktop, and Steam Cloud. `deps:` T2-2.
  **DoD:** CI proves one golden hash across linux-x64, linux-arm64, windows-x64, macos-arm64, and WASM; `rust-migration-tasks.md` P4-3 checked off.

## Phase T3 — Distribution channels + updater
*Goal: one codebase, per-channel behaviour. The updater is research-first — the org has zero updater precedent and Steam/Play forbid it.*

- [ ] **T3-1 · Distribution-channel build flag.** A build-time channel (`github` / `steam` / `play`) threaded through Rust features + Vite env: gates updater (T3-2, `github` only), Steamworks linkage (T4, `steam` only), store links/about text. Channel visible in the debug overlay's build stamp. `deps:` T0-1.
  **DoD:** three artifacts from one commit differ only in the gated surfaces; the wrong-channel combination (e.g. updater in the Steam build) is unrepresentable.
- [ ] **T3-2 · Updater — research, then decide, then (maybe) implement.** Research `tauri-plugin-updater` for the GitHub-release channel: signing key custody, endpoint options (static JSON on GitHub Releases vs a service), `includeUpdaterJson`, partial-update behaviour on Linux AppImage vs deb/rpm, and whether direct-download users actually need it pre-Steam. Output is a written recommendation in this doc; implementation only if the recommendation says so. `deps:` T3-1, T2-2.
  **DoD:** decision recorded here with rationale; if "yes": updater works on all three OSes for the `github` channel with signed manifests; if "no/later": explicitly parked with the trigger condition named.
- [ ] **T3-3 · Linux reach beyond GitHub artifacts — research.** Evaluate Flatpak (Flathub), Snap, AUR, and itch.io against effort/reach/sandboxing (Flatpak's sandbox vs file associations + saves dir; itch.io as a zero-gatekeeper beta channel pre-Steam). Org has none of these; the reusable `package-arch-appimage.yml` covers AppImage only. `deps:` T2-2.
  **DoD:** recommendation recorded here (which targets, in what order, or none); any accepted target becomes its own follow-up issue.

## Phase T4 — Steam
*Goal: a shippable Steam build for Linux (incl. Steam Deck) and Windows, with achievements and cloud saves. **T4-1 gates everything else in this phase.***

- [ ] **T4-1 · Spike: webview viability on Steam Linux Runtime + Steam Deck.** Tauri's Linux webview (webkit2gtk-4.1) is not in the Steam Linux Runtime (sniper). Test the new-format AppImage's bundled-webkit tree as a raw depot layout on SLR and on a real Steam Deck; measure launch, rendering, input. Same spike verifies overlay behaviour on Linux and Windows/WebView2: WebView2's out-of-process compositing leaves Steam's injected DLL nothing to hook, and the July 2026 decoy-swapchain workaround ([`tauri-plugin-steam-overlay-surface`](https://github.com/PSG-Team/tauri-steam-overlay-surface), Windows-only, needs `SteamAPI_Init` before the Tauri builder) is worth evaluating hands-on here. `deps:` T2-2.
  **DoD:** written spike report in `docs/`: does the bundled-webkit depot run under SLR and on Deck (and if not, the fallback: unbundled `LD_LIBRARY_PATH` tree, or shipping the Windows build + Proton as the Deck path)? Does the overlay render, and what breaks without it? Go/no-go + approach for T4-5.
- [ ] **T4-2 · `tauri-plugin-steamworks` (in `liminal-hq/tauri-plugins-workspace`).** Reusable org plugin over the `steamworks` crate: init/lifecycle + callback pump, achievements, stats, rich presence, Steam Cloud API, overlay, player/app info — full design draft in **Appendix A** (to be filed as a workspace issue and cross-linked here). City-sim consumes it behind the `steam` channel flag. `deps:` T4-1 (go decision), T3-1.
  **DoD:** plugin published per workspace conventions (guest-js typed API, permissions, covector); city-sim `steam` build initialises against appid 480 (Spacewar) in dev; non-steam builds don't link the SDK.
- [ ] **T4-3 · Achievements as an engine feature.** Milestone detection in `city-sim-core` fed by the systems it already tracks (population, wilderness score, utility coverage, budget, abandonment), surfaced over the existing `SimEvent` channel; unlocked-set persisted in the client state; an in-game trophy panel so web players get the same feature. Steam merely mirrors unlock events (T4-2). Sample set to seed the design (final list is its own balancing pass):
  - 🏙️ **Incorporated** — population reaches 1,000.
  - 🌆 **City of Tomorrow** — population reaches 50,000.
  - ⚡ **Lights On** — first zone powered.
  - 💧 **On Tap** — every zone watered simultaneously.
  - 💰 **Balanced Books** — twelve consecutive months of budget surplus.
  - 🌲 **Half Wild** — wilderness score ≥ 50% with population above 5,000.
  - 🚆 **Rail Baron** — 100 rail tiles connected to a station network.
  - 📉 **Ghost Town** — 25 buildings abandoned at once (failure achievements are memorable).
  - ↩️ **Mulligan** — undo 100 placements across a city's lifetime.
  - 🗺️ **Cartographer** — export a map seed or replay for sharing.
  `deps:` none (engine work; Steam mirroring deps T4-2).
  **DoD:** milestones fire deterministically (covered by the golden-hash discipline — same replay → same unlock ticks), persist across save/load, render in an in-game panel on all platforms; Steam build forwards unlocks.
- [ ] **T4-4 · Steam Cloud.** Auto-Cloud on the native save directory (T1-1's layout is designed for this); verify conflict behaviour (newest-wins vs prompt) and that autosave cadence doesn't thrash sync; replays/exports excluded. `deps:` T1-1, T4-2.
  **DoD:** save on machine A appears on machine B; a cloud conflict never silently destroys the newer city.
- [ ] **T4-5 · Depot layout + steamcmd upload CI.** A `steam-depot` job producing the raw unpackaged tree (a fifth bundle shape the org has never made — Steam wants files, not installers) per T4-1's chosen approach, plus a steamcmd/SteamPipe upload to a beta branch on tag; secrets for the builder account. The Windows depot must bundle or bootstrap the WebView2 Evergreen runtime — Steam customers on Windows LTSC/N editions don't have it preinstalled ([Luzzotica/bouncy-blobs#2](https://github.com/Luzzotica/bouncy-blobs/issues/2)). `deps:` T4-1, T2-2.
  **DoD:** tagged release pushes a build to a Steam beta branch; installing from Steam on Linux and Windows boots the game.
- [ ] **T4-6 · Steam Deck + controller pass.** Deck's 1280×800 already selects the compact layout (M-phase work); v1 input is a curated Steam Input profile (trackpad-as-mouse + key bindings); native Gamepad API support is a follow-up issue, not this task. Run the Deck Verified checklist. `deps:` T4-5.
  **DoD:** playable start-to-city on a Deck with the shipped Steam Input profile; Verified-checklist results recorded, gaps filed.
- [ ] **T4-7 · Store presence.** Steam page: capsule art set (the 🏙️ icon is one asset of many — header/library capsules, hero, screenshots, optional trailer), copy, tags, system requirements (webview memory realities), pricing/region decisions. Tracked as its own workstream — mostly not code. `deps:` none (parallel).
  **DoD:** store page passes Valve review in draft; asset sources checked into `distribution/steam/`.

## Phase T5 — Android
*Goal: the mobile-web experience as an installable Play (internal-track) app. The M-phase epic did the frontend; this is packaging + the native persistence the WebView can't guarantee.*

- [ ] **T5-1 · `tauri android init` + committed `gen/android`.** Org pattern: `gen/android` is committed, `minSdkVersion 26`, current `targetSdk`, release minify + proguard + full NDK debug symbols; decide `abiFilters` (arm64-v8a + armeabi-v7a; skip x86 unless emulator CI needs it — all-four bloats a game). `deps:` T0-2.
  **DoD:** `bun run dev:android` runs on a device with the Tauri bridge active; debug APK plays the golden scenario.
- [ ] **T5-2 · Mobile capabilities + plugins.** `capabilities/mobile.json` scoped; `app-events` (mobile cfg) for lifecycle-driven autosave flush (the Android equivalent of `pagehide`), `predictive-back` (org plugin) so back-gesture behaves; audio focus interacts correctly with the radio's existing interruption handling (M4-4). `deps:` T5-1.
  **DoD:** backgrounding/killing the app loses at most the autosave interval; back gesture never silently exits mid-game; radio survives an interruption exactly as the PWA does.
- [ ] **T5-3 · Native persistence on Android.** T1-1's file-based `saveStore` over Android app storage — this is the "plugin-backed persistence (webview storage eviction)" item the mobile plan deferred; plus share-sheet export parity (M3-3 did the web half). `deps:` T1-1, T5-1.
  **DoD:** clearing WebView data does not destroy saves; export/import round-trips with the desktop and web formats (same CSAV bytes, proven by T2-5's determinism).
- [ ] **T5-4 · Radio asset strategy.** The ~55 MB radio library must not ship in the base install (mirrors the PWA precache exclusion): on-demand fetch + cache on enable, or Play Asset Delivery on-demand pack if offline-first radio matters. Decide and implement the simpler one. `deps:` T5-1.
  **DoD:** base AAB size recorded here and free of audio; enabling radio on-device streams/caches per the decision.
- [ ] **T5-5 · Signing + Play internal-track CI.** Fork threshold's Android release job minus the Wear legs: `tauri-ci-mobile` container, keystore-from-secret with `if: always()` cleanup, AAB + APK, `jarsigner -verify`, native debug symbols zip; separate `deploy-android-play` job (draft, internal track) so a Play API failure can't fail the build; `distribution/whatsnew/` per-locale copy. Secrets per threshold's naming. `deps:` T5-1, T2-1.
  **DoD:** tagged release lands a draft build on the Play internal track with symbols and whatsnew copy.
- [ ] **T5-6 · Device pass.** The M4-3 discipline against the native build: sustained FPS, memory, thermals, immersive/landscape behaviour, notch/gesture-nav on the reference device; findings recorded here, cheap fixes applied, the rest filed. `deps:` T5-1..T5-4.
  **DoD:** 30fps+ sustained on the reference device in the native app; findings noted here.

## Phase T6 — Apple platforms (parked)
*Goal: placeholders so the Apple developer-account decision has a home. No work scheduled.*

- [ ] **T6-1 · macOS signing + notarisation.** Developer ID cert, `tauri-action` signing env, notarytool, stapling; upgrade T2-2's unsigned dmg to a distributable one. `deps:` T2-2, Apple account.
- [ ] **T6-2 · iOS.** `tauri ios init`, capabilities, TestFlight pipeline. The mobile-web work means the frontend is ready; everything else waits on the account. `deps:` T5 complete (share the mobile persistence layer), Apple account.

---

## Open decisions (resolve before the phase that needs them)
- **Bundle identifier** — `ca.liminalhq.citysim` recommended (Android package names forbid hyphens, so the repo name can't be used verbatim). *Needed by T0-1.*
- **Save/replay file extensions to register** — `.citysim` exists; decide the replay extension before T1-3. *Needed by T1-3.*
- **Updater yes/no for the GitHub channel** — T3-2's research output. *Needed by T3-2 implementation half.*
- **Steam Linux approach** — bundled-webkit depot vs Proton-first Deck strategy: T4-1's output. *Needed by T4-5.*
- **`abiFilters` set** for Android. *Needed by T5-1.*
- **Radio delivery on Android** — on-demand fetch vs Play Asset Delivery. *Needed by T5-4.*

## Promotion to a GitHub epic
When this doc is promoted (the #61 mobile-web pattern, upgraded to GitHub's native relationship APIs):
- One **epic issue** linking this doc, with each phase as a checklist entry.
- One **sub-issue per task** (`T0-1`…), attached to the epic via the **native sub-issue relationships API** (not checklist links), title = task line, body = DoD + deps + anchor link here; rationale stays in this doc.
- **`deps:` become blocked-by relationships** via the issue-dependencies API, so GitHub surfaces blocker status on each issue.
- **One milestone per phase** (`Tauri T0 — Host app shell`, … `Tauri T5 — Android`; T6 gets a milestone only when unparked) for burndown.
- Label: `tauri-app` on everything; T4-2 additionally cross-links the `tauri-plugins-workspace` issue (Appendix A).

---

## Appendix A — `tauri-plugin-steamworks` design draft (to file in `liminal-hq/tauri-plugins-workspace`)

*This appendix is the ready-to-file issue body for the workspace repo (this session couldn't file cross-org). It follows the workspace's `PLUGIN_TEMPLATE.md` shape and is deliberately app-agnostic — city-sim-1000 is the first consumer, not the design target.*

### Motivation
City Sim 1000 (ScottMorris/city-sim-1000, see `docs/tauri-app-plan.md` Phase T4) needs Steamworks for a Steam release: achievements, stats, rich presence, cloud saves, overlay. Nothing in the org wraps Steamworks today, and every future Tauri game or Steam-shipped app will need the same surface — this belongs in the workspace as a reusable plugin, not in an app repo.

### Prior art (surveyed 2026-07)
- [`tauri-plugin-hal-steamworks`](https://crates.io/crates/tauri-plugin-hal-steamworks) is the only published Tauri Steamworks plugin: v0.0.4, purpose-built for the HAL Launcher project, 0 stars / 17 commits, no visible app-agnostic design or workspace-grade JS/permissions surface. Worth a source read for wiring details; not a dependency candidate.
- [`steamworks.js`](https://github.com/ceifa/steamworks.js) is why "just use Electron" is the standing advice for JS games on Steam — it has no Tauri equivalent. That gap is exactly what this plugin closes.
- [`steamworks-rs`](https://crates.io/crates/steamworks) is the settled Rust binding; [`bevy-steamworks`](https://github.com/james7132/bevy-steamworks) wraps the same crate and is prior art for the callback-pump-owned-by-the-framework pattern.
- **Steam overlay needs help, but is no longer hopeless.** The 2023 upstream position was broken-and-not-planned ([tauri#6196](https://github.com/tauri-apps/tauri/issues/6196)); as of July 2026 the Windows failure is precisely understood — WebView2 composites out-of-process, so the game process never creates a swapchain for Steam's injected `gameoverlayrenderer64.dll` to hook ([Luzzotica/bouncy-blobs#2](https://github.com/Luzzotica/bouncy-blobs/issues/2)) — and [`tauri-plugin-steam-overlay-surface`](https://github.com/PSG-Team/tauri-steam-overlay-surface) (MIT, verified on real Steam builds in July 2026) works around it with a transparent click-through decoy window presenting an empty vsync'd wgpu swapchain as the hook target. Windows-only so far; it requires `SteamAPI_Init` before the Tauri builder runs and Tauri's `unstable` feature. Overlay support in this plugin would stay best-effort and should interoperate with (or defer to) that surface technique rather than reimplement it — achievements, stats, presence, and cloud need no overlay either way.

### Shape
- **Rust core.** The plugin will wrap the [`steamworks`](https://crates.io/crates/steamworks) crate. A `Builder`-style config will take the AppId, and `init` will be fallible by design: if Steam isn't running or the SDK fails to load, the plugin will resolve to an explicit *unavailable* state (queryable from JS) rather than panicking — so apps can ship one binary that degrades gracefully outside Steam. `restart_app_if_necessary` support would be optional, for launch-outside-Steam correctness.
- **Callback pump.** The plugin will own the callback pump (interval on a plugin thread, `run_callbacks` at ~10 Hz, configurable), so consumers will never need to think about it.
- **Desktop-only, gracefully.** The real implementation will be cfg-gated to Linux/Windows/macOS; Android/iOS will get a stub that always reports unavailable, so shared codebases will be able to depend on the plugin unconditionally (same pattern as the workspace's platform-gated plugins).
- **Feature-gated linking.** The SDK would never be linked into non-Steam builds — consumers would enable a cargo feature from their `steam` distribution channel only. The `steamworks-sys` redistributable/licence story (SDK binaries in the workspace vs consumer-provided) should be verified before v0.1.

### Command surface (v0.1 → v0.3)
- **v0.1 — identity + achievements + stats** would cover: `isAvailable()`, `getPlayer()` (steamId, personaName, appLanguage), `unlockAchievement(id)`, `clearAchievement(id)` (dev), `getAchievement(id)`, `indicateProgress(id, cur, max)`, `setStat`/`getStat`/`storeStats`, events: `stats-received`, `achievement-stored`.
- **v0.2 — presence + overlay + cloud** would add: `setRichPresence(kv)`, `clearRichPresence()`, `activateOverlay(page)`, `activateOverlayToWebPage(url)`, event `overlay-toggled`; Steam Cloud file API (`cloudWrite`/`cloudRead`/`cloudList`/`cloudQuota`) for apps not using Auto-Cloud.
- **v0.3 — nice-to-haves** could add: DLC queries, `isSteamDeck`, Steam Input glyph helpers, a screenshots hook. Matchmaking/lobbies, networking, workshop, and in-app purchases would stay out of scope for now — the design shouldn't preclude them, but they'd be separate issues.

### guest-js
The plugin will ship a full typed TS API per the workspace template — `guest-js/index.ts` with typed wrappers over `invoke('plugin:steamworks|…')` and typed event helpers, a rollup build to `dist-js` + `api-iife.js`, `package.json` exports, and npm publishing via covector like the existing plugins. The JS surface will be the real product here: consumers should never need to hand-write an `invoke` string.

### Permissions
Permission sets will be granular per command group — `allow-achievements`, `allow-stats`, `allow-presence`, `allow-overlay`, `allow-cloud`, `allow-player-info` — with `default.toml` granting only identity + achievements + stats; cloud and overlay would be opt-in. Permission docs will be autogenerated per the workspace build.

### Testing/CI
Steam can't run in CI, so a `mock` cargo feature will back the same command surface with an in-memory fake (unlocks recorded, stats stored), letting plugin unit tests and consumer e2e tests run Steam-less; manual verification against appid 480 (Spacewar) will be documented in the plugin README.

### First consumer
city-sim-1000 Phase T4 (`docs/tauri-app-plan.md`) will be the first consumer: achievements mirroring an engine-side milestone system, Auto-Cloud on its native save directory, and rich presence ("Mayor of <city>, pop. 12,400"). The city-sim epic will be cross-linked when both exist.
