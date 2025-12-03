import { GameState } from '../game/gameState';
import {
  computeRunwayDays,
  getQuarterSummary,
  getRecentMonths
} from '../game/budget';
import { DAYS_PER_MONTH, getCalendarPosition } from '../game/time';

interface BudgetModalOptions {
  triggerBtn: HTMLButtonElement;
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

function renderBreakdownList(
  title: string,
  entries: { label: string; value: number; total: number; tone?: 'positive' | 'negative' }[]
) {
  const rows = entries.map((entry) => {
    const pct = entry.total === 0 ? 0 : Math.min(100, (Math.abs(entry.value) / entry.total) * 100);
    const barClass = entry.tone === 'negative' ? 'bar-negative' : 'bar-positive';
    return `
      <div class="budget-row">
        <div class="budget-row-label">${entry.label}</div>
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

export function initBudgetModal(options: BudgetModalOptions) {
  const { triggerBtn, getState } = options;

  const open = () => {
    const state = getState();
    const budget = state.budget;
    const runwayDays = computeRunwayDays(state.money, budget.netPerDay);
    const revenueTotal = budget.breakdown.revenue.base + budget.breakdown.revenue.population + budget.breakdown.revenue.commercial + budget.breakdown.revenue.industrial;
    const expensesTotal = budget.breakdown.expenses.transport + budget.breakdown.expenses.buildings;

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
    const revenueSection = renderBreakdownList('Revenue', [
      { label: 'Base', value: budget.breakdown.revenue.base, total: revenueTotal, tone: 'positive' },
      { label: 'Population', value: budget.breakdown.revenue.population, total: revenueTotal, tone: 'positive' },
      { label: 'Commercial zones', value: budget.breakdown.revenue.commercial, total: revenueTotal, tone: 'positive' },
      { label: 'Industrial zones', value: budget.breakdown.revenue.industrial, total: revenueTotal, tone: 'positive' }
    ]);
    const expenseSection = renderBreakdownList('Expenses', [
      { label: 'Transport upkeep', value: budget.breakdown.expenses.transport, total: expensesTotal, tone: 'negative' },
      { label: 'Buildings upkeep', value: budget.breakdown.expenses.buildings, total: expensesTotal, tone: 'negative' }
    ]);

    body.innerHTML = `
      <div class="budget-column">
        ${renderQuarterSection(state)}
      </div>
      <div class="budget-column">
        ${revenueSection}
        <div class="budget-divider"></div>
        ${expenseSection}
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

  triggerBtn.addEventListener('click', open);
  return { open };
}
