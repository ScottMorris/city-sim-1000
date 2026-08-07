// tickerRule.ts — scores and picks the news-ticker items for one month-end tick.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { NarrativeInput, TickerItem } from '../types';
import { ABANDONMENT_WAVE_THRESHOLD, RUNWAY_WARN_THRESHOLD_MONTHS } from '../thresholds';

const MAX_ITEMS = 3;
const POWER_ALERT_THRESHOLD = 0;

type ScoredItem = { score: number; item: TickerItem };

export function generateTickerItems(input: NarrativeInput): TickerItem[] {
  const { snapshot, deltas, recentEvents } = input;
  const candidates: ScoredItem[] = [];

  if (snapshot.utilities.powerBalance < POWER_ALERT_THRESHOLD) {
    const shortfall = Math.abs(snapshot.utilities.powerBalance).toFixed(1);
    candidates.push({
      score: 95,
      item: {
        text: `Power deficit: short ${shortfall} MW.`,
        category: 'utilities',
        severity: 'alert'
      }
    });
  }

  if (snapshot.economy.runwayMonths <= RUNWAY_WARN_THRESHOLD_MONTHS) {
    candidates.push({
      score: 80,
      item: {
        text: `Runway low: ${snapshot.economy.runwayMonths.toFixed(1)} months left.`,
        category: 'economy',
        severity: 'warn'
      }
    });
  }

  if (deltas.abandonedCount >= ABANDONMENT_WAVE_THRESHOLD) {
    candidates.push({
      score: 70,
      item: {
        text: `Abandonments rising: +${deltas.abandonedCount} this month.`,
        category: 'growth',
        severity: 'warn'
      }
    });
  }

  if (deltas.netPerMonthFlip === 'positive_to_negative') {
    candidates.push({
      score: 75,
      item: {
        text: 'Net income turned negative this month.',
        category: 'economy',
        severity: 'warn'
      }
    });
  } else if (deltas.netPerMonthFlip === 'negative_to_positive') {
    candidates.push({
      score: 60,
      item: {
        text: 'Net income is back in the black.',
        category: 'economy',
        severity: 'info'
      }
    });
  }

  const playerEvent = [...recentEvents].reverse().find((event) => event.category === 'player');
  if (playerEvent?.message) {
    candidates.push({
      score: 25,
      item: {
        text: playerEvent.message,
        category: 'player',
        severity: 'info'
      }
    });
  }

  if (candidates.length === 0) {
    const popDelta = Math.round(deltas.pop);
    if (popDelta !== 0) {
      candidates.push({
        score: 20,
        item: {
          text: `Population ${popDelta > 0 ? 'up' : 'down'} by ${Math.abs(popDelta)}.`,
          category: 'growth',
          severity: popDelta > 0 ? 'info' : 'warn'
        }
      });
    } else {
      candidates.push({
        score: 10,
        item: {
          text: 'City holding steady this month.',
          category: 'flavour',
          severity: 'info'
        }
      });
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ITEMS)
    .map(({ item }) => item);
}
