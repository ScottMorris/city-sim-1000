// narrativeManager.ts — buffers SimEvents into an EventJournal, turns month-end snapshots into ticker items and budget insights, and tracks active start/end alert pairs.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { computeDeltas } from './deltas';
import { EventJournal } from './eventJournal';
import { generateBudgetInsights } from './channels/budgetInsightsRule';
import { generateTickerItems } from './channels/tickerRule';
import { ABANDONMENT_WAVE_THRESHOLD, RUNWAY_WARN_THRESHOLD_MONTHS } from './thresholds';
import type { BudgetInsights, CitySnapshot, NarrativeInput, SimEvent, SimEventType, TickerItem } from './types';

export interface NarrativeSettings {
  enabled: boolean;
  tickerEnabled: boolean;
}

export class NarrativeManager {
  private settings: NarrativeSettings;
  private lastSnapshot?: CitySnapshot;
  private readonly eventJournal: EventJournal;
  private tickerQueue: TickerItem[] = [];
  private lastTickerTexts = new Set<string>();
  private activeAlertByType = new Map<SimEventType, string>();
  private currentBudgetInsights?: BudgetInsights;

  constructor(settings: NarrativeSettings, eventJournal = new EventJournal()) {
    this.settings = settings;
    this.eventJournal = eventJournal;
  }

  getSettings() {
    return { ...this.settings };
  }

  setSettings(next: NarrativeSettings) {
    this.settings = next;
  }

  getTickerQueue(): TickerItem[] {
    return [...this.tickerQueue];
  }

  getBudgetInsights(): BudgetInsights | undefined {
    return this.currentBudgetInsights;
  }

  reset() {
    this.lastSnapshot = undefined;
    this.tickerQueue = [];
    this.lastTickerTexts = new Set();
    this.activeAlertByType = new Map();
    this.eventJournal.clear();
    this.currentBudgetInsights = undefined;
  }

  onEvent(event: SimEvent) {
    if (!this.settings.enabled) return;
    this.eventJournal.push(event);
    if (!this.settings.tickerEnabled) return;
    this.applyEventToTicker(event, Date.now());
  }

  onMonthEnd(buildSnapshot: () => CitySnapshot, now = Date.now(), simSpeedMultiplier = 1) {
    const snapshot = buildSnapshot();
    const deltas = computeDeltas(this.lastSnapshot, snapshot);

    if (this.settings.enabled) {
      this.emitMonthlyEvents(snapshot, deltas, now);
      const input: NarrativeInput = {
        snapshot,
        deltas,
        recentEvents: this.eventJournal.latest(30)
      };
      this.currentBudgetInsights = generateBudgetInsights(input);
    }

    this.lastSnapshot = snapshot;
    if (!this.settings.enabled || !this.settings.tickerEnabled) return;

    const input: NarrativeInput = {
      snapshot,
      deltas,
      recentEvents: this.eventJournal.latest(30)
    };
    this.clearMonthEndItems();
    const items = generateTickerItems(input);
    if (items.length === 0) return;

    const safeSpeed = Math.max(0.1, simSpeedMultiplier);
    const expiresAt = now + Math.round(180_000 / safeSpeed);
    for (const item of items) {
      const text = item.text.trim();
      if (!text || this.lastTickerTexts.has(text)) continue;
      this.tickerQueue.push({
        ...item,
        expiresAt: item.expiresAt ?? expiresAt,
        sourceTag: 'month_end'
      });
      this.lastTickerTexts.add(text);
    }
    this.capQueue();
  }

  refreshBudgetInsights(buildSnapshot: () => CitySnapshot) {
    if (!this.settings.enabled) return;
    const snapshot = buildSnapshot();
    const deltas = computeDeltas(this.lastSnapshot, snapshot);
    const input: NarrativeInput = {
      snapshot,
      deltas,
      recentEvents: this.eventJournal.latest(30)
    };
    this.currentBudgetInsights = generateBudgetInsights(input);
  }

  gc(now = Date.now()) {
    const fresh: TickerItem[] = [];
    const nextTextSet = new Set<string>();
    for (const item of this.tickerQueue) {
      if (item.expiresAt !== undefined && item.expiresAt <= now) continue;
      fresh.push(item);
      nextTextSet.add(item.text);
    }
    this.tickerQueue = fresh;
    this.lastTickerTexts = nextTextSet;
    this.capQueue();
  }

  private emitMonthlyEvents(snapshot: CitySnapshot, deltas: ReturnType<typeof computeDeltas>, now: number) {
    if (!this.lastSnapshot) return;

    if (this.lastSnapshot.economy.runwayMonths > RUNWAY_WARN_THRESHOLD_MONTHS && snapshot.economy.runwayMonths <= RUNWAY_WARN_THRESHOLD_MONTHS) {
      const event: SimEvent = {
        id: `runway-low-${now}`,
        type: 'runway_low',
        timestamp: now,
        category: 'economy',
        severity: 'warn',
        message: 'Runway dropped below three months.'
      };
      this.eventJournal.push(event);
      this.applyEventToTicker(event, now);
    } else if (this.lastSnapshot.economy.runwayMonths <= RUNWAY_WARN_THRESHOLD_MONTHS && snapshot.economy.runwayMonths > RUNWAY_WARN_THRESHOLD_MONTHS) {
      const event: SimEvent = {
        id: `runway-recovered-${now}`,
        type: 'runway_recovered',
        timestamp: now,
        category: 'economy',
        severity: 'info',
        message: 'Runway recovered above three months.'
      };
      this.eventJournal.push(event);
      this.applyEventToTicker(event, now);
    }

    if (deltas.abandonedCount >= ABANDONMENT_WAVE_THRESHOLD) {
      const event: SimEvent = {
        id: `abandonment-${now}`,
        type: 'abandonment_wave',
        timestamp: now,
        category: 'growth',
        severity: 'warn',
        message: `Abandonments spiked by ${deltas.abandonedCount}.`
      };
      this.eventJournal.push(event);
    }

    if (deltas.netPerMonthFlip) {
      const event: SimEvent = {
        id: `net-flip-${now}`,
        type: 'net_flip',
        timestamp: now,
        category: 'economy',
        severity: deltas.netPerMonthFlip === 'positive_to_negative' ? 'warn' : 'info',
        message:
          deltas.netPerMonthFlip === 'positive_to_negative'
            ? 'Net income turned negative.'
            : 'Net income turned positive.'
      };
      this.eventJournal.push(event);
    }
  }

  private applyEventToTicker(event: SimEvent, now: number) {
    if (!this.settings.tickerEnabled) return;
    const startToEnd: Partial<Record<SimEventType, SimEventType>> = {
      power_deficit_start: 'power_deficit_end',
      water_deficit_start: 'water_deficit_end',
      runway_low: 'runway_recovered'
    };
    const endToStart: Partial<Record<SimEventType, SimEventType>> = {
      power_deficit_end: 'power_deficit_start',
      water_deficit_end: 'water_deficit_start',
      runway_recovered: 'runway_low'
    };

    if (event.type in endToStart) {
      const startType = endToStart[event.type];
      if (startType) this.removeAlertByType(startType);
      return;
    }

    if (event.type in startToEnd) {
      const existingId = this.activeAlertByType.get(event.type);
      if (existingId) return;
      const text = event.message?.trim();
      if (!text) return;
      const item: TickerItem = {
        text,
        category: event.category,
        severity: event.severity,
        sourceTag: 'event',
        sourceEventType: event.type,
        sourceEventId: event.id
      };
      this.tickerQueue.push(item);
      this.activeAlertByType.set(event.type, event.id);
      this.lastTickerTexts.add(text);
      this.capQueue();
      return;
    }

    const text = event.message?.trim();
    if (!text || this.lastTickerTexts.has(text)) return;
    this.tickerQueue.push({
      text,
      category: event.category,
      severity: event.severity,
      sourceTag: 'event',
      sourceEventType: event.type,
      sourceEventId: event.id,
      expiresAt: now + 60_000
    });
    this.lastTickerTexts.add(text);
    this.capQueue();
  }

  private removeAlertByType(type: SimEventType) {
    if (!this.activeAlertByType.has(type)) return;
    this.tickerQueue = this.tickerQueue.filter((item) => item.sourceEventType !== type);
    this.activeAlertByType.delete(type);
    this.lastTickerTexts = new Set(this.tickerQueue.map((item) => item.text));
  }

  private clearMonthEndItems() {
    if (this.tickerQueue.length === 0) return;
    this.tickerQueue = this.tickerQueue.filter((item) => item.sourceTag !== 'month_end');
    this.lastTickerTexts = new Set(this.tickerQueue.map((item) => item.text));
  }

  private capQueue() {
    const MAX_QUEUE = 30;
    if (this.tickerQueue.length <= MAX_QUEUE) return;
    this.tickerQueue = this.tickerQueue.slice(-MAX_QUEUE);
    this.lastTickerTexts = new Set(this.tickerQueue.map((item) => item.text));
  }
}
