import { DEFAULT_PLAYLIST_PATH, fetchRadioPlaylist, type RadioPlaylist, type RadioTrack } from './radioPlaylist';

type RadioStatus = 'loading' | 'offline' | 'ready';

export interface RadioWidget {
  refresh: () => Promise<void>;
  setVolume: (volume: number) => void;
  getVolume: () => number;
  setPlaylistUrl: (url: string) => void;
  /** Removes this widget's document-level listener. Call on teardown/rebuild. */
  dispose: () => void;
}

export interface RadioWidgetOptions {
  playlistUrl?: string;
  fetchImpl?: typeof fetch;
  audioFactory?: () => HTMLAudioElement;
  initialVolume?: number;
}

export function initRadioWidget(host: HTMLElement, options: RadioWidgetOptions = {}): RadioWidget {
  let playlistUrl = options.playlistUrl ?? DEFAULT_PLAYLIST_PATH;
  const fetchImpl = options.fetchImpl ?? fetch;
  const audio = options.audioFactory ? options.audioFactory() : new Audio();
  audio.preload = 'metadata';
  audio.volume = Math.min(1, Math.max(0, options.initialVolume ?? 1));

  host.classList.add('toolbar-radio-slot');
  host.innerHTML = '';

  const widget = document.createElement('div');
  widget.className = 'radio-widget';

  const controls = document.createElement('div');
  controls.className = 'radio-controls';

  const prevBtn = createIconButton('⏮️', 'Previous track', 'prev');
  const playBtn = createIconButton('▶️', 'Play or pause', 'play');
  const nextBtn = createIconButton('⏭️', 'Next track', 'next');

  controls.appendChild(prevBtn);
  controls.appendChild(playBtn);
  controls.appendChild(nextBtn);

  const marqueeViewport = document.createElement('div');
  marqueeViewport.className = 'radio-marquee-viewport';
  const marqueeText = document.createElement('div');
  marqueeText.className = 'radio-marquee-text paused';
  marqueeText.textContent = 'Loading radio...';
  marqueeText.setAttribute('role', 'status');
  marqueeViewport.appendChild(marqueeText);

  const cover = document.createElement('img');
  cover.className = 'radio-cover';
  cover.alt = 'Radio cover art';
  cover.loading = 'lazy';

  const popover = document.createElement('div');
  popover.className = 'radio-popover';
  const popoverCover = document.createElement('img');
  popoverCover.className = 'radio-popover-cover';
  popoverCover.alt = 'Radio cover preview';
  popoverCover.loading = 'lazy';
  const popoverInfo = document.createElement('div');
  popoverInfo.className = 'radio-popover-info';
  const popoverTitle = document.createElement('div');
  popoverTitle.className = 'radio-popover-title';
  const popoverArtist = document.createElement('div');
  popoverArtist.className = 'radio-popover-artist';
  const popoverStatus = document.createElement('div');
  popoverStatus.className = 'radio-popover-status';
  popoverInfo.appendChild(popoverTitle);
  popoverInfo.appendChild(popoverArtist);
  popoverInfo.appendChild(popoverStatus);
  popover.appendChild(popoverCover);
  popover.appendChild(popoverInfo);

  widget.appendChild(controls);
  widget.appendChild(marqueeViewport);
  widget.appendChild(cover);
  widget.appendChild(popover);
  host.appendChild(widget);

  const state: {
    playlist: RadioPlaylist['tracks'];
    index: number;
    playing: boolean;
    status: RadioStatus;
    sources: string[];
  } = {
    playlist: [],
    index: 0,
    playing: false,
    status: 'loading',
    sources: []
  };

  // Radio is off-by-default: don't fetch the full audio/cover library (~55MB)
  // until the player actually presses play for the first time.
  let hasWarmedCache = false;
  let hidePopoverTimeout: number | null = null;
  // No hover on touch, so the popover (full title/artist/status/cover —
  // compact mode strips the marquee+cover down to icon buttons only, see
  // toolbar.css) needs a tap-triggered path that survives finger-up instead
  // of closing on the next mouseleave-equivalent.
  let popoverPinned = false;

  cover.addEventListener('error', () => {
    cover.classList.remove('visible');
    cover.removeAttribute('src');
  });
  cover.addEventListener('load', () => cover.classList.add('visible'));

  popoverCover.addEventListener('error', () => {
    popoverCover.classList.remove('visible');
    popoverCover.removeAttribute('src');
  });
  popoverCover.addEventListener('load', () => popoverCover.classList.add('visible'));

  const showPopover = () => {
    if (hidePopoverTimeout) {
      window.clearTimeout(hidePopoverTimeout);
      hidePopoverTimeout = null;
    }
    const rect = widget.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const popoverRect = popover.getBoundingClientRect();
    // On compact layout the widget sits inside the bottom-anchored dock, so
    // rect.bottom is already near the screen edge — flip above it rather
    // than let a position:fixed popover render (unreachably) off-screen.
    const fitsBelow = rect.bottom + 8 + popoverRect.height <= viewportHeight;
    const top = fitsBelow ? rect.bottom + 8 : Math.max(8, rect.top - popoverRect.height - 8);
    const maxLeft = Math.max(8, viewportWidth - popoverRect.width - 8);
    const left = Math.min(Math.max(8, rect.left), maxLeft);
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
    widget.classList.add('radio-popover-open');
  };

  const hidePopover = () => {
    if (popoverPinned) return;
    hidePopoverTimeout = window.setTimeout(() => widget.classList.remove('radio-popover-open'), 80);
  };

  const togglePopoverPinned = () => {
    popoverPinned = !popoverPinned;
    if (popoverPinned) {
      showPopover();
    } else {
      widget.classList.remove('radio-popover-open');
    }
  };

  const closePinnedPopoverOutside = (event: PointerEvent) => {
    if (!popoverPinned || widget.contains(event.target as Node | null)) return;
    popoverPinned = false;
    widget.classList.remove('radio-popover-open');
  };

  widget.addEventListener('mouseenter', showPopover);
  widget.addEventListener('mouseleave', hidePopover);
  widget.addEventListener('focusin', showPopover);
  widget.addEventListener('focusout', (event) => {
    if (!widget.contains(event.relatedTarget as Node | null)) {
      hidePopover();
    }
  });
  cover.addEventListener('click', togglePopoverPinned);
  marqueeViewport.addEventListener('click', togglePopoverPinned);
  document.addEventListener('pointerdown', closePinnedPopoverOutside);

  prevBtn.addEventListener('click', () => goToRelativeTrack(-1));
  nextBtn.addEventListener('click', () => goToRelativeTrack(1));
  playBtn.addEventListener('click', () => togglePlay());

  audio.addEventListener('ended', () => {
    if (state.status !== 'ready' || state.playlist.length === 0) return;
    const track = state.playlist[state.index];
    if (track?.loop) {
      audio.currentTime = 0;
      void safePlay();
      return;
    }
    goToRelativeTrack(1, { autoplay: true });
  });

  audio.addEventListener('error', () => {
    if (state.sources.length > 0) {
      const nextSource = state.sources.shift();
      if (!nextSource) return;
      audio.src = nextSource;
      audio.load();
      if (state.playing) {
        void safePlay();
      }
      return;
    }
    // Stop autoplaying through the playlist when nothing can play; let the user pick another track.
    state.playing = false;
    audio.pause();
    setText('Playback failed');
    setPopoverMetaForCurrentTrack();
    updatePlayLabel();
    updateMarqueeAnimation();
  });

  // The browser/OS can pause playback out-of-band (another app grabbing audio
  // focus, a phone call, a platform auto-pausing backgrounded audio) without
  // going through togglePlay(). Resync state.playing so the UI stops claiming
  // it's playing silence. Safe to fire redundantly when we paused it ourselves.
  audio.addEventListener('pause', () => resyncPlayingFromAudio());

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      resyncPlayingFromAudio();
    }
  };
  document.addEventListener('visibilitychange', handleVisibilityChange);

  function createIconButton(icon: string, label: string, action: string) {
    const btn = document.createElement('button');
    btn.className = 'radio-icon-button';
    btn.textContent = icon;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.dataset.action = action;
    return btn;
  }

  function setStatus(next: RadioStatus) {
    state.status = next;
    widget.dataset.state = next;
    const isReady = next === 'ready' && state.playlist.length > 0;
    prevBtn.disabled = !isReady;
    playBtn.disabled = !isReady;
    nextBtn.disabled = !isReady;
    marqueeText.classList.toggle('paused', true);
    marqueeText.classList.remove('scrolling');

    if (next === 'loading') {
      state.playing = false;
      audio.pause();
      updatePlayLabel();
      setText('Loading radio...');
      setPopoverMeta('Loading...', '', 'Preparing playlist');
      return;
    }
    if (!isReady) {
      state.playing = false;
      setText('Radio offline');
      setPopoverMeta('Radio offline', 'Drop tracks into /public/audio/radio', 'Nothing to play yet');
      updatePlayLabel();
      audio.pause();
      return;
    }
  }

  function setText(text: string, animate?: boolean) {
    marqueeText.textContent = text;
    const shouldScroll = Boolean(animate && state.playing && text.length > 24);
    marqueeText.classList.toggle('scrolling', shouldScroll);
    marqueeText.classList.toggle('paused', !shouldScroll);
    marqueeText.style.animationDuration = `${Math.max(12, Math.round(text.length / 3))}s`;
  }

  function setPopoverMeta(title: string, artist: string, statusLabel: string) {
    popoverTitle.textContent = title;
    popoverArtist.textContent = artist;
    popoverStatus.textContent = statusLabel;
  }

  function updateCover(track?: RadioTrack | null) {
    if (track?.cover) {
      const url = encodeURI(track.cover);
      cover.src = url;
      popoverCover.src = url;
      cover.classList.add('visible');
      popoverCover.classList.add('visible');
    } else {
      cover.classList.remove('visible');
      cover.removeAttribute('src');
      popoverCover.classList.remove('visible');
      popoverCover.removeAttribute('src');
    }
  }

  async function safePlay() {
    if (!hasWarmedCache) {
      hasWarmedCache = true;
      warmCacheForPlaylist(state.playlist);
    }
    try {
      await audio.play();
      state.playing = true;
    } catch {
      state.playing = false;
    } finally {
      updatePlayLabel();
      updateMarqueeAnimation();
      setPopoverMetaForCurrentTrack();
    }
  }

  function updatePlayLabel() {
    playBtn.textContent = state.playing ? '⏸️' : '▶️';
    playBtn.title = state.playing ? 'Pause' : 'Play';
    playBtn.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  }

  function resyncPlayingFromAudio() {
    if (!state.playing || !audio.paused) return;
    state.playing = false;
    updatePlayLabel();
    updateMarqueeAnimation();
    setPopoverMetaForCurrentTrack();
  }

  function togglePlay() {
    if (state.status !== 'ready' || state.playlist.length === 0) {
      return;
    }
    if (state.playing) {
      audio.pause();
      state.playing = false;
    } else {
      void safePlay();
    }
    updatePlayLabel();
    updateMarqueeAnimation();
    setPopoverMetaForCurrentTrack();
  }

  function updateMarqueeAnimation() {
    const current = state.playlist[state.index];
    const text = current ? `${current.artist} — ${current.title}` : marqueeText.textContent ?? '';
    const shouldScroll = state.playing && text.length > 24;
    marqueeText.classList.toggle('scrolling', shouldScroll);
    marqueeText.classList.toggle('paused', !shouldScroll);
    marqueeText.style.animationDuration = `${Math.max(12, Math.round(text.length / 3))}s`;
  }

  function assignSources(track: RadioTrack) {
    const fallbacks = track.fallbackSrc ?? [];
    state.sources = [...fallbacks];
    audio.src = track.src;
    audio.loop = Boolean(track.loop);
    audio.load();
  }

  function warmCacheForPlaylist(tracks: RadioTrack[]) {
    if (!('fetch' in window)) return;
    tracks.forEach((track) => {
      const candidates = [track.src, ...(track.fallbackSrc ?? []), track.cover ?? ''];
      candidates
        .filter((url) => typeof url === 'string' && url.length > 0)
        .forEach((url) => {
          void fetch(url).catch(() => {
            // Ignore cache warm failures; playback will still try network.
          });
        });
    });
  }

  function applyTrack(track: RadioTrack) {
    const text = `${track.artist} — ${track.title}`;
    setText(text, true);
    updateCover(track);
    updateMarqueeAnimation();
    setPopoverMeta(track.title, track.artist, state.playing ? 'Playing' : 'Paused');
    assignSources(track);
  }

  function goToRelativeTrack(delta: number, opts: { autoplay?: boolean } = {}) {
    if (state.status !== 'ready' || state.playlist.length === 0) {
      return;
    }
    const count = state.playlist.length;
    state.index = (state.index + delta + count) % count;
    const track = state.playlist[state.index];
    applyTrack(track);
    if (opts.autoplay ?? state.playing) {
      void safePlay();
    }
  }

  function setPopoverMetaForCurrentTrack() {
    const track = state.playlist[state.index];
    if (!track) {
      setPopoverMeta('Radio offline', 'Add tracks to enable playback', 'Offline');
      return;
    }
    setPopoverMeta(track.title, track.artist, state.playing ? 'Playing' : 'Paused');
  }

  async function loadPlaylist() {
    setStatus('loading');
    const playlist = await fetchRadioPlaylist(playlistUrl, fetchImpl);
    if (!playlist || playlist.tracks.length === 0) {
      state.playlist = [];
      state.index = 0;
      setStatus('offline');
      return;
    }
    state.playlist = playlist.tracks;
    state.index = Math.min(state.index, playlist.tracks.length - 1);
    setStatus('ready');
    applyTrack(state.playlist[state.index]);
    state.playing = false;
    audio.pause();
    updatePlayLabel();
    updateMarqueeAnimation();
    setPopoverMetaForCurrentTrack();
  }

  void loadPlaylist();

  return {
    refresh: loadPlaylist,
    setVolume: (volume: number) => {
      audio.volume = Math.min(1, Math.max(0, volume));
    },
    getVolume: () => audio.volume,
    setPlaylistUrl: (url: string) => {
      if (!url) return;
      playlistUrl = url;
      void loadPlaylist();
    },
    dispose: () => {
      document.removeEventListener('pointerdown', closePinnedPopoverOutside);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
  };
}
