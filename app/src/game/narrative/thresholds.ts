// thresholds.ts — narrative-layer display thresholds shared across the ticker, budget insights, and event-driven ticker alerts.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
//
// These are display-layer judgement calls (when a figure reads as "a
// problem" to the player), not simulation truth — kept in one place so
// `tickerRule.ts`, `narrativeManager.ts`, and `budgetInsightsRule.ts` can't
// independently drift onto different numbers for the same threshold.

/** Runway (months) at or below this reads as low — ticker alert, `NarrativeManager`'s runway-low/-recovered event pair, and `budgetInsightsRule`'s "Short runway" risk/recommendation. */
export const RUNWAY_WARN_THRESHOLD_MONTHS = 3;

/** Runway (months) at or below this earns a mention in `budgetInsightsRule`'s drivers list — a softer, earlier heads-up than `RUNWAY_WARN_THRESHOLD_MONTHS`. */
export const RUNWAY_DRIVER_THRESHOLD_MONTHS = 6;

/** Abandoned buildings gained in a month at or above this reads as a wave — ticker item, `NarrativeManager`'s `abandonment_wave` event, and `budgetInsightsRule`'s "Abandonments" risk/recommendation. */
export const ABANDONMENT_WAVE_THRESHOLD = 5;

/** Abandonments gained in a month at or above this escalate `budgetInsightsRule`'s "Abandonments" risk from `med` to `high` severity. */
export const ABANDONMENT_HIGH_SEVERITY_THRESHOLD = 10;

/** Power balance (MW) at or below this escalates `budgetInsightsRule`'s "Power deficit" risk from `med` to `high` severity. */
export const POWER_DEFICIT_HIGH_SEVERITY_THRESHOLD_MW = -5;
