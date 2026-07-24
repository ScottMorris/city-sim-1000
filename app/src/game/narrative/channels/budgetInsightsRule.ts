import type { BudgetInsights, NarrativeInput } from '../types';
import { formatCurrency } from '../../../utils/currency';

const MAX_TOP_CHANGES = 3;
const MAX_DRIVERS = 4;
const MAX_RISKS = 3;

const LIMITS = {
  label: 40,
  value: 24,
  explanation: 120,
  note: 120,
  recommendation: 200
};

type ChangeCandidate = {
  label: string;
  value: string;
  direction: 'up' | 'down';
  score: number;
};

const clampText = (text: string, max: number) => {
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  return `${text.slice(0, max - 3)}...`;
};

const formatNumber = (value: number, unit?: string) => {
  const abs = Math.abs(value);
  const rounded = abs >= 10 ? Math.round(abs) : Math.round(abs * 10) / 10;
  const label = unit ? `${rounded.toFixed(abs >= 10 ? 0 : 1)} ${unit}` : `${rounded.toFixed(abs >= 10 ? 0 : 1)}`;
  return label.replace(/\.0\b/, '');
};

const formatSignedNumber = (value: number, unit?: string) => {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${formatNumber(value, unit)}`;
};

const formatSignedCurrency = (value: number, suffix?: string) => {
  const base = formatCurrency(value, { signed: true });
  return suffix ? `${base}${suffix}` : base;
};

const clampInsightText = (insights: BudgetInsights): BudgetInsights => ({
  topChanges: insights.topChanges.map((entry) => ({
    ...entry,
    label: clampText(entry.label, LIMITS.label),
    value: clampText(entry.value, LIMITS.value)
  })),
  drivers: insights.drivers.map((entry) => ({
    ...entry,
    label: clampText(entry.label, LIMITS.label),
    explanation: clampText(entry.explanation, LIMITS.explanation)
  })),
  risks: insights.risks.map((entry) => ({
    ...entry,
    label: clampText(entry.label, LIMITS.label),
    note: clampText(entry.note, LIMITS.note)
  })),
  recommendation: clampText(insights.recommendation, LIMITS.recommendation),
  tooltips: insights.tooltips
});

const addChangeCandidate = (
  candidates: ChangeCandidate[],
  label: string,
  delta: number,
  value: string,
  weight: number
) => {
  candidates.push({
    label,
    value,
    direction: delta >= 0 ? 'up' : 'down',
    score: Math.abs(delta) * weight
  });
};

const getLargestBreakdown = (entries: Record<string, number>) => {
  const list = Object.entries(entries);
  if (list.length === 0) return null;
  return list.reduce(
    (best, current) => (Math.abs(current[1]) > Math.abs(best[1]) ? current : best),
    list[0]
  );
};

export function generateBudgetInsights(input: NarrativeInput): BudgetInsights {
  const { snapshot, deltas } = input;
  const candidates: ChangeCandidate[] = [];

  addChangeCandidate(
    candidates,
    'Cash',
    deltas.cash,
    formatSignedCurrency(deltas.cash),
    0.001
  );
  addChangeCandidate(
    candidates,
    'Net / month',
    deltas.netPerMonth,
    `${formatSignedCurrency(deltas.netPerMonth)}/mo`,
    0.01
  );
  addChangeCandidate(
    candidates,
    'Runway',
    deltas.runwayMonths,
    formatSignedNumber(deltas.runwayMonths, 'mo'),
    1
  );
  addChangeCandidate(
    candidates,
    'Power balance',
    deltas.powerBalance,
    formatSignedNumber(deltas.powerBalance, 'MW'),
    0.2
  );
  addChangeCandidate(
    candidates,
    'Population',
    deltas.pop,
    formatSignedNumber(deltas.pop),
    0.05
  );
  addChangeCandidate(
    candidates,
    'Jobs',
    deltas.jobs,
    formatSignedNumber(deltas.jobs),
    0.05
  );

  const topChanges = candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_TOP_CHANGES)
    .map((entry) => ({
      label: entry.label,
      value: entry.value,
      direction: entry.direction
    }));

  const drivers: BudgetInsights['drivers'] = [];
  const netPerMonth = snapshot.economy.netPerMonth;
  const netLine =
    netPerMonth < 0
      ? `Net is ${formatCurrency(netPerMonth)} per month.`
      : `Net is ${formatCurrency(netPerMonth, { signed: true })} per month.`;
  drivers.push({ label: 'Monthly balance', explanation: netLine });

  const expenseBreakdown = snapshot.economy.breakdown?.expenses ?? {};
  const largestExpense = getLargestBreakdown(expenseBreakdown);
  if (largestExpense) {
    const [key] = largestExpense;
    const label = key === 'transport' ? 'Transport upkeep' : 'Building upkeep';
    drivers.push({
      label: 'Largest expense',
      explanation: `${label} is the biggest cost line right now.`
    });
  }

  const revenueBreakdown = snapshot.economy.breakdown?.revenue ?? {};
  const largestRevenue = getLargestBreakdown(revenueBreakdown);
  if (largestRevenue) {
    const [key] = largestRevenue;
    const label =
      key === 'residents'
        ? 'Residential income'
        : key === 'commercial'
          ? 'Commercial income'
          : key === 'industrial'
            ? 'Industrial income'
            : 'Base income';
    drivers.push({
      label: 'Top revenue line',
      explanation: `${label} is the strongest revenue contributor.`
    });
  }

  if (snapshot.economy.runwayMonths <= 6) {
    drivers.push({
      label: 'Runway',
      explanation: `Runway sits at ${formatNumber(snapshot.economy.runwayMonths, 'months')} at the current burn.`
    });
  }

  const trimmedDrivers = drivers.slice(0, MAX_DRIVERS);

  const risks: BudgetInsights['risks'] = [];
  if (snapshot.economy.runwayMonths <= 3) {
    risks.push({
      label: 'Short runway',
      severity: 'high',
      note: `Runway at ${formatNumber(snapshot.economy.runwayMonths, 'months')} leaves little buffer.`
    });
  }

  if (snapshot.utilities.powerBalance < 0) {
    const severity = snapshot.utilities.powerBalance <= -5 ? 'high' : 'med';
    risks.push({
      label: 'Power deficit',
      severity,
      note: `Power is short by ${formatNumber(Math.abs(snapshot.utilities.powerBalance), 'MW')}, which can cap growth.`
    });
  }

  if (deltas.abandonedCount >= 5) {
    risks.push({
      label: 'Abandonments',
      severity: deltas.abandonedCount >= 10 ? 'high' : 'med',
      note: `Abandonments rose by ${Math.round(deltas.abandonedCount)} this month.`
    });
  }

  if (risks.length === 0) {
    risks.push({
      label: 'Stability',
      severity: 'low',
      note: 'No immediate red flags in the latest monthly deltas.'
    });
  }

  const trimmedRisks = risks.slice(0, MAX_RISKS);

  let recommendation = 'Maintain the current mix and watch net and runway as you expand.';
  if (snapshot.economy.runwayMonths <= 3) {
    recommendation =
      'Runway is short; stabilising monthly net will prevent forced cuts later.';
  } else if (snapshot.utilities.powerBalance < 0) {
    recommendation =
      'Power deficits are likely limiting growth; consider adding generation before expanding zoning.';
  } else if (deltas.abandonedCount >= 5) {
    recommendation =
      'Recent abandonments suggest trouble spots; check power, roads, and demand balance before expanding.';
  } else if (snapshot.economy.netPerMonth < 0) {
    recommendation =
      'Monthly net is negative; bringing expenses in line with income will steady cash.';
  }

  return clampInsightText({
    topChanges,
    drivers: trimmedDrivers,
    risks: trimmedRisks,
    recommendation
  });
}
