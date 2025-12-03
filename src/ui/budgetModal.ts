import { GameState } from '../game/gameState';
import {
  computeRunwayDays,
  getQuarterSummary,
  getRecentMonths
} from '../game/budget';
import { DAYS_PER_MONTH, getCalendarPosition } from '../game/time';

interface BudgetModalOptions {
  triggerBtn?: HTMLButtonElement;
  getState: () => GameState;
}

function formatCurrency(value: number, opts: { signed?: boolean } = {}) {
  const { signed = false } = opts;
  const abs = Math.abs(value);
  const formatted =
    abs >= 100 ? Math.round(abs).toLocaleString() : abs >= 10 ? abs.toFixed(1) : abs.toFixed(2);
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

function renderBreakdownList(
  title: string,
  entries: {
    label: string;
    value: number;
    total: number;
    tone?: 'positive' | 'negative';
    tooltip?: string;
    depth?: number;
  }[],
  options: { compact?: boolean } = {}
) {
  const { compact = false } = options;
  const maxAbs = entries.reduce((max, entry) => Math.max(max, Math.abs(entry.value)), 0);
  const rows = entries.map((entry) => {
    const pct = maxAbs === 0 ? 0 : Math.min(100, (Math.abs(entry.value) / maxAbs) * 100);
    const barClass = entry.tone === 'negative' ? 'bar-negative' : 'bar-positive';
    const depthClass = entry.depth && entry.depth > 0 ? ' child' : '';
    const indent = entry.depth ? ` style="padding-left:${entry.depth * 12}px"` : '';
    return `
      <div class="budget-row${compact ? ' small' : ''}${depthClass}" ${entry.tooltip ? `title="${entry.tooltip}"` : ''}>
        <div class="budget-row-label"${indent}>${entry.label}</div>
        <div class="budget-row-value">${formatCurrency(entry.value)}</div>
      </div>
      <div class="budget-row-bar">
        <div class="budget-bar ${barClass}" style="width:${pct}%"></div>
      </div>
    `;
  });
  return `
    <div class="budget-section">
      <div class="budget-section-title">${title}</div>
      ${rows.join('')}
    </div>
  `;
}

function renderDetailGroup(
  title: string,
  entries: { label: string; value: number; total: number; tone?: 'positive' | 'negative' }[]
) {
  const visible = entries.filter((e) => e.value !== 0);
  const rows = (visible.length ? visible : entries).map((entry) => ({
    ...entry,
    total: entry.total === 0 ? entries.reduce((sum, e) => sum + Math.abs(e.value), 0) || 1 : entry.total
  }));
  return `
    <div class="budget-detail">
      <div class="budget-detail-title">${title}</div>
      ${renderBreakdownList('', rows, { compact: true })}
    </div>
  `;
}

function renderQuarterSection(state: GameState) {
  const quarter = getQuarterSummary(state);
  const months = getRecentMonths(state);
  const calendar = getCalendarPosition(state.day);
  const monthLabel = `Month ${calendar.month}, Day ${calendar.dayOfMonth}/${DAYS_PER_MONTH}`;
  const monthRows = months
    .map(
      (month) => `
    <div class="budget-row tight">
      <div class="budget-row-label subtle">${month.label}</div>
      <div class="budget-row-value ${month.net >= 0 ? 'positive' : 'negative'}">${formatCurrency(month.net, { signed: true })}</div>
    </div>
  `
    )
    .join('');

  return `
    <div class="budget-section">
      <div class="budget-section-title">Quarterly breakdown</div>
      <div class="budget-hint">${monthLabel} • Quarter covers last ${DAYS_PER_MONTH * 3} days</div>
      <div class="budget-row">
        <div class="budget-row-label">Quarter net</div>
        <div class="budget-row-value ${quarter.net >= 0 ? 'positive' : 'negative'}">${formatCurrency(
    quarter.net,
    { signed: true }
  )}</div>
      </div>
      <div class="budget-row small">
        <div class="budget-row-label">Revenue</div>
        <div class="budget-row-value">${formatCurrency(quarter.revenue)}</div>
      </div>
      <div class="budget-row small">
        <div class="budget-row-label">Expenses</div>
        <div class="budget-row-value">${formatCurrency(quarter.expenses)}</div>
      </div>
      <div class="budget-divider"></div>
      ${monthRows || '<div class="budget-hint">Not enough history yet; play a few days.</div>'}
    </div>
  `;
}

function renderTotal(label: string, value: number, tone?: 'positive' | 'negative') {
  const toneClass = tone ? ` ${tone}` : '';
  return `
    <div class="budget-total">
      <div class="budget-total-label">${label}</div>
      <div class="budget-total-value${toneClass}">${formatCurrency(value)}</div>
    </div>
  `;
}

export function initBudgetModal(options: BudgetModalOptions) {
  const { triggerBtn, getState } = options;

  const open = () => {
    const state = getState();
    const budget = state.budget;
    const runwayDays = computeRunwayDays(state.money, budget.netPerDay);
    const revenueEntries = [
      { label: 'Base', value: toNumber(budget.breakdown.revenue.base), tone: 'positive', tooltip: 'Flat civic stipend each day' },
      {
        label: 'Residential',
        value: toNumber(budget.breakdown.revenue.residents ?? budget.breakdown.revenue.population),
        tone: 'positive',
        tooltip: 'Income from population across residential zones'
      },
      { label: 'Commercial', value: toNumber(budget.breakdown.revenue.commercial), tone: 'positive' },
      { label: 'Industrial', value: toNumber(budget.breakdown.revenue.industrial), tone: 'positive' }
    ];
    const revenueTotal = revenueEntries.reduce((sum, entry) => sum + entry.value, 0);
    const expensesTotal =
      toNumber(budget.breakdown.expenses.transport) + toNumber(budget.breakdown.expenses.buildings);

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'modal budget-modal';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.className = 'secondary modal-close';

    const header = document.createElement('div');
    header.className = 'budget-header';
    const headerText = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'budget-title';
    title.textContent = 'Budget';
    const subtitle = document.createElement('div');
    subtitle.className = 'budget-subtitle';
    subtitle.textContent = 'Quarterly breakdown and runway';
    headerText.appendChild(title);
    headerText.appendChild(subtitle);
    const headerActions = document.createElement('div');
    headerActions.className = 'budget-header-actions';
    headerActions.appendChild(closeBtn);
    header.appendChild(headerText);
    header.appendChild(headerActions);

    const summary = document.createElement('div');
    summary.className = 'budget-summary';
    summary.innerHTML = `
      <div class="summary-card">
        <div class="summary-label">Cash</div>
        <div class="summary-value">${formatCurrency(state.money)}</div>
        <div class="summary-hint">Current funds</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">Net / month</div>
        <div class="summary-value ${budget.netPerMonth >= 0 ? 'positive' : 'negative'}">${formatCurrency(
          budget.netPerMonth,
          { signed: true }
        )}</div>
        <div class="summary-hint">${formatCurrency(budget.netPerDay, { signed: true })} per day</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">Runway</div>
        <div class="summary-value">${formatRunway(runwayDays)}</div>
        <div class="summary-hint">At current burn</div>
      </div>
    `;

    const body = document.createElement('div');
    body.className = 'budget-body';
    const revenueSection = renderBreakdownList(
      'Revenue',
      revenueEntries.map((entry) => ({ ...entry, total: revenueTotal }))
    );

    const roadsValue = toNumber(budget.breakdown.details.transport.roads);
    const railValue = toNumber(budget.breakdown.details.transport.rail);
    const pipesValue = toNumber(budget.breakdown.details.transport.waterPipes);
    const transportTotal = roadsValue + railValue;

    const powerLinesValue = toNumber(budget.breakdown.details.transport.powerLines);
    const powerPlantsTotal = toNumber(budget.breakdown.details.buildings.power);
    const civicTotal = toNumber(budget.breakdown.details.buildings.civic);
    const zoneTotal = toNumber(budget.breakdown.details.buildings.zones);

    const powerPlantDetails = renderBreakdownList('Power Plants', [
      { label: 'Total', value: powerPlantsTotal, total: Math.max(powerPlantsTotal, 1), tone: 'negative' },
      { label: 'Hydro', value: toNumber(budget.breakdown.details.buildings.powerByType.hydro), total: Math.max(powerPlantsTotal, 1), tone: 'negative', depth: 1 },
      { label: 'Coal', value: toNumber(budget.breakdown.details.buildings.powerByType.coal), total: Math.max(powerPlantsTotal, 1), tone: 'negative', depth: 1 },
      { label: 'Wind', value: toNumber(budget.breakdown.details.buildings.powerByType.wind), total: Math.max(powerPlantsTotal, 1), tone: 'negative', depth: 1 },
      { label: 'Solar', value: toNumber(budget.breakdown.details.buildings.powerByType.solar), total: Math.max(powerPlantsTotal, 1), tone: 'negative', depth: 1 }
    ]);

    const transportSection = renderBreakdownList('Transportation', [
      { label: 'Total', value: transportTotal, total: Math.max(transportTotal, 1), tone: 'negative' },
      { label: 'Roads', value: roadsValue, total: Math.max(transportTotal, 1), tone: 'negative', depth: 1 },
      { label: 'Rail', value: railValue, total: Math.max(transportTotal, 1), tone: 'negative', depth: 1 }
    ]);

    const pipesSection = renderBreakdownList('Pipes', [
      { label: 'Total', value: pipesValue, total: Math.max(pipesValue, 1), tone: 'negative' }
    ]);

    const powerSection = renderBreakdownList('Power', [
      { label: 'Total', value: powerLinesValue + powerPlantsTotal, total: Math.max(powerLinesValue + powerPlantsTotal, 1), tone: 'negative' },
      { label: 'Power lines', value: powerLinesValue, total: Math.max(powerLinesValue + powerPlantsTotal, 1), tone: 'negative', depth: 1 },
      { label: 'Power plants', value: powerPlantsTotal, total: Math.max(powerLinesValue + powerPlantsTotal, 1), tone: 'negative', depth: 1 }
    ]);

    const civicSection = renderBreakdownList('Civic', [
      { label: 'Total', value: civicTotal, total: Math.max(civicTotal, 1), tone: 'negative' },
      { label: 'Parks', value: toNumber(budget.breakdown.details.buildings.civicByType.park), total: Math.max(civicTotal, 1), tone: 'negative', depth: 1 },
      { label: 'Water pumps', value: toNumber(budget.breakdown.details.buildings.civicByType.pump), total: Math.max(civicTotal, 1), tone: 'negative', depth: 1 },
      { label: 'Water towers', value: toNumber(budget.breakdown.details.buildings.civicByType.water_tower), total: Math.max(civicTotal, 1), tone: 'negative', depth: 1 }
    ]);

    const zoneDetails = renderBreakdownList('Zones', [
      { label: 'Total', value: zoneTotal, total: Math.max(zoneTotal, 1), tone: 'negative' },
      { label: 'Residential', value: toNumber(budget.breakdown.details.buildings.zonesByType.residential), total: Math.max(zoneTotal, 1), tone: 'negative', depth: 1 },
      { label: 'Commercial', value: toNumber(budget.breakdown.details.buildings.zonesByType.commercial), total: Math.max(zoneTotal, 1), tone: 'negative', depth: 1 },
      { label: 'Industrial', value: toNumber(budget.breakdown.details.buildings.zonesByType.industrial), total: Math.max(zoneTotal, 1), tone: 'negative', depth: 1 }
    ]);

    const pipesTotal = pipesValue;
    const expensesSection = renderBreakdownList('Expenses', [
      { label: 'Transportation', value: transportTotal, total: expensesTotal, tone: 'negative' },
      { label: 'Pipes', value: pipesTotal, total: expensesTotal, tone: 'negative' },
      { label: 'Power', value: powerLinesValue + powerPlantsTotal, total: expensesTotal, tone: 'negative' },
      { label: 'Civic', value: civicTotal, total: expensesTotal, tone: 'negative' },
      { label: 'Zones', value: zoneTotal, total: expensesTotal, tone: 'negative' }
    ]);

    body.innerHTML = `
      <div class="budget-column">
        ${renderQuarterSection(state)}
      </div>
      <div class="budget-column">
        ${renderTotal('Revenue total', revenueTotal, revenueTotal >= 0 ? 'positive' : 'negative')}
        ${revenueSection}
        <div class="budget-divider"></div>
        ${renderTotal('Expenses total', expensesTotal, 'negative')}
        ${expensesSection}
        <div class="budget-detail-hint">Subsections below are already counted in the totals above (no double counting).</div>
        <div class="budget-subsection">
          ${transportSection}
          <div class="budget-divider subtle"></div>
          ${powerSection}
          ${powerPlantDetails}
          <div class="budget-divider subtle"></div>
          ${civicSection}
          <div class="budget-divider subtle"></div>
          ${zoneDetails}
        </div>
      </div>
    `;

    const footer = document.createElement('div');
    footer.className = 'budget-footer';
    footer.textContent = 'Tip: bulldoze idle lines or roads to trim transport costs; grow population/jobs to lift revenue.';

    modal.appendChild(header);
    modal.appendChild(summary);
    modal.appendChild(body);
    modal.appendChild(footer);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cleanup();
    };
    const cleanup = () => {
      window.removeEventListener('keydown', handleKey);
      backdrop.remove();
    };
    closeBtn.addEventListener('click', cleanup);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) cleanup();
    });
    window.addEventListener('keydown', handleKey);
  };

  triggerBtn?.addEventListener('click', open);
  return { open };
}
