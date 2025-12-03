Radio assets live here.

- Add `playlist.json` following the documented schema (versioned object with a `tracks` array).
- Place audio files (prefer `.opus`, add fallbacks like `.ogg`/`.mp3` only if needed) at `public/audio/radio/`.
- Place optional cover art at `public/audio/radio/covers/` (WebP/AVIF/PNG), and reference it via the `cover` field in `playlist.json`.
- If no playlist or tracks exist, the in-game radio shows “Radio offline” and disables playback until files are dropped in.
