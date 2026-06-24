import { projectLightingPolicy } from '../game/bylawAnalytics';
import { DEFAULT_BYLAWS, LIGHTING_POLICIES, type LightingBylaw } from '../game/bylaws';
import type { GameState } from '../game/gameState';
import { showToast } from './dialogs';

type BylawsModalOptions = {
  getState: () => GameState;
  onSelectLighting: (lighting: LightingBylaw) => void;
  onClose?: () => void;
};

const MONTHLY_EXPENSE_FACTOR = 9; // Mirror the sim's net-per-day/month conversion.

function formatDelta(
  value: number,
  options: { unit?: string; currency?: boolean; precision?: number } = {}
): string {
  const precision = options.precision ?? 1;
  const prefix = options.currency ? '$' : '';
  const unit = options.unit ?? '';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  const absolute = Math.abs(value).toFixed(precision);
  return `${sign}${prefix}${absolute}${unit ? ` ${unit}` : ''}`;
}

function createDeltaPill(
  label: string,
  delta: number,
  options: { unit?: string; currency?: boolean; precision?: number } = {}
) {
  const pill = document.createElement('div');
  pill.className = 'bylaws-delta';
  if (delta < 0) pill.classList.add('negative');
  if (delta > 0) pill.classList.add('positive');
  const title = document.createElement('div');
  title.className = 'bylaws-delta-label';
  title.textContent = label;
  const value = document.createElement('div');
  value.className = 'bylaws-delta-value';
  value.textContent = formatDelta(delta, options);
  pill.append(title, value);
  return pill;
}

export function initBylawsModal(options: BylawsModalOptions) {
  const { getState, onSelectLighting, onClose } = options;
  let backdrop: HTMLDivElement | null = null;
  let escHandler: ((event: KeyboardEvent) => void) | null = null;

  const cleanup = () => {
    if (escHandler) {
      window.removeEventListener('keydown', escHandler);
      escHandler = null;
    }
    if (backdrop) {
      backdrop.remove();
      backdrop = null;
    }
    onClose?.();
  };

  const open = () => {
    if (backdrop) return;

    backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'modal bylaws-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'City bylaws');

    const header = document.createElement('div');
    header.className = 'bylaws-header';

    const heading = document.createElement('div');
    heading.className = 'bylaws-title';
    heading.textContent = 'Bylaws';

    const subtitle = document.createElement('div');
    subtitle.className = 'bylaws-subtitle';
    subtitle.textContent = 'City-wide policies live here; districts will layer on later.';

    const titleBlock = document.createElement('div');
    titleBlock.className = 'bylaws-title-block';
    titleBlock.append(heading, subtitle);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.className = 'secondary modal-close';
    closeBtn.type = 'button';

    const headerActions = document.createElement('div');
    headerActions.className = 'bylaws-header-actions';
    headerActions.appendChild(closeBtn);

    header.append(titleBlock, headerActions);

    const lede = document.createElement('div');
    lede.className = 'bylaws-lede';
    lede.textContent =
      'Set a default lighting standard for the whole city. Power, upkeep, and happiness adjust instantly.';

    const body = document.createElement('div');
    body.className = 'bylaws-body';

    const lightingSection = document.createElement('div');
    lightingSection.className = 'bylaws-section';
    const lightingTitle = document.createElement('div');
    lightingTitle.className = 'bylaws-section-title';
    lightingTitle.textContent = 'Lighting standards';
    const lightingHint = document.createElement('div');
    lightingHint.className = 'bylaws-section-hint';
    lightingHint.textContent =
      'City-wide defaults apply everywhere until a district overrides them. Projections compare against the active bylaw.';
    const lightingOptions = document.createElement('div');
    lightingOptions.className = 'bylaws-options';
    const deltaHint = document.createElement('div');
    deltaHint.className = 'bylaws-delta-hint';
    deltaHint.textContent = 'Upkeep deltas show monthly impact; power is immediate grid demand.';
    const lightingNotes = document.createElement('ul');
    lightingNotes.className = 'bylaws-list';
    lightingNotes.innerHTML = `
      <li><strong>Energy-efficient lighting</strong> keeps upkeep lower and conserves power.</li>
      <li><strong>Carbon arc lamps</strong> satisfy nostalgia districts at a higher energy draw.</li>
      <li><strong>Mixed corridors</strong> let you preview LED vs. carbon-arc demand before carving districts.</li>
    `;
    lightingSection.append(lightingTitle, lightingHint, lightingOptions, deltaHint, lightingNotes);

    const districtSection = document.createElement('div');
    districtSection.className = 'bylaws-section';
    districtSection.innerHTML = `
      <div class="bylaws-section-title">District overlays</div>
      <div class="bylaws-section-hint">Coming soon: mark neighbourhoods to scope lighting bylaws per area.</div>
      <div class="bylaws-callout">Use the planned district tools to keep carbon-arc lamps downtown and energy-efficient corridors in suburbs.</div>
    `;

    const footer = document.createElement('div');
    footer.className = 'bylaws-footer';
    footer.textContent = 'Lighting bylaws are live; districts will add neighbourhood overrides in a later update.';

    const renderLightingOptions = () => {
      const state = getState();
      const currentLighting = state.bylaws?.lighting ?? DEFAULT_BYLAWS.lighting;
      const currentPolicy = LIGHTING_POLICIES[currentLighting];
      lightingOptions.innerHTML = '';
      Object.values(LIGHTING_POLICIES).forEach((policy) => {
        const projection = projectLightingPolicy(state, policy.id);
        const monthlyDelta = projection.deltaMaintenance * MONTHLY_EXPENSE_FACTOR;
        const moodDelta = policy.happinessTarget - currentPolicy.happinessTarget;

        const option = document.createElement('label');
        option.className = 'bylaws-option';
        option.dataset.active = String(policy.id === currentLighting);

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'lighting-bylaw';
        radio.value = policy.id;
        radio.checked = policy.id === currentLighting;
        radio.addEventListener('change', () => {
          if (policy.id === currentLighting) return;
          onSelectLighting(policy.id);
          renderLightingOptions();
          const toastPower = formatDelta(projection.deltaPowerUse, { unit: 'MW' });
          const toastUpkeep = formatDelta(monthlyDelta, { currency: true, unit: '/mo', precision: 0 });
          showToast(`Lighting bylaw set to ${policy.label} (${toastPower}, ${toastUpkeep}).`, {
            severity: 'info',
            durationMs: 2600,
            id: 'bylaws-info'
          });
        });

        const optionBody = document.createElement('div');
        optionBody.className = 'bylaws-option-body';
        const title = document.createElement('div');
        title.className = 'bylaws-option-title';
        title.textContent = policy.label;
        const optionLede = document.createElement('div');
        optionLede.className = 'bylaws-option-lede';
        optionLede.textContent = policy.lede;
        const deltas = document.createElement('div');
        deltas.className = 'bylaws-option-deltas';
        deltas.append(
          createDeltaPill('Power demand', projection.deltaPowerUse, { unit: 'MW' }),
          createDeltaPill('Upkeep', monthlyDelta, { currency: true, unit: '/mo', precision: 0 }),
          createDeltaPill('Mood target', moodDelta, { precision: 2 })
        );

        optionBody.append(title, optionLede, deltas);
        option.append(radio, optionBody);
        lightingOptions.appendChild(option);
      });
    };

    renderLightingOptions();

    body.append(lightingSection, districtSection);
    modal.append(header, lede, body, footer);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    escHandler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cleanup();
    };
    window.addEventListener('keydown', escHandler);

    closeBtn.addEventListener('click', cleanup);
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) cleanup();
    });
    modal.addEventListener('click', (event) => event.stopPropagation());

    showToast('Lighting bylaws now affect upkeep, power, and happiness. District overrides are coming soon.', {
      severity: 'info',
      durationMs: 2400,
      id: 'bylaws-landing'
    });
  };

  return { open, close: cleanup };
}
