import { describe, expect, it, vi } from 'vitest';
import { initRadioWidget } from './radio';

class AudioStub extends EventTarget {
  src = '';
  loop = false;
  paused = true;
  currentTime = 0;
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  load = vi.fn();
}

describe(
  'radio widget',
  { environment: 'jsdom' },
  () => {
    it('shows offline state when playlist is empty', async () => {
      const host = document.createElement('div');
      document.body.appendChild(host);

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '1.0', tracks: [] })
      });

      const widget = initRadioWidget(host, {
        fetchImpl: fetchMock as unknown as typeof fetch,
        audioFactory: () => new AudioStub() as unknown as HTMLAudioElement
      });

      await widget.refresh();
      const marquee = host.querySelector('.radio-marquee-text');
      const playBtn = host.querySelector<HTMLButtonElement>('.radio-icon-button[data-action="play"]');

      expect(fetchMock).toHaveBeenCalled();
      expect(marquee?.textContent).toContain('Radio offline');
      expect(playBtn?.disabled).toBe(true);
    });

    it('loads playlist and wires controls', async () => {
      const host = document.createElement('div');
      document.body.appendChild(host);

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            version: '1.0',
            tracks: [
              { id: 'a', title: 'Downtown Drive', artist: 'City Crew', src: '/audio/radio/a.opus' },
              { id: 'b', title: 'Overnight', artist: 'Night Lines', src: '/audio/radio/b.opus' }
            ]
          })
      });

      const audio = new AudioStub();
      const widget = initRadioWidget(host, {
        fetchImpl: fetchMock as unknown as typeof fetch,
        audioFactory: () => audio as unknown as HTMLAudioElement
      });

      await widget.refresh();
      const marquee = host.querySelector('.radio-marquee-text');
      const playBtn = host.querySelector<HTMLButtonElement>('.radio-icon-button[data-action="play"]');
      const nextBtn = host.querySelector<HTMLButtonElement>('.radio-icon-button[data-action="next"]');
      const popoverStatus = host.querySelector('.radio-popover-status');

      expect(marquee?.textContent).toContain('City Crew — Downtown Drive');
      expect(playBtn?.disabled).toBe(false);
      expect(popoverStatus?.textContent).toBe('Paused');

      playBtn?.dispatchEvent(new Event('click'));
      await Promise.resolve();
      expect(audio.play).toHaveBeenCalled();

      nextBtn?.dispatchEvent(new Event('click'));
      const marqueeAfter = host.querySelector('.radio-marquee-text');
      expect(marqueeAfter?.textContent).toContain('Night Lines — Overnight');
    });
  }
);
