import { DEFAULT_PLAYLIST_PATH, fetchRadioPlaylist, type RadioPlaylist, type RadioTrack } from './radioPlaylist';

type RadioStatus = 'loading' | 'offline' | 'ready';

export interface RadioWidget {
  refresh: () => Promise<void>;
  setVolume: (volume: number) => void;
  getVolume: () => number;
}

export interface RadioWidgetOptions {
  playlistUrl?: string;
  fetchImpl?: typeof fetch;
  audioFactory?: () => HTMLAudioElement;
  initialVolume?: number;
}

export function initRadioWidget(host: HTMLElement, options: RadioWidgetOptions = {}): RadioWidget {
  const playlistUrl = options.playlistUrl ?? DEFAULT_PLAYLIST_PATH;
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

  let hidePopoverTimeout: number | null = null;

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
    popover.style.left = `${Math.round(rect.left)}px`;
    popover.style.top = `${Math.round(rect.bottom + 8)}px`;
    widget.classList.add('radio-popover-open');
  };

  const hidePopover = () => {
    hidePopoverTimeout = window.setTimeout(() => widget.classList.remove('radio-popover-open'), 80);
  };

  widget.addEventListener('mouseenter', showPopover);
  widget.addEventListener('mouseleave', hidePopover);
  widget.addEventListener('focusin', showPopover);
  widget.addEventListener('focusout', (event) => {
    if (!widget.contains(event.relatedTarget as Node | null)) {
      hidePopover();
    }
  });

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
    getVolume: () => audio.volume
  };
}
