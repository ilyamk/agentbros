# Free music sources for agents

Checked 2026-11-11 with live requests where possible (curl from this machine). Which free music sources can an agent search,
preview and download through scripts, and on what licence terms? Licence evidence must be stored per track (see `resource-discovery`).
CC BY-NC and BY-ND tracks are unsafe for promotional films: filter them out at query time, not after selection.

## Summary

| Source | Access | Auth | Tempo / mood filters | Licence | Preview | Verdict |
|---|---|---|---|---|---|---|
| Incompetech | Static JSON catalogue | None | `bpm`, `feel`, genre id, `length`, instruments | CC BY 4.0 (or paid) | Direct MP3 | Use now |
| Jamendo API v3 | REST | Free `client_id` | `speed`, `fuzzytags`, `vocalinstrumental`, `acousticelectric`, `durationbetween`; no BPM | Per-track CC; API free only for non-commercial use | Direct MP3 (`audio`) | Use now (filter licences) |
| Openverse | REST | None (key raises limits) | `category=music`, `length`, licence type; no BPM or mood | Per-track CC / PD | Direct URL (`url`) | Use now (discovery) |
| Freesound APIv2 | REST | Free token key; OAuth2 for originals | `bpm`, `duration`, `loopable`, tags | CC0, CC BY, CC BY-NC | `previews.preview-hq-mp3` | Use now (loops, beds) |
| ccMixter | Query API (JSON) | None | Tags (`instrumental`), `bpm` in `upload_extra` | CC BY, CC BY-NC | Listed in `files[]`, but the host answers 403 outside its pages: listen and download manually | Maybe |
| Internet Archive | advancedsearch + metadata | None | Query terms only | Per-item `licenseurl` (mixed) | Direct file URLs | Maybe (classical PD) |
| Mixkit | HTML only | None | Category pages | Mixkit free licence | Direct MP3 | Maybe (manual) |
| Free Music Archive | None (API closed) | n/a | n/a | Per-track CC | Website only | No |
| Pixabay Music | None for music | n/a | n/a | Pixabay Content Licence | Website only | No |
| Uppbeat | None | Account | n/a | Uppbeat licence, credits | Website only | No |
| YouTube Audio Library | None (YouTube Studio) | Google account | n/a | YouTube-only terms | Studio only | No |
| Bensound | HTML only | None | Site categories | Bensound free licence, attribution | Website | No |
| Chosic | HTML only, bot-blocked | n/a | Site tags | Mixed CC, per track | Website | No |
| Musopen | HTML only, bot-blocked | Account | n/a | Public domain recordings | Website | No (use IA) |

## Sources

**Incompetech (Kevin MacLeod).** `https://incompetech.com/music/royalty-free/pieces.json` returns 200 (about 200 KB gzip, use `--compressed`)
with a JSON array of 1,443 pieces. Fields: `title, filename, length ("00:05:07"), instruments, genre (numeric id string), bpm (string, null on 247),
description, feel ("Calming, Relaxed"), uploaded, isrc, collection, sheetmusic, video, itunes, filmmusicURL`. Genre names come from
`https://incompetech.com/music/royalty-free/genre.json` (`[{id, genre}]`). MP3: `https://incompetech.com/music/royalty-free/mp3-royaltyfree/{encodeURIComponent(filename)}`
(checked: `Sneaky%20Snitch.mp3` returns 200). Licence: CC BY 4.0 with credit line, or a paid licence through filmmusic.io. Download the catalogue once and filter it locally.

**Jamendo API v3.** Docs: `https://developer.jamendo.com/v3.0/tracks`; base `https://api.jamendo.com/v3.0/tracks/?client_id=ID&format=json`.
Params: `search`, `tags` (AND), `fuzzytags` (OR, `+`-joined), `speed` (verylow|low|medium|high|veryhigh), `acousticelectric` (acoustic|electric),
`vocalinstrumental` (vocal|instrumental), `durationbetween=30_180` (seconds), `audioformat` / `audiodlformat` (mp31|mp32|ogg|flac),
`include=musicinfo+licenses`, `ccnc=false`, `ccnd=false`, `ccsa`, `boost=popularity_total`, `limit` up to 200. No BPM field anywhere, so treat `speed` as the tempo proxy.
`audio` is a stream URL; `audiodownload` is empty when `audiodownload_allowed` is false. Terms (`https://devportal.jamendo.com/api_terms_of_use`):
free for non-commercial use, commercial use needs a quote from licensing@jamendo.com; no published numeric quota; credit the artist and Jamendo, link the track page.

**Openverse.** `https://api.openverse.org/v1/audio/?q=piano&category=music&length=medium&license_type=commercial,modification`. `length` accepts
`shortest|short|medium|long` (the API rejects anything else). Results include `url` (often a Jamendo or Freesound file), `duration` (ms), `license`,
`license_version`, `genres`, `tags` (Jamendo `speed_*` tags come through), `attribution`. Anonymous limits measured from headers: 20/min burst, 200/day;
register an OAuth client (`POST /v1/auth_tokens/register/`, docs at `https://api.openverse.org/v1/`) for higher limits. Good aggregator for discovery; resolve the original source for licence evidence.

**Freesound APIv2.** Docs: `https://freesound.org/docs/api/resources_apiv2.html`; search is `GET https://freesound.org/apiv2/search/` (old `search/text/`
redirects, deprecated November 2025). Auth: `?token=KEY` or `Authorization: Token KEY` (unauthenticated returns 401, checked). Filters (Solr):
`filter=bpm:[110 TO 130] duration:[20 TO 90] loopable:true tag:music license:"Creative Commons 0"`. The new descriptor names are `bpm` and `loopable`
(the old `ac_tempo` / `ac_loop` names are gone); request descriptors by name in `fields`, e.g. `fields=id,name,duration,license,bpm,previews,username`.
`previews.preview-hq-mp3` (about 128 kbps) works with the token key; original files need OAuth2 (`/apiv2/sounds/{id}/download/`). Quotas are per user,
reported at `/apiv2/usage/`. Mostly loops and short pieces rather than finished tracks.

**ccMixter.** `http://ccmixter.org/api/query?f=json&tags=instrumental&limit=20` returns JSON (checked). Each item has `license_url`, `upload_extra.bpm`,
`upload_tags` (e.g. `bpm_100_105`) and `files[].download_url` MP3s. Many tracks are BY-NC, so filter on `license_url`. API docs: `http://ccmixter.org/query-api`.

**Internet Archive.** Search: `https://archive.org/advancedsearch.php?q=...&fl[]=identifier&fl[]=licenseurl&rows=50&output=json`; files:
`https://archive.org/metadata/{identifier}`, then `https://archive.org/download/{identifier}/{file}`. No tempo or mood data. Useful for public-domain
classical (e.g. `musopen-chopin`, `collection:opensource_audio`); trust only an explicit `licenseurl`.

**Mixkit.** No API, but the robots file allows everything except CCBot. Pages embed `https://assets.mixkit.co/music/{id}/{id}.mp3` and
Algolia item ids. Mixkit licence is free with no attribution, including commercial use. Fine for a human-picked track; scraping is fragile.

**Free Music Archive.** The old `freemusicarchive.org/api/get/tracks.json` returns 404. A secondary source (no primary notice found) says FMA withdrew the API because of server load and prohibits
unapproved scraping. The FMA research dataset (`https://github.com/mdeff/fma`) is a 2017 snapshot meant for research, not a production source.

**Pixabay Music.** The API documents only `https://pixabay.com/api/` (images) and `/api/videos/`; there is no audio endpoint. `robots.txt` disallows `/api/`,
the music search page returns 403 to scripts, and the Terms (section 8) forbid "scraping" and "programs or robots for automatic data collection". Do not
use the internal JSON. Manual downloads only.

**Uppbeat.** Behind a Vercel bot checkpoint; free tier needs an account with a monthly download cap and a credit line. No API.

**YouTube Audio Library.** Only inside YouTube Studio; no API, and the licence covers use on YouTube.

**Bensound.** HTML only; robots allows search and AI input. The free licence requires attribution and limits use; paid licences otherwise. No API.

**Chosic.** Cloudflare challenge blocks scripted requests. It mirrors CC tracks from other artists; take them from the original source instead.

**Musopen.** `musopen.org` returns 403 to scripts and downloads need an account. The public-domain recordings are mirrored on Internet Archive.

**MCP servers.** No Jamendo, Openverse or Incompetech MCP server was found (GitHub search, 2026-11-11). Freesound has three small community servers:
`johnkimdw/freesound-mcp-server` (Python, 10 stars), `timjrobinson/FreesoundMCPServer` (Node), `MuShan-bit/freesound-mcp`. All are thin search wrappers;
a repo provider is simpler and keeps provenance in our own format.

## Recommended agent route

1. **Incompetech**: cache `pieces.json` + `genre.json`, filter locally by `bpm`, `feel`, genre and length. Commercial-safe with credit line. Best metadata for scoring.
2. **Jamendo**: `vocalinstrumental=instrumental`, `speed`, `fuzzytags` for mood, `durationbetween`, `ccnc=false&ccnd=false`, `include=musicinfo+licenses`.
   Biggest catalogue of finished tracks; respect the non-commercial API terms and record the licence per track.
3. **Freesound**: loops and beds by `bpm` range and `loopable:true`, `license:"Creative Commons 0"`; previews with the key, originals via OAuth2.
4. **Openverse**: cross-source discovery with `license_type=commercial,modification`; then fetch evidence from the original source.
5. **ccMixter / Internet Archive**: fallback for specific styles and public-domain classical.
6. Everything else (Mixkit, Pixabay, Uppbeat, Bensound, YouTube): human picks a track, then `pnpm asset:import` with licence evidence.

## In this repository

`pnpm music --action search` queries Openverse, ccMixter, Internet Archive and Incompetech with no key, Freesound with
`FREESOUND_API_KEY` (tempo range via `bpm:[a TO b]`) and Jamendo with `JAMENDO_CLIENT_ID` (`speed` band). A brief such as
"140 BPM, quiet intro, drop at 4 s, hard ending, 16 s" ranks by stated tempo; `--analyse` maps the top previews and ranks by
measured tempo, rise at the drop, start offset and a downbeat cut (`fit` in the JSON). Agents cannot hear: the user chooses.
