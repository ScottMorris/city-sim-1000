# Narrative Layer

A **toggleable, non-authoritative** storytelling system that observes the simulation and renders short, grounded narrative outputs across multiple UI surfaces (news, budget insights, radio flavour, etc.).

## Goals

* Make the city feel **alive** without changing simulation rules.
* Provide **explanations** and **context** for what is already happening.
* Add flavour that scales from **deterministic templates** → **optional LLM**.
* Keep outputs **short, structured, cached**, and safe.

## Non-goals

* The narrative layer does **not** run the simulation.
* No “agent citizens” that take actions.
* No hidden game logic embedded in prose.

## Core principles

1. **Grounded in facts**: outputs must be directly attributable to snapshot + deltas + events.
2. **Optional**: can be turned off; LLM can be turned off independently.
3. **Non-authoritative**: presented as commentary, not commands.
4. **Short + structured**: strict schemas with hard limits.
5. **Deterministic fallback**: rule-based narrator always available.
6. **Cached**: same snapshot hash ⇒ same outputs.

## Inputs

All narrative channels share the same core input package.

### CitySnapshot

A compact summary of current state.

Suggested fields (extend as systems mature):

* time: day/month/year
* economy: cash, netPerMonth, runwayMonths, revenue/expenses breakdown
* population/jobs: pop, jobs, unemploymentRate, vacancyRate
* demand: R/C/I demand
* utilities: power produced/used/balance; water (later)
* map: tile counts by type, avg happiness (if present), abandoned count
* districts: (later) aggregated stats by district
* recentEvents: last N days or last edition window

### Deltas

Computed month-over-month (or window-over-window) differences used for “what changed?” narratives.

Examples:

* Δ cash, Δ netPerMonth, Δ runway
* Δ population, Δ jobs, Δ unemployment
* Δ abandoned tiles
* Δ produced/used power
* Δ demand R/C/I

### EventJournal

A ring buffer of notable events emitted by simulation/UI hooks.

Examples:

* POWER_DEFICIT_START / END
* BUDGET_RUNWAY_LOW
* ABANDON_WAVE
* PLAYER_PLACED_BUILDING
* PLAYER_MASS_ZONED

---

## Architecture

### Narrative channels

Each surface is a **channel** that returns a strictly typed payload.

All channels implement:

```ts
interface NarrativeChannel<T> {
  id: string;
  generate(input: NarrativeInput): Promise<T>;
}

type NarrativeInput = {
  snapshot: CitySnapshot;
  deltas: CityDeltas;
  recentEvents: SimEvent[];
  style?: NarrativeStyle; // optional
  seed?: number; // optional
};
```

### Providers

Two interchangeable providers per channel:

1. **RuleNarrator**: deterministic templates + scoring
2. **LLMNarrator** (optional): produces JSON matching schema

LLM output must be:

* validated against schema
* truncated to hard limits
* rejected if it references non-existent mechanics
* replaced by RuleNarrator on failure

### Caching

* Compute `snapshotHash = stableHash(snapshot + deltas + windowId + styleId)`.
* Cache per channel: `cache[channelId][snapshotHash]`.
* Prevent spam and reduce costs.

---

## Channels and surfaces

### 1) Gazette Edition

**Where**: dedicated 📰 panel, end-of-month recap.

**Output**:

* 3–5 short headlines
* 1 mayor’s recommendation
* optional district briefs and citizen voices (later)

Schema:

```ts
type GazetteEdition = {
  title: string;
  headlines: string[]; // 3–5
  mayorsRecommendation: string; // 1–3 sentences
  districtBriefs?: { districtId: string; blurb: string }[];
  voices?: { archetype: string; quote: string }[];
};
```

Notes:

* Headlines should be fact-linked (utilities, economy, growth, abandonment).
* Recommendation should map to known levers (zoning, utilities, taxes, budgets).

---

### 2) Budget Screen Insights

**Where**: Budget UI side panel / info callout.

Purpose: “Explain my accounting and highlight risks.”

Schema:

```ts
type BudgetInsights = {
  topChanges: { label: string; value: string; direction: "up"|"down" }[]; // 3
  drivers: { label: string; explanation: string }[]; // 2–4
  risks: { label: string; severity: "low"|"med"|"high"; note: string }[]; // 1–3
  recommendation: string; // 1–2 sentences
  tooltips?: { budgetLineId: string; blurb: string }[]; // optional
};
```

Examples:

* “Upkeep increased due to new power assets.”
* “Runway dropped below 3 months.”
* “Net improved after reducing service spending.”

---

### 3) News Ticker

**Where**: classic SC3K-style ticker bar.

Design:

* short, frequent, event-driven
* can be severity-coloured by category

Schema:

```ts
type TickerItem = {
  text: string; // short
  category: "utilities"|"economy"|"growth"|"civic"|"player"|"flavour";
  severity: "info"|"warn"|"alert";
  expiresAt?: number;
};
```

Production:

* Maintain a queue; inject new items on events; decay old ones.

---

### 4) Advisor Callouts

**Where**: contextual one-liners in overlays and panels.

Purpose: “Put meaning where the player is already looking.”

Examples:

* Power overlay: “Generation is the bottleneck, not transmission.”
* Demand panel: “Residential demand is high but power deficits will cap growth.”
* Abandonment view: “Clusters correlate with unpowered tiles.”

Schema:

```ts
type AdvisorCallout = {
  surfaceId: string; // e.g., "overlay.power"
  text: string;
  confidence: "low"|"med"|"high"; // optional signal, not a number
};
```

---

### 5) Radio Station IDs and PSAs (text-first)

**Where**: Radio UI / in-game music system (initially as captions or logs).

Start small:

* Station IDs (“You’re listening to 101.3 The Grid…”)
* PSAs (“Conserve power during peak hours.”)

Optional later:

* short ad scripts with SFX cues

Schema:

```ts
type RadioSpotScript = {
  stationId: string;
  kind: "station_id"|"psa"|"ad";
  lines: string[]; // 2–8
  sfxCues?: string[]; // e.g., "cash register", "crowd murmur"
};
```

---

### 6) Billboards and In-world Ads

**Where**: decorative UI or map props (later).

Generate one-liners linked to economy and demand:

* Boom → “Grand Opening!”
* High unemployment → “Job Fair!”
* Power scarcity → “Ultra-Efficient Appliances!”

Schema:

```ts
type AdCopy = {
  text: string; // very short
  tone?: "earnest"|"satirical"|"retro";
  tags?: string[]; // e.g., ["economy", "power"]
};
```

---

### 7) Mayor’s Inbox (letters/petitions)

**Where**: narrative panel tab (later, especially with districts).

Short letters from archetypes referencing real conditions.

Schema:

```ts
type InboxLetter = {
  fromArchetype: string; // "shop owner", "plant worker", "renter"
  subject: string;
  body: string; // short
  tags: ("power"|"tax"|"jobs"|"services"|"roads"|"water")[];
  districtId?: string;
};
```

---

### 8) District Identities

**Where**: district panel + map overlay (later).

Give each district:

* nickname / vibe
* short monthly brief

Schema:

```ts
type DistrictIdentity = {
  districtId: string;
  nickname: string;
  vibe: string; // 1 sentence
  monthlyBrief: string; // 1–2 sentences
};
```

---

### 9) Historical Archive

**Where**: Gazette history tab.

Store past editions and major events:

* “The Great Brownout”
* “The Boom Years”

This is mostly persistence + UI.

---

## Style and tone controls

NarrativeStyle fields:

* tone: "dry_civic" | "tabloid" | "optimistic_planner" | "retro_manual" | "deadpan"
* strictness: "high" (factual) | "medium" (light flavour)

Rules:

* The more playful the tone, the more important validation becomes.
* Never invent mechanics that don’t exist.

---

## UI integration notes

* Add a 📰 “Gazette” button near existing meta panels.
* Budget insights appear inside Budget screen (panel or collapsible section).
* Ticker is a persistent UI element with category/severity styling.
* Advisor callouts attach to existing overlay panels.

---

## Safety and quality constraints

* Hard character limits per field.
* No profanity/slurs.
* No personal data (all citizens are fictional archetypes).
* Must reference only systems that exist in the build.

Validation checklist per output:

* Mentions only known mechanics
* Claims are supported by snapshot/events
* Length within limits

---

## Implemented (current)

### What exists now

* Narrative settings: global enable + ticker enable, surfaced in Settings.
* Narrative data pipeline: EventJournal → CitySnapshot → CityDeltas → NarrativeInput.
* Rule-based News Ticker with month-end generation plus immediate utility alerts (power/water) and runway warnings.
* Ticker items persist for critical alerts until recovery; other items expire on a short timer.
* Rule-based Budget Insights with a panel in the Budget modal (hidden when Narrative is disabled).
* Player action events (tool usage) are logged for low-priority flavour items.

### Channel schemas in use

```ts
export interface NarrativeInput {
  snapshot: CitySnapshot;
  deltas: CityDeltas;
  recentEvents: SimEvent[];
}

type TickerItem = {
  text: string; // short
  category: "utilities"|"economy"|"growth"|"civic"|"player"|"flavour";
  severity: "info"|"warn"|"alert";
  expiresAt?: number;
  sourceEventType?: SimEventType;
  sourceEventId?: string;
};

type BudgetInsights = {
  topChanges: { label: string; value: string; direction: "up" | "down" }[];
  drivers: { label: string; explanation: string }[];
  risks: { label: string; severity: "low" | "med" | "high"; note: string }[];
  recommendation: string;
  tooltips?: { budgetLineId: string; blurb: string }[];
};
```

### Key files

* EventJournal: `src/game/narrative/eventJournal.ts`
* Snapshot builder: `src/game/narrative/snapshot.ts`
* NarrativeManager: `src/game/narrative/narrativeManager.ts`
* Ticker UI: `src/ui/newsTicker.ts` and HUD wiring in `src/main.ts`
* Ticker rules: `src/game/narrative/channels/tickerRule.ts`
* Budget Insights rules: `src/game/narrative/channels/budgetInsightsRule.ts`

---

## Phased implementation plan

### Phase 1 — Ship without LLM (fast fun)

* EventJournal ring buffer + emit 8–12 key events
* `buildCitySnapshot()` + `computeDeltas()`
* RuleNarrator for:

  * Gazette Edition
  * Budget Insights
  * News Ticker
* UI:

  * Gazette modal/panel + history
  * Budget Insights panel
  * Ticker bar
* Persistence:

  * save editions + major events

### Phase 2 — Make it feel alive

* Delta-based headline selection (top changes)
* Recurring “columns” (Utility Watch, Budget Beat, Growth Meter)
* More contextual advisor callouts

### Phase 3 — Districts v0 (enables richer stories)

* District model: named set of tiles
* District aggregation in snapshot
* District briefs in Gazette + Inbox (optional)

### Phase 4 — Optional LLM integration

* LLMNarrator per channel with strict JSON-only output
* Schema validation + truncation
* Cache by snapshot hash
* Per-channel toggles (so you can enable ticker AI but keep budget deterministic)

---

## Open questions / future hooks

* Which cadence is best for ticker? event-driven only vs time-based filler.
* How “snarky” can tone get before it undermines player trust?
* Should recommendations include explicit UI links (“Open Power overlay”)?
* Do we want a “Narrative Debug” panel showing which facts/events drove each line?
