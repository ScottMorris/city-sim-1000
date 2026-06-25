import type { TickerItem } from '../game/narrative/types';

interface NewsTickerOptions {
  root: HTMLElement;
  getItems: () => TickerItem[];
  getEnabled: () => boolean;
  getReducedMotion: () => boolean;
  cycleMs?: number;
}

export function initNewsTicker(options: NewsTickerOptions) {
  const { root } = options;
  const label = root.querySelector<HTMLSpanElement>('.news-ticker-label') ?? document.createElement('span');
  label.className = 'news-ticker-label';
  label.textContent = 'News';
  const text = root.querySelector<HTMLSpanElement>('.news-ticker-text') ?? document.createElement('span');
  text.className = 'news-ticker-text';
  const inner =
    text.querySelector<HTMLSpanElement>('.news-ticker-text-inner') ?? document.createElement('span');
  inner.className = 'news-ticker-text-inner';
  if (!inner.parentElement) text.appendChild(inner);
  if (!label.parentElement) root.appendChild(label);
  if (!text.parentElement) root.appendChild(text);

  let index = 0;
  let lastText = '';
  let intervalId: number | null = null;
  const cycleMs = options.cycleMs ?? 4800;

  const applyItem = (item: TickerItem) => {
    const nextText = item.text.trim();
    if (nextText === lastText) return;
    lastText = nextText;
    inner.textContent = nextText;
    root.dataset.severity = item.severity;
    root.dataset.category = item.category;
    root.classList.toggle('news-ticker-alert', item.severity === 'alert');
    root.classList.toggle('news-ticker-warn', item.severity === 'warn');
    root.classList.toggle('news-ticker-info', item.severity === 'info');
    requestAnimationFrame(() => {
      const shouldMarquee = text.scrollWidth > text.clientWidth + 4;
      text.classList.toggle('news-ticker-marquee', shouldMarquee);
    });
  };

  const refresh = () => {
    const enabled = options.getEnabled();
    root.classList.toggle('news-ticker-reduced', options.getReducedMotion());
    const items = options.getItems();
    const hasItems = items.length > 0;
    root.classList.toggle('news-ticker-hidden', !enabled || !hasItems);
    if (!enabled || !hasItems) {
      inner.textContent = '';
      lastText = '';
      root.classList.remove('news-ticker-alert', 'news-ticker-warn', 'news-ticker-info');
      delete root.dataset.severity;
      delete root.dataset.category;
      text.classList.remove('news-ticker-marquee');
      return;
    }
    if (index >= items.length) index = 0;
    applyItem(items[index]);
  };

  const advance = () => {
    const items = options.getItems();
    if (items.length === 0) {
      refresh();
      return;
    }
    index = (index + 1) % items.length;
    applyItem(items[index]);
  };

  const setTickerInterval = () => {
    if (intervalId !== null) window.clearInterval(intervalId);
    intervalId = window.setInterval(() => {
      if (!options.getReducedMotion()) {
        advance();
      } else {
        refresh();
      }
    }, cycleMs);
  };

  setTickerInterval();
  refresh();

  return {
    update() {
      refresh();
    },
    destroy() {
      if (intervalId !== null) window.clearInterval(intervalId);
    }
  };
}
