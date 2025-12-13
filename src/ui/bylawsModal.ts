import { showToast } from './dialogs';

type BylawsModalOptions = {
  onClose?: () => void;
};

export function initBylawsModal(options: BylawsModalOptions = {}) {
  const { onClose } = options;
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
      'Set a default lighting standard for the whole city before districts unlock finer-grained overrides.';

    const body = document.createElement('div');
    body.className = 'bylaws-body';

    const lightingSection = document.createElement('div');
    lightingSection.className = 'bylaws-section';
    lightingSection.innerHTML = `
      <div class="bylaws-section-title">Lighting standards</div>
      <div class="bylaws-section-hint">City-wide defaults apply everywhere until a district overrides them.</div>
      <ul class="bylaws-list">
        <li><strong>Energy-efficient lighting</strong> keeps upkeep lower and conserves power.</li>
        <li><strong>Carbon arc lamps</strong> satisfy nostalgia districts at a higher energy draw.</li>
        <li><strong>Mixed corridors</strong> let you preview LED vs. carbon-arc demand before carving districts.</li>
      </ul>
    `;

    const districtSection = document.createElement('div');
    districtSection.className = 'bylaws-section';
    districtSection.innerHTML = `
      <div class="bylaws-section-title">District overlays</div>
      <div class="bylaws-section-hint">Coming soon: mark neighbourhoods to scope lighting bylaws per area.</div>
      <div class="bylaws-callout">Use the planned district tools to keep carbon-arc lamps downtown and energy-efficient corridors in suburbs.</div>
    `;

    const footer = document.createElement('div');
    footer.className = 'bylaws-footer';
    footer.textContent = 'Tooling is informational for now — policy toggles will tie into power and happiness once districts ship.';

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

    showToast('Bylaws are informational for now — districts will enable enforcement.', {
      severity: 'info',
      durationMs: 2000,
      id: 'bylaws-info'
    });
  };

  return { open, close: cleanup };
}
