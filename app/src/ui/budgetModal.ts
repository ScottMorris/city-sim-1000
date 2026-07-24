// budgetModal.ts — the City Ledger: money-flow bars, per-type expense tree,
// quarterly trend, narrative insights, and live tax/funding sliders.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { GameState } from '../game/gameState';
import { showToast } from './dialogs';
import { computeRunwayDays, getQuarterSummary, getRecentMonths } from '../game/economy';
import { DAYS_PER_MONTH, getCalendarPosition } from '../game/time';
import { DEFAULT_BYLAWS, LIGHTING_POLICIES, applyLightingPolicy } from '../game/bylaws';
import { computeLightingBaseStats } from '../game/bylawAnalytics';
import type { BudgetInsights } from '../game/narrative/types';
import {
  clampBudgetPolicy,
  MAX_FUNDING,
  MAX_TAX_RATE,
  NEUTRAL_TAX_RATE,
  type BudgetPolicy
} from '../game/protocol/commands';

interface BudgetModalOptions {
  triggerBtn?: HTMLButtonElement;
  getState: () => GameState;
  getNarrativeEnabled?: () => boolean;
  getBudgetInsights?: () => BudgetInsights | undefined;
  refreshBudgetInsights?: () => void;
  /** Called whenever the player moves a tax/funding slider. */
  onPolicyChange?: (policy: BudgetPolicy) => void;
}

/** How often the open ledger re-reads the sim state (ms). */
const LIVE_REFRESH_MS = 600;

export function formatCurrency(value: number, opts: { signed?: boolean } = {}) {
  const { signed = false } = opts;
  const abs = Math.abs(value);
  const formatted = abs >= 100 ? Math.round(abs).toLocaleString() : abs.toFixed(2);
  const sign = signed ? (value > 0 ? '+' : value < 0 ? '-' : '') : '';
  return `${sign}$${formatted}`;
}

function formatRunway(runwayDays: number) {
  if (!Number.isFinite(runwayDays)) return '∞';
  if (runwayDays <= 0) return '0 days';
  if (runwayDays < 10) return `${runwayDays.toFixed(1)} days`;
  return `${Math.floor(runwayDays)} days`;
}

function toNumber(value: number | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Ledger data model — categories with subrows, no double counting
// ---------------------------------------------------------------------------

interface LedgerRow {
  label: string;
  value: number;
  colour?: string;
  subrows?: LedgerRow[];
}

function revenueRows(state: GameState): LedgerRow[] {
  const r = state.budget.breakdown.revenue;
  const rows: LedgerRow[] = [
    { label: 'Base stipend', value: toNumber(r.base), colour: '#7bffb7' },
    { label: 'Residential taxes', value: toNumber(r.residents), colour: '#5ee6a0' },
    { label: 'Commercial taxes', value: toNumber(r.commercial), colour: '#5bc0eb' },
    { label: 'Industrial taxes', value: toNumber(r.industrial), colour: '#f0a860' }
  ];
  // Only shown once the wilderness score has earned it — keeps the ledger
  // clean for players who ignore the mechanic.
  if (toNumber(r.tourism) > 0) {
    rows.push({ label: '🌲 Tourism dividend', value: toNumber(r.tourism), colour: '#8ee08e' });
  }
  return rows;
}

function expenseRows(state: GameState): LedgerRow[] {
  const d = state.budget.breakdown.details;
  const powerBy = d.buildings.powerByType ?? {};
  const civicBy = d.buildings.civicByType ?? {};
  const zonesBy = d.buildings.zonesByType ?? {};
  const roads = toNumber(d.transport.roads);
  const rail = toNumber(d.transport.rail);
  const lines = toNumber(d.transport.powerLines);
  const pipes = toNumber(d.transport.waterPipes);
  const plants = toNumber(d.buildings.power);
  const civic = toNumber(d.buildings.civic);
  const zones = toNumber(d.buildings.zones);
  return [
    {
      label: 'Transportation',
      value: roads + rail,
      colour: '#ff8c8c',
      subrows: [
        { label: 'Roads', value: roads },
        { label: 'Rail', value: rail }
      ]
    },
    {
      label: 'Power',
      value: lines + plants,
      colour: '#ffcc70',
      subrows: [
        { label: 'Power lines', value: lines },
        { label: 'Hydro plants', value: toNumber(powerBy.hydro) },
        { label: 'Coal plants', value: toNumber(powerBy.coal) },
        { label: 'Wind turbines', value: toNumber(powerBy.wind) },
        { label: 'Solar farms', value: toNumber(powerBy.solar) }
      ]
    },
    {
      label: 'Civic & water',
      value: civic + pipes,
      colour: '#9dd9ff',
      subrows: [
        { label: 'Parks', value: toNumber(civicBy.park) },
        { label: 'Water pumps', value: toNumber(civicBy.pump) },
        { label: 'Water towers', value: toNumber(civicBy.water_tower) },
        { label: 'Schools', value: toNumber(civicBy.school) },
        { label: 'Water pipes', value: pipes }
      ]
    },
    {
      label: 'Zones',
      value: zones,
      colour: '#c39dff',
      subrows: [
        { label: 'Residential', value: toNumber(zonesBy.residential) },
        { label: 'Commercial', value: toNumber(zonesBy.commercial) },
        { label: 'Industrial', value: toNumber(zonesBy.industrial) }
      ]
    },
    // Only present while a wilderness programme is active (Bylaws screen).
    ...(toNumber(state.budget.breakdown.expenses.policies) > 0
      ? [{
          label: '🌿 Wilderness programmes',
          value: toNumber(state.budget.breakdown.expenses.policies),
          colour: '#8ee08e'
        }]
      : [])
  ];
}

// ---------------------------------------------------------------------------
// Rendering — flow bars, ledger tree, quarter strip, insights
// ---------------------------------------------------------------------------

function renderFlowBar(title: string, total: number, rows: LedgerRow[], scale: number): string {
  const segments = rows
    .filter((row) => row.value > 0)
    .map((row) => {
      const pct = scale > 0 ? (row.value / scale) * 100 : 0;
      return `<div class="ledger-flow-segment" style="width:${pct}%;background:${row.colour ?? '#7bffb7'}" title="${escapeHtml(row.label)}: ${formatCurrency(row.value)} / day"></div>`;
    })
    .join('');
  return `
    <div class="ledger-flow">
      <div class="ledger-flow-header">
        <span>${title}</span>
        <strong>${formatCurrency(total)} / day</strong>
      </div>
      <div class="ledger-flow-bar">${segments || '<div class="ledger-flow-empty">nothing yet</div>'}</div>
    </div>
  `;
}

function renderLedgerRows(rows: LedgerRow[], rowScale: number): string {
  return rows
    .map((row) => {
      const pct = rowScale > 0 ? Math.min(100, (row.value / rowScale) * 100) : 0;
      const subrows = (row.subrows ?? [])
        .filter((sub) => sub.value !== 0)
        .map(
          (sub) => `
            <div class="ledger-subrow">
              <span class="ledger-subrow-label">${escapeHtml(sub.label)}</span>
              <span class="ledger-subrow-value">${formatCurrency(sub.value)}</span>
            </div>`
        )
        .join('');
      return `
        <div class="ledger-row${row.value === 0 ? ' ledger-row-zero' : ''}">
          <div class="ledger-row-top">
            <span class="ledger-row-swatch" style="background:${row.colour ?? '#7bffb7'}"></span>
            <span class="ledger-row-label">${escapeHtml(row.label)}</span>
            <span class="ledger-row-value">${formatCurrency(row.value)}</span>
          </div>
          <div class="ledger-row-bar"><div style="width:${pct}%;background:${row.colour ?? '#7bffb7'}"></div></div>
          ${subrows}
        </div>
      `;
    })
    .join('');
}

function renderQuarterStrip(state: GameState): string {
  const quarter = getQuarterSummary(state);
  const months = getRecentMonths(state);
  const calendar = getCalendarPosition(state.day);
  const maxAbs = months.reduce((max, m) => Math.max(max, Math.abs(m.net)), 1);
  const bars = months
    .map((month) => {
      const height = Math.max(8, (Math.abs(month.net) / maxAbs) * 34);
      const tone = month.net >= 0 ? 'positive' : 'negative';
      return `
        <div class="ledger-month" title="${escapeHtml(month.label)}: ${formatCurrency(month.net, { signed: true })}">
          <div class="ledger-month-bar ${tone}" style="height:${height}px"></div>
          <div class="ledger-month-label">${escapeHtml(month.label.replace('Month ', 'M'))}</div>
        </div>`;
    })
    .join('');
  return `
    <div class="ledger-quarter">
      <div class="ledger-strip-title">Quarter</div>
      <div class="ledger-months">${bars || '<div class="budget-hint">Not enough history yet; play a few days.</div>'}</div>
      <div class="ledger-quarter-net">
        Net <strong class="${quarter.net >= 0 ? 'positive' : 'negative'}">${formatCurrency(quarter.net, { signed: true })}</strong>
        <span class="budget-hint">Month ${calendar.month}, Day ${calendar.dayOfMonth}/${DAYS_PER_MONTH} • last ${DAYS_PER_MONTH * 3} days</span>
      </div>
    </div>
  `;
}

function renderInsightsStrip(insights: BudgetInsights | undefined, enabled: boolean): string {
  if (!enabled) return '';
  if (!insights) {
    return '<div class="ledger-insights"><div class="ledger-strip-title">Advisor</div><div class="budget-hint">No insights available yet.</div></div>';
  }
  const risk = insights.risks[0];
  const driver = insights.drivers[0];
  return `
    <div class="ledger-insights">
      <div class="ledger-strip-title">Advisor</div>
      ${driver ? `<div class="ledger-insight"><strong>${escapeHtml(driver.label)}</strong> ${escapeHtml(driver.explanation)}</div>` : ''}
      ${risk ? `<div class="ledger-insight" data-severity="${risk.severity}"><strong>${escapeHtml(risk.label)}</strong> ${escapeHtml(risk.note)}</div>` : ''}
      <div class="ledger-insight ledger-recommendation">${escapeHtml(insights.recommendation)}</div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// City Hall sliders
// ---------------------------------------------------------------------------

interface SliderSpec {
  key: keyof BudgetPolicy;
  label: string;
  max: number;
  neutral: number;
  unit: string;
  hint?: string;
}

const TAX_SLIDERS: SliderSpec[] = [
  { key: 'taxResidential', label: '🏘️ Residential', max: MAX_TAX_RATE, neutral: NEUTRAL_TAX_RATE, unit: '%' },
  { key: 'taxCommercial', label: '🏪 Commercial', max: MAX_TAX_RATE, neutral: NEUTRAL_TAX_RATE, unit: '%' },
  { key: 'taxIndustrial', label: '🏭 Industrial', max: MAX_TAX_RATE, neutral: NEUTRAL_TAX_RATE, unit: '%' }
];

const FUNDING_SLIDERS: SliderSpec[] = [
  { key: 'fundTransport', label: '🛣️ Transport', max: MAX_FUNDING, neutral: MAX_FUNDING, unit: '%', hint: 'Low funding frustrates commuters (demand drag).' },
  { key: 'fundPower', label: '⚡ Power', max: MAX_FUNDING, neutral: MAX_FUNDING, unit: '%', hint: 'Low funding browns out — plants lose output.' },
  { key: 'fundCivic', label: '🏛️ Civic & water', max: MAX_FUNDING, neutral: MAX_FUNDING, unit: '%', hint: 'Low funding crowds schools and services.' }
];

// ---------------------------------------------------------------------------
// initBudgetModal
// ---------------------------------------------------------------------------

export function initBudgetModal(options: BudgetModalOptions) {
  const {
    triggerBtn,
    getState,
    getNarrativeEnabled,
    getBudgetInsights,
    refreshBudgetInsights,
    onPolicyChange
  } = options;
  let backdrop: HTMLDivElement | null = null;
  let escHandler: ((e: KeyboardEvent) => void) | null = null;
  let refreshTimer: number | null = null;

  const cleanup = () => {
    if (escHandler) {
      window.removeEventListener('keydown', escHandler);
      escHandler = null;
    }
    if (refreshTimer !== null) {
      window.clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (backdrop) {
      backdrop.remove();
      backdrop = null;
    }
  };

  const open = () => {
    if (backdrop) return;
    const narrativeEnabled = getNarrativeEnabled?.() ?? false;
    if (narrativeEnabled) refreshBudgetInsights?.();

    backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'modal budget-modal';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.className = 'secondary modal-close';

    const header = document.createElement('div');
    header.className = 'budget-header';
    header.innerHTML = `
      <div>
        <div class="budget-title">City Ledger</div>
        <div class="budget-subtitle">Where the money comes from, where it goes — and the levers</div>
      </div>
    `;
    const headerActions = document.createElement('div');
    headerActions.className = 'budget-header-actions';
    headerActions.appendChild(closeBtn);
    header.appendChild(headerActions);

    const summary = document.createElement('div');
    summary.className = 'budget-summary';

    const body = document.createElement('div');
    body.className = 'budget-body ledger-body';
    const ledgerCol = document.createElement('div');
    ledgerCol.className = 'budget-column ledger-main';
    const policyCol = document.createElement('div');
    policyCol.className = 'budget-column ledger-policy';
    body.appendChild(ledgerCol);
    body.appendChild(policyCol);

    const strip = document.createElement('div');
    strip.className = 'ledger-strip';
    // No hover on touch — `.ledger-month`'s exact net-per-month figure
    // (renderQuarterStrip's `title`) is otherwise only readable via the
    // relative bar height. `strip`'s own innerHTML is replaced wholesale on
    // every renderLive() tick, so this listener is delegated (attached once
    // to the stable `strip` node) rather than re-bound to each bar.
    strip.addEventListener('click', (e) => {
      const month = (e.target as HTMLElement).closest<HTMLElement>('.ledger-month');
      if (month?.title) showToast(month.title, { id: 'ledger-month-detail', durationMs: 4000 });
    });

    // --- City Hall sliders (built once; live labels updated in place) ---
    const pendingPolicy: BudgetPolicy = { ...getState().policies.budget };
    const valueLabels = new Map<keyof BudgetPolicy, HTMLElement>();

    const buildSliderSection = (title: string, specs: SliderSpec[]) => {
      const section = document.createElement('div');
      section.className = 'ledger-policy-section';
      const heading = document.createElement('div');
      heading.className = 'ledger-strip-title';
      heading.textContent = title;
      section.appendChild(heading);
      for (const spec of specs) {
        const row = document.createElement('div');
        row.className = 'ledger-slider-row';
        const top = document.createElement('div');
        top.className = 'ledger-slider-top';
        const label = document.createElement('span');
        label.textContent = spec.label;
        const value = document.createElement('span');
        value.className = 'ledger-slider-value';
        value.textContent = `${pendingPolicy[spec.key]}${spec.unit}`;
        valueLabels.set(spec.key, value);
        top.append(label, value);
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = String(spec.max);
        slider.step = '1';
        slider.value = String(pendingPolicy[spec.key]);
        slider.className = 'ledger-slider';
        slider.setAttribute('aria-label', `${spec.label} ${spec.unit === '%' ? 'rate' : 'level'}`);
        slider.addEventListener('input', () => {
          pendingPolicy[spec.key] = Number(slider.value);
          value.textContent = `${slider.value}${spec.unit}`;
          value.classList.toggle('off-neutral', Number(slider.value) !== spec.neutral);
          onPolicyChange?.(clampBudgetPolicy({ ...pendingPolicy }));
        });
        row.append(top, slider);
        if (spec.hint) {
          const hint = document.createElement('div');
          hint.className = 'budget-hint';
          hint.textContent = spec.hint;
          row.appendChild(hint);
        }
        section.appendChild(row);
      }
      return section;
    };

    policyCol.innerHTML = '<div class="ledger-policy-heading">🏛️ City Hall</div>';
    policyCol.appendChild(buildSliderSection('Tax rates (neutral 9%)', TAX_SLIDERS));
    policyCol.appendChild(buildSliderSection('Department funding', FUNDING_SLIDERS));
    const policyFootnote = document.createElement('div');
    policyFootnote.className = 'budget-hint ledger-policy-footnote';
    policyFootnote.textContent =
      'Changes apply immediately — watch the ledger react live. Taxes above 9% squeeze demand.';
    policyCol.appendChild(policyFootnote);

    // --- Live sections ---
    const renderLive = () => {
      const state = getState();
      const budget = state.budget;
      const runwayDays = computeRunwayDays(state.money, budget.netPerDay);
      const lighting = state.bylaws?.lighting ?? DEFAULT_BYLAWS.lighting;
      const lightingPolicy = LIGHTING_POLICIES[lighting];
      const lightingBase = computeLightingBaseStats(state);
      const baselineLighting = applyLightingPolicy(lightingBase, DEFAULT_BYLAWS.lighting);
      const activeLighting = applyLightingPolicy(lightingBase, lighting);
      const lightingPowerDelta = activeLighting.powerUse - baselineLighting.powerUse;
      const lightingUpkeepDeltaPerMonth = (activeLighting.maintenance - baselineLighting.maintenance) * 9;

      summary.innerHTML = `
        <div class="summary-card">
          <div class="summary-label">Cash</div>
          <div class="summary-value">${formatCurrency(state.money)}</div>
          <div class="summary-hint">Current funds</div>
        </div>
        <div class="summary-card">
          <div class="summary-label">Net / month</div>
          <div class="summary-value ${budget.netPerMonth >= 0 ? 'positive' : 'negative'}">${formatCurrency(budget.netPerMonth, { signed: true })}</div>
          <div class="summary-hint">${formatCurrency(budget.netPerDay, { signed: true })} per day</div>
        </div>
        <div class="summary-card">
          <div class="summary-label">Runway</div>
          <div class="summary-value">${formatRunway(runwayDays)}</div>
          <div class="summary-hint">At current burn</div>
        </div>
        <div class="summary-card">
          <div class="summary-label">Lighting bylaw</div>
          <div class="summary-value">${escapeHtml(lightingPolicy.label)}</div>
          <div class="summary-hint">Power ${lightingPowerDelta >= 0 ? '+' : ''}${lightingPowerDelta.toFixed(2)} MW • Upkeep ${formatCurrency(lightingUpkeepDeltaPerMonth, { signed: true })} / mo</div>
        </div>
      `;

      const revenue = revenueRows(state);
      const expenses = expenseRows(state);
      const revenueTotal = revenue.reduce((sum, row) => sum + row.value, 0);
      const expensesTotal = expenses.reduce((sum, row) => sum + row.value, 0);
      const flowScale = Math.max(revenueTotal, expensesTotal, 1);
      const rowScale = Math.max(...revenue.map((r) => r.value), ...expenses.map((r) => r.value), 1);

      ledgerCol.innerHTML = `
        ${renderFlowBar('Where money comes from', revenueTotal, revenue, flowScale)}
        ${renderFlowBar('Where money goes', expensesTotal, expenses, flowScale)}
        <div class="ledger-columns">
          <div class="ledger-list">
            <div class="ledger-list-title">Revenue</div>
            ${renderLedgerRows(revenue, rowScale)}
          </div>
          <div class="ledger-list">
            <div class="ledger-list-title">Expenses</div>
            ${renderLedgerRows(expenses, rowScale)}
          </div>
        </div>
      `;

      const insights = narrativeEnabled ? getBudgetInsights?.() : undefined;
      strip.innerHTML = `
        ${renderQuarterStrip(state)}
        ${renderInsightsStrip(insights, narrativeEnabled)}
      `;

      // Sliders reflect external policy changes (e.g. a loaded save).
      const current = state.policies.budget;
      for (const [key, label] of valueLabels) {
        const spec = [...TAX_SLIDERS, ...FUNDING_SLIDERS].find((s) => s.key === key);
        if (!spec) continue;
        if (pendingPolicy[key] !== current[key]) {
          pendingPolicy[key] = current[key];
          const slider = label.parentElement?.parentElement?.querySelector<HTMLInputElement>('input.ledger-slider');
          if (slider && document.activeElement !== slider) slider.value = String(current[key]);
          label.textContent = `${current[key]}${spec.unit}`;
        }
        label.classList.toggle('off-neutral', current[key] !== spec.neutral);
      }
    };

    renderLive();
    refreshTimer = window.setInterval(renderLive, LIVE_REFRESH_MS);

    const footer = document.createElement('div');
    footer.className = 'budget-footer';
    footer.textContent =
      'Tip: taxes above 9% raise cash but cool demand; funding below 100% saves upkeep but has consequences.';

    // Everything except the header scrolls as one region — on a small
    // viewport (M2-5) the summary cards + ledger + quarterly strip + footer
    // together are taller than the modal, and without a single shared scroll
    // container each of those non-shrinking flex siblings just squeezed
    // `body`'s `flex: 1` down to nothing rather than yielding space.
    const scrollArea = document.createElement('div');
    scrollArea.className = 'budget-scroll';
    scrollArea.append(summary, body, strip, footer);

    modal.appendChild(header);
    modal.appendChild(scrollArea);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cleanup();
    };
    closeBtn.addEventListener('click', cleanup);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) cleanup();
    });
    window.addEventListener('keydown', escHandler);
  };

  triggerBtn?.addEventListener('click', open);
  return { open, close: cleanup };
}
