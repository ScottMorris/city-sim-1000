# SC1K Radio — design spec for the city's broadcast layer

**Status:** design draft, 2026-08. Nothing here is implemented yet; milestones at the end map the build-out, tracked by epic [#248](https://github.com/ScottMorris/city-sim-1000/issues/248). Companion reading: `docs/features/city-narrative.md` (the narrative layer this plugs into), issues #19 (radio spots, text-first), #22 (optional LLM narrator), #13 (narrative epic).

## Vision

The radio today is a playlist widget: it plays pre-recorded Suno tracks per station and shows the title in a marquee. This spec turns it into the city's **broadcast layer** — a set of stations that *program themselves* from what is actually happening in the simulation: music blocks, station idents, news briefs, PSAs, local ads, and emergency bulletins, assembled continuously by a scheduler and grounded in the same snapshot/delta/event pipeline the news ticker already uses. The city gets a pulsing heart; the player gets an ambient information channel they can half-listen to while they build; and — later — players who want to go deep get a **Radio Studio** where they compose their own jingles, write their own PSAs, and run their own stations.

Three technology legs make this possible, and all three are already in or around the project:

1. **`@liminal-hq/undertone`** — already the game's procedural SFX engine, and now a pattern-based *music* engine (mini-notation, loop scheduler, polyphony, zero dependencies). Patterns are short data strings, so idents, stingers, beds, and even whole procedural stations cost bytes, start instantly, and can react to simulation state. This is the dynamic-music unlock.
2. **The narrative layer** — `NarrativeManager` already turns `SimEvent`s + `CitySnapshot`s into grounded ticker items and budget insights. Radio speech is *the same content in a different costume*: a new channel producing `RadioSpotScript`s instead of `TickerItem`s, with the same RuleNarrator-first / LLMNarrator-optional provider design (#22).
3. **On-device TTS (Kokoro)** — proven out by the `sc1k-radio-demo` prototype: Kokoro-82M in a module Web Worker, WebGPU fp32 with WASM q8 fallback, transferable WAV buffers, captions. Real-world numbers vary wildly (~110 s per prompt on an older laptop, near-realtime on a modern desktop, unknown on phones), which dictates the core speech rule below: **voice is an opt-in enhancement layered over captions, never load-bearing.**

## Design principles

- **Progressive enhancement ladder.** Every tier works without the tier above it, and the game is complete at every rung: pre-recorded tracks (today) → procedural idents and music (undertone, everywhere, instant) → text captions for speech (free, deterministic) → synthesised voice (opt-in download, hardware-gated, cached). A phone with no WebGPU and no voice pack still gets the full broadcast experience minus the audible voice.
- **Grounded, non-authoritative, optional.** All spoken/captioned content obeys the narrative layer's rules: attributable to snapshot + deltas + events, no invented mechanics, schema-validated, rule-based fallback always available, and switchable off per channel. The radio never *drives* the sim.
- **Captions first.** Every spot renders as text (marquee, popover, optional ticker cross-post) whether or not voice is enabled. This is simultaneously the accessibility story, the phone story, and the fallback story — one mechanism, three jobs.
- **Heavy compute is opt-in and cached.** Model downloads live outside the PWA precache, synthesis happens in a worker during music blocks, results are content-addressed in IndexedDB. Recurring content (station IDs, seasonal PSAs) converges to zero marginal cost.
- **Entirely client-side.** No Rust engine changes anywhere in this spec. Radio state that persists is client-owned (`ClientState` / settings) — the CSIM snapshot is untouched. A future diegetic tie-in (a radio-mast building unlocking stations) is noted under Fun extras but explicitly out of scope.
- **No executable code in saves.** Studio-authored content persists as data — mini-notation strings, control parameter objects, script text — never as code. Same trust boundary the SFX editor established: `sfxCode.ts`'s code view compiles to `VoiceParams[]` and only the compiled data is stored.

## Architecture

### The playback graph (foundation)

`radio.ts` currently drives a bare `HTMLAudioElement`. That cannot crossfade, duck, or mix in undertone patterns, so the first change is routing everything through one Web Audio graph:

```
HTMLAudioElement (tracks) ─ MediaElementAudioSourceNode ─┐
undertone patterns (idents/beds/music) ──────────────────┼─ musicBus (GainNode) ─┐
                                                         │                       ├─ radioMaster (GainNode) ─ destination
speech AudioBufferSourceNode (TTS WAVs) ─────────────────┴─ speechBus (GainNode) ┘
```

- Undertone's `play()`/`loop()` accept an external `ctx`, so patterns join the same context the SFX system already warms up.
- **Ducking** is a short gain automation on `musicBus` while `speechBus` is active (attack/release ramps, ~-9 dB); **crossfade** between segments is two overlapping gain ramps.
- The volume knob moves off the media element onto `radioMaster`; `AudioSettings.radioVolume` keeps its meaning.
- The existing widget behaviours (lazy ~55 MB cache warm on first play, fallback sources, pause resync, popover) all survive — this is a re-plumb, not a rewrite.

### The Broadcast Director

A new client-side module (`app/src/game/radio/director.ts`) that assembles each station's continuous program. It is a scheduler, not a simulator: it consumes `NarrativeManager` output and station config, and emits a queue of segments for the playback graph.

```ts
type ProgramSegment =
  | { kind: 'track'; trackId: string }                                   // pre-recorded audio file
  | { kind: 'pattern'; patternId: string; cycles: number; bpm?: number } // undertone music/ident
  | { kind: 'spot'; script: RadioSpotScript; renderAs: 'caption' | 'voice' }
  | { kind: 'stinger'; patternId: string };                              // 1–2 s ident sting

type RadioSpotScript = {           // extends the issue #19 schema
  stationId: string;
  kind: 'station_id' | 'psa' | 'ad' | 'news' | 'weather' | 'emergency';
  lines: string[];                 // 2–8, hard char limits per narrative rules
  voiceId?: string;                // DJ persona voice, resolved per station
  bedPatternId?: string;           // optional undertone music bed under the speech
  sfxCues?: string[];
};
```

Scheduling rules:

- **Interrupt classes.** `emergency` pre-empts at once with a stinger (power-deficit start/end, runway-critical — events the journal already carries); `news`/`psa` wait for the current segment boundary; `flavour` fills only idle gaps. Mirrors the ticker's persistent-critical-vs-expiring split.
- **Segment-boundary decisions only** for everything non-emergency — no mid-song whiplash.
- **Deterministic given (seed, station, month, journal).** Same city, same broadcast — replays and shared saves sound the same, and tests can pin the schedule.
- **Spot mix per station format** (see manifest below): a news-talk station leans bulletins-with-beds; a music station drops one ident + occasional PSA between tracks.

### Station manifest v2

`build-radio-playlist.ts` already scans `app/public/audio/radio/<station>/` folders with optional `station.json`. v2 adds optional, fully backwards-compatible fields — a folder with none of them behaves exactly as today (format `music`, no spots):

```ts
interface RadioStationV2 extends RadioStation {
  format?: 'music' | 'news-talk' | 'mixed' | 'procedural';
  frequency?: string;              // display flavour: "101.3"
  dj?: { name: string; voiceId?: string; persona?: string };  // persona feeds spot templates
  identPatternIds?: string[];      // undertone pattern refs (built-in or studio-authored)
  bedPatternIds?: string[];
  spotMix?: Partial<Record<RadioSpotScript['kind'], number>>; // scheduling weights
}
```

A `procedural` station has no audio files at all — its "playlist" is a set of undertone pattern programs driven by the mood engine. It weighs a few kilobytes and works offline forever.

### Dynamic music — the mood engine

`app/src/game/radio/mood.ts` maps the already-built `CitySnapshot`/`CityDeltas` to music parameters, evaluated only at segment boundaries with hysteresis (a bad month bends the music, one bad tick does not):

```ts
type MusicMood = {
  energy: number;        // 0–1 → bpm offset, voice density, filter brightness
  tension: number;       // 0–1 → mode selection (major → dorian → minor), dissonance weight
  scale: 'major' | 'dorian' | 'minor';
  eraTier: number;       // population milestones → pattern-set selection
};
```

Inputs and their pull: population growth and demand raise `energy`; utility deficits, low runway, and abandonment raise `tension`; wilderness score nudges instrumentation toward softer voices; era tier unlocks busier pattern sets as the city matures. Patterns are authored as families with variation slots (base groove + optional layers + alternate progressions via `<a b>` per-cycle alternation), so the mood engine selects and parameterises rather than composes from scratch. Suno tracks stay static — dynamic music lives on the procedural station(s), so curated and generative music coexist instead of competing.

### Speech — captions always, voice as a pack

**Radio spot channel.** A new narrative channel (`app/src/game/narrative/channels/radioSpotRule.ts`, beside `tickerRule.ts`) generates `RadioSpotScript`s from `NarrativeInput` with per-kind templates: station IDs from the manifest, news briefs from top deltas, PSAs from active conditions (conserve power during a deficit, parks flavour at high wilderness), ads keyed to economy state (the demo's canned bulletins are the tone reference — dry civic comedy). The provider seam is identical to the other channels, so the #22 `LLMNarrator` lights up radio news and the AI ticker with one integration — same grounding inputs, same schema validation, same cache-by-snapshot-hash, per-channel toggle.

**Caption rendering** is unconditional: the marquee shows the current line, the popover shows the full spot with its kind badge (📻 STATION ID / ⚡ EMERGENCY, per the demo), and news-kind spots can cross-post to the ticker.

**Voice pack** (opt-in): a TS port of the demo worker to `app/src/workers/radioVoice.worker.ts` — `kokoro-js` pinned as an npm dependency rather than a CDN import (bundler-friendly, CSP-friendly, Tauri-friendly), WebGPU fp32 with WASM q8 fallback exactly as the demo proved. Model assets are an explicit in-game download ("Install voice pack, ~90 MB"), never part of the PWA precache.

- **Device gating.** On first enable, synthesise a standard benchmark sentence and measure the real-time factor. Three classes: `live` (can synthesise on demand ahead of the queue), `background` (the ~110 s laptop case: the director requests synthesis several segments ahead and plays voice only if the WAV landed in time, otherwise the spot runs caption-only), `off` (suggested on phones — captions only). The class is a setting the player can override.
- **Cache.** IndexedDB, keyed by `hash(text | voiceId | speed | modelRev | codecRev)`, LRU-capped. Station IDs and recurring PSAs are generated once per device, ever.
- **Storage format: Opus; PCM only in flight.** Kokoro emits 24 kHz mono float32 PCM, which is ~48 KB/s even down-converted to 16-bit WAV — a 20 s spot is ~1 MB, so a modest spot library would blow the cache budget. Speech-tuned Opus at ~32 kbps mono is ~4 KB/s (~70 KB for the same spot): a ~15× capacity win for the same LRU budget at transparent quality for voice. The voice worker encodes immediately after synthesis and only the Opus blob is stored; raw PCM exists solely in flight between synthesiser and encoder. Encoder choice is an R3 spike: WebCodecs `AudioEncoder` where available vs WASM libopus everywhere — with a lean toward one WASM codec for both encode and decode, since `MediaRecorder` is disqualified (it can't encode faster than realtime) and WebKit's `decodeAudioData` support for ogg/opus is historically unreliable; a single codec path sidesteps the whole compatibility matrix, and its few hundred KB of WASM load only when the voice pack is enabled. Playback decodes once into an `AudioBuffer` and plays through `speechBus` as before. On encoder failure the entry falls back to WAV storage — voice never breaks over a codec.
- **Renderer seam.** Speech synthesis sits behind a `SpeechRenderer` interface — `CaptionOnlyRenderer | KokoroWorkerRenderer | TauriSpeechRenderer` — selected at startup exactly the way `main.ts` picks `WasmSimBridge` vs `TauriSimBridge`. The director never knows which one is active.

### Native speech on Tauri

The native app (see `docs/tauri-app-plan.md`) changes the speech story materially: a Tauri build can run Kokoro inference in Rust instead of through the browser's WASM/WebGPU stack, which is both faster on desktop and — more importantly — viable on phones, where the browser path is weakest (no WebGPU in stable WebKit, WASM q8 too slow). The design follows the org conventions the Tauri plan already adopted:

- **A reusable org plugin, not a city-sim local.** `tauri-plugin-speech` in `liminal-hq/tauri-plugins-workspace` (the same home the Steamworks plugin draft chose): Rust-side Kokoro-82M inference via ONNX Runtime (`ort` crate, or `sherpa-onnx` which ships Kokoro TTS support — decide with a spike at R3). Crucially it runs the **same ONNX model assets** as the browser worker, so voices, output, and cache keys (`modelRev`) are identical across platforms — a save that pins a DJ voice sounds the same everywhere.
- **Command surface.** `speech_synthesise(text, voiceId, speed) → Opus bytes` (encoded natively via libopus — the `opus` crate — before crossing IPC, so the transfer is small too; chunked delivery over a Tauri IPC `Channel` is the pattern `tauri-plugin-city-sim` already uses for tick updates), `speech_benchmark()`, and model management: `speech_install(voicePackId)` with native resumable, checksummed download to the app data dir, `speech_status()`. Native downloads sidestep CORS and browser cache eviction entirely.
- **Execution providers raise the ceiling, gating stays.** CPU is comfortably fast on desktop; Android gets NNAPI/XNNPACK and iOS/macOS get CoreML through the same ONNX Runtime. The benchmark-gating classes (`live`/`background`/`off`) are unchanged — native inference just moves real devices up the ladder, likely making `live` voice a realistic default on desktop and `background` plausible on recent phones.
- **Storage follows the keystone.** Where T1-1 moves saves from IndexedDB to real CSAV files under `appDataDir/saves/`, the voice model and the rendered-speech cache (`.opus` files, same format as the web cache) live under `appDataDir/radio/` as plain files — immune to Android WebView storage eviction, visible to Steam Cloud exclusion rules, and off the base bundle (the T5-4 principle: base AAB free of audio; the voice pack is an in-app download on every platform, or rides the Play Asset Delivery decision if that's where T5-4 lands).
- **Playback stays in the webview.** The native side only synthesises and returns buffers; the Web Audio graph, ducking, undertone patterns, and the director all remain identical webview code on every platform. One mixer, one scheduler, N renderers — the same "engine feature, not a platform feature" stance the Tauri plan takes for achievements.

## The Radio Studio (later phase, designed now)

The SFX editor (#153) is the exact template: a settings-surface editor, city/global override scopes, sliders plus a code view, data-only persistence. The Studio is three rooms built on that pattern:

1. **Jingle Lab** — an undertone pattern editor for idents, stingers, and beds: mini-notation textarea + voice-control sliders, live preview against the real audio graph (undertone's `demo/patternLab.ts` is the interaction reference). Saves `{ notation: string, controls: VoiceParams-like }` per pattern — pure data, shareable, no `new Function` needed for the notation path.
2. **Script Booth** — write custom spots (900-char cap, per the demo), assign kind/station/voice/speed, audition, and pre-render into the voice cache. Custom spots enter the director's rotation alongside generated ones, and can be pinned ("play my station ID every rotation").
3. **Station Manager** — create stations: name, frequency, format, DJ persona, spot mix, attach Jingle Lab patterns, and (for music) point at local audio imported into IndexedDB — player-imported tracks stay on-device, sidestepping redistribution questions.

### Studio persistence and station packs

Studio content lives in three scopes, mirroring `SfxOverrides` resolution (city → global → built-in): per-city content rides the `.citysim` save's `ClientState` (a shared city broadcasts its custom stations), the global library lives in browser-level storage on web and as real files under `appDataDir/radio/` on Tauri (following T1-1's files-not-webview-storage keystone), and built-ins ship with the game.

On top of those scopes, the Studio gets its own portable save file: a **station pack** (`.radiopack`), following the CSAV container conventions from `persistence.ts` — magic + version + meta JSON + payload. A pack bundles stations, Jingle Lab patterns (mini-notation + control data), Script Booth spots, and optional cover art. Two things deliberately stay out:

- **Rendered speech audio** — derived data. The pack carries the text; the receiving device re-synthesises through its own renderer and cache. This keeps packs tiny and voice-quality-correct on every device class.
- **Imported audio, by default.** Player-imported tracks stay device-local; a pack references them by title and the importer offers re-linking. An explicit "embed audio" toggle exists for players sharing their own recordings, with a size warning — the default avoids casually redistributing copyrighted music.

Because pack content is pure data (notation strings, parameter objects, script text — never code), importing one is as safe as loading a save. On web, packs export/import as downloads like `.citysim` files; on Tauri they're real files eligible for the native dialogs (T1-2) and, eventually, a file association (T1-3).

## Fun extras (cheap once the core exists)

- **Tuning static:** crossfading stations passes through a beat of undertone `sound('white')` filtered noise — the dial feels physical.
- **Emergency Broadcast System takeover:** `emergency` spots override *all* stations with a distinctive two-tone stinger. Players learn the sound the way SC3K players learned the disaster klaxon.
- **Pirate station:** an unlisted frequency that only broadcasts when abandonment/unhappiness crosses a threshold — snarky counter-programming as a soft warning system, and a reward for touring the dial.
- **Talk-show format:** two voices (host + guest archetype) generated from the same grounded facts — the Mayor's Inbox (#18) archetypes get literal voices.
- **Seasonal drift:** month-of-year feeds the mood engine (spring festival patterns, winter quiet) — pairs with wilderness flavour events (#10).
- **Diegetic radio mast (future, needs engine work):** stations beyond the starter pair unlock by building a broadcast tower; explicitly out of scope for this spec, noted as the one place radio might someday touch the Rust engine.

## Settings and persistence

`AudioSettings` grows (with `createDefault*` factories in `gameState.ts`, per the ensure-shape rule): `musicVolume`/`speechVolume` (sub-mixes under `radioVolume`), `speechMode: 'off' | 'captions' | 'voice'`, `voicePack: { installed, deviceClass, override? }`, `ducking: boolean`, and an accessibility split between "atmospheric speech" and "always caption" so screen-reader users can keep captions while muting the voice bus. Narrative settings gain a per-channel `radio` toggle beside the ticker's. Studio content and station selection ride `ClientState`.

## Milestones

Each lands independently and the ladder degrades gracefully; branch names follow repo convention.

- **R0 — `feat/radio-webaudio-graph`.** Route the existing widget through the Web Audio graph (buses, crossfade, ducking plumbing). No player-visible behaviour change; the regression suite is the existing `radio.test.ts` behaviours.
- **R1 — `feat/radio-broadcast-director`.** Director + segments + built-in undertone idents/stingers between tracks + caption rendering in marquee/popover. Delivers issue #19's text-first scope with sound on top.
- **R2 — `feat/radio-news-channel`.** `radioSpotRule` narrative channel: news briefs, PSAs, ads, emergency takeovers; ticker cross-post; per-channel toggle. (Part of #13; the #22 LLM provider slots in here unchanged.)
- **R3 — `feat/radio-voice-pack`.** Kokoro worker, opt-in model download, benchmark gating, IndexedDB cache, live ducking. Includes the native-inference spike (`ort` vs `sherpa-onnx`) that decides the `tauri-plugin-speech` design; the plugin itself lands with the Tauri host app timeline.
- **R4 — `feat/radio-dynamic-music`.** Mood engine + first procedural station; era/season inputs.
- **R5 — `feat/radio-studio`.** Jingle Lab, Script Booth, Station Manager, save-file sharing.

`app/public/manual.html`, `README.md`, and this doc update in the same commit as each behaviour change, per repo convention.

## Risks and open questions

- **Model licensing/size.** `kokoro-js` is MIT and the Kokoro-82M weights are Apache-2.0 — re-verify at R3, and decide whether to self-host the weights (GitHub Pages size limits) or keep the Hugging Face CDN dependency with a clear "needs network once" message.
- **iOS/WebKit.** No WebGPU in stable WebKit and tighter memory ceilings — the WASM q8 path may still be too heavy; `off`/captions is the honest default there, and the gating benchmark protects us from promising what a device can't deliver. The native Tauri path (CoreML/NNAPI via ONNX Runtime) is the real fix for phones; the web PWA on a phone simply stays captions-first.
- **Autoplay policy.** The graph must resume its `AudioContext` on the same user gesture that starts playback today (the SFX system already handles this pattern).
- **Loudness consistency.** Suno tracks vs undertone patterns vs Kokoro WAVs will not naturally level-match; add a per-source trim at build time (playlist build can compute track gain) and fixed bus offsets, revisit if it's not enough.
- **Determinism vs surprise.** The director is deterministic per (seed, month) for testability — is that too predictable across a long session? A per-session salt on flavour-class selection may be worth it; decide during R1 playtesting.
- **Ticker/radio overlap.** News spots cross-posting to the ticker risks double-reporting; the shared `EventJournal` source IDs (`sourceEventId`) can dedupe — confirm during R2.
