// Tests for the radio widget: offline state, playlist loading, and control wiring.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

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

describe('radio widget', () => {
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

    it('tapping the cover pins the popover open, and tapping it again closes it', async () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const widget = initRadioWidget(host, {
        fetchImpl: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ version: '1.0', tracks: [] }) }) as unknown as typeof fetch,
        audioFactory: () => new AudioStub() as unknown as HTMLAudioElement
      });
      await widget.refresh();

      const widgetEl = host.querySelector('.radio-widget');
      const cover = host.querySelector<HTMLElement>('.radio-cover');
      expect(widgetEl?.classList.contains('radio-popover-open')).toBe(false);

      cover?.dispatchEvent(new Event('click', { bubbles: true }));
      expect(widgetEl?.classList.contains('radio-popover-open')).toBe(true);

      cover?.dispatchEvent(new Event('click', { bubbles: true }));
      expect(widgetEl?.classList.contains('radio-popover-open')).toBe(false);

      widget.dispose();
    });

    it('a pointerdown outside the widget closes a pinned popover', async () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const widget = initRadioWidget(host, {
        fetchImpl: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ version: '1.0', tracks: [] }) }) as unknown as typeof fetch,
        audioFactory: () => new AudioStub() as unknown as HTMLAudioElement
      });
      await widget.refresh();

      const widgetEl = host.querySelector('.radio-widget');
      const cover = host.querySelector<HTMLElement>('.radio-cover');
      cover?.dispatchEvent(new Event('click', { bubbles: true }));
      expect(widgetEl?.classList.contains('radio-popover-open')).toBe(true);

      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      expect(widgetEl?.classList.contains('radio-popover-open')).toBe(false);

      widget.dispose();
    });

    it('dispose stops reacting to outside pointerdown events', async () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const widget = initRadioWidget(host, {
        fetchImpl: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ version: '1.0', tracks: [] }) }) as unknown as typeof fetch,
        audioFactory: () => new AudioStub() as unknown as HTMLAudioElement
      });
      await widget.refresh();

      const widgetEl = host.querySelector('.radio-widget');
      const cover = host.querySelector<HTMLElement>('.radio-cover');
      cover?.dispatchEvent(new Event('click', { bubbles: true }));
      expect(widgetEl?.classList.contains('radio-popover-open')).toBe(true);

      widget.dispose();
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      expect(widgetEl?.classList.contains('radio-popover-open')).toBe(true);
    });

    it('resyncs the UI when audio.play() rejects (autoplay-policy style refusal)', async () => {
      const host = document.createElement('div');
      document.body.appendChild(host);

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            version: '1.0',
            tracks: [{ id: 'a', title: 'Downtown Drive', artist: 'City Crew', src: '/audio/radio/a.opus' }]
          })
      });

      const audio = new AudioStub();
      audio.play = vi.fn(async () => {
        throw new DOMException('play() failed because the user didn\'t interact with the document first.', 'NotAllowedError');
      });

      const widget = initRadioWidget(host, {
        fetchImpl: fetchMock as unknown as typeof fetch,
        audioFactory: () => audio as unknown as HTMLAudioElement
      });
      await widget.refresh();

      const playBtn = host.querySelector<HTMLButtonElement>('.radio-icon-button[data-action="play"]');
      const popoverStatus = host.querySelector('.radio-popover-status');

      playBtn?.dispatchEvent(new Event('click'));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(audio.play).toHaveBeenCalled();
      expect(playBtn?.textContent).toBe('▶️');
      expect(playBtn?.title).toBe('Play');
      expect(popoverStatus?.textContent).toBe('Paused');
    });

    it('resyncs state.playing and the UI when the audio element pauses out of band (e.g. an interruption)', async () => {
      const host = document.createElement('div');
      document.body.appendChild(host);

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            version: '1.0',
            tracks: [{ id: 'a', title: 'Downtown Drive', artist: 'City Crew', src: '/audio/radio/a.opus' }]
          })
      });

      const audio = new AudioStub();
      const widget = initRadioWidget(host, {
        fetchImpl: fetchMock as unknown as typeof fetch,
        audioFactory: () => audio as unknown as HTMLAudioElement
      });
      await widget.refresh();

      const playBtn = host.querySelector<HTMLButtonElement>('.radio-icon-button[data-action="play"]');
      const popoverStatus = host.querySelector('.radio-popover-status');

      playBtn?.dispatchEvent(new Event('click'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(playBtn?.textContent).toBe('⏸️');
      expect(popoverStatus?.textContent).toBe('Playing');

      // Simulate the browser/OS pausing playback out of band (audio focus
      // stolen, a phone call, background-tab throttling) without going
      // through the widget's own togglePlay()/pause() path.
      audio.paused = true;
      audio.dispatchEvent(new Event('pause'));

      expect(playBtn?.textContent).toBe('▶️');
      expect(playBtn?.title).toBe('Play');
      expect(popoverStatus?.textContent).toBe('Paused');

      widget.dispose();
    });

    it('a redundant out-of-band pause event after our own pause is a harmless no-op', async () => {
      const host = document.createElement('div');
      document.body.appendChild(host);

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            version: '1.0',
            tracks: [{ id: 'a', title: 'Downtown Drive', artist: 'City Crew', src: '/audio/radio/a.opus' }]
          })
      });

      const audio = new AudioStub();
      const widget = initRadioWidget(host, {
        fetchImpl: fetchMock as unknown as typeof fetch,
        audioFactory: () => audio as unknown as HTMLAudioElement
      });
      await widget.refresh();

      const playBtn = host.querySelector<HTMLButtonElement>('.radio-icon-button[data-action="play"]');
      playBtn?.dispatchEvent(new Event('click'));
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Our own togglePlay() pause path.
      playBtn?.dispatchEvent(new Event('click'));
      expect(playBtn?.textContent).toBe('▶️');

      // A late/duplicate 'pause' event for the pause we already initiated
      // ourselves must not throw, loop, or otherwise misbehave.
      expect(() => audio.dispatchEvent(new Event('pause'))).not.toThrow();
      expect(playBtn?.textContent).toBe('▶️');

      widget.dispose();
    });
  }
);
