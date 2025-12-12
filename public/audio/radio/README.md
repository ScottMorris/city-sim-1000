Radio assets live here.

- Station folders sit directly under `public/audio/radio/<station>` and each contains its own audio files and a `playlist.json` matching the documented schema (`{ version, tracks: [...] }`).
- Optional `station.json` files (with `name`/`description`) next to station playlists feed the generated `public/audio/radio/stations.json` manifest, which powers the toolbar dropdown.
- Keep cover art (WebP/AVIF/PNG) under `public/audio/radio/covers/` and reference it with the track’s `cover` field so thumbnails show in the toolbar and popover.
- Missing playlists or empty tracks leave the radio in “Radio offline,” disabling controls until audio lands in one of the station folders.
- Start from `public/audio/radio/playlist.sample.json`, or duplicate its contents into a station folder once you add real assets (a sample lives at `public/audio/radio/sample/playlist.json`).
- Run `npm run build:radio-playlist` to scan every station folder, build each `playlist.json`, convert covers, and emit `stations.json`. Flags: `--meta overrides.json`, `--default-artist "Name"`, `--extract-embedded-covers`, `--force`, `--convert-opus` to transcode non-Opus sources, `--dry-run`.
