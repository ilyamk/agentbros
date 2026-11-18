# Showcases, contributors and field reports

Last updated: 2026-11-15

Showcase entries are public metadata, stored at `showcases/<slug>/showcase.json`. Media stays outside git: local derivatives in `out/<project>/showcase/`, then reviewed assets in the repository's `showcase-media` release. The static gallery is published at <https://ilyamk.github.io/agentbros/>.

## Who fills the site

Every page is generated from tracked files or GitHub data; nothing is edited on the site itself. Discussion happens in GitHub Discussions, issues and RFCs.

| Page | Source | Who adds it | What the maintainer does |
|---|---|---|---|
| Needs board: scouted jobs | `pnpm contrib:scout` reading the repository | Nobody; jobs appear and disappear with the code | Nothing |
| Needs board: picked jobs | `contrib/opportunities.json` (`CuratedOpportunitiesSchema`, protected); rows carry `source: "curated"`, which the board features, and rank above every scouted row | The maintainer, by pull request | Adds or removes entries; sets `priority` (0–3; 2 or more needs `verify`, offline commands that accept the work), `requires` (what `pnpm contrib:scout --can` filters on) and `read` |
| Needs board: community jobs | Issues from the opportunity form, labelled `needs-triage` | Anyone | Replaces `needs-triage` with `agent-ready` to list it, or closes it; only `agent-ready` issues reach the board |
| Films | `showcases/<slug>/showcase.json` from `pnpm showcase:add`, media in the `showcase-media` release | The film's author, by pull request | Reviews rights, licence and evidence; merging starts the media workflow |
| Contributors | `community/contributors/<handle>.json` | The contributor, by pull request | Reviews; badges are computed |
| Benchmarks | Signed bundles from the benchmark issue form | Anyone | Adds `bench:submitted` to start verification ([benchmark](benchmark.md)) |
| Genres, library, crew | Playbooks, the library catalogue, `.agents/agents/*.md` | Any contributor, by pull request | Ordinary review |
| Metrics, releases | `pnpm metrics --write`, `CHANGELOG.md` | Generated | Nothing |

Claimed work and work in an open pull request leave the board on the next build: every push to `main`, each release and nightly.

## Prepare an entry

After rendering and delivery, run:

```bash
pnpm showcase:add --project example --slug my-film --author my-handle --link https://example.org/film
```

The command reads the project brief, playbook binding, library usage, cost ledger and memory metrics. It uses the `cost:report` ledger readers, preserves unknown prices as null and never infers harness subscription charges. Rounds sum the maximum count per step after the latest removal tombstone; interventions count recorded approvals and rejections. `wallTimeMin` is the elapsed span between recorded metrics, not active working time; it is null without two observations.

It produces one JSON response: `metadata.entry`, `metadata.prBody` and the output paths. No pull request is sent. The body uses the contribution PR formatter; create its named `.changes` entry and run `pnpm contrib:check` before submission. Use `pnpm contrib:pr` once the change and evidence are ready.

The command makes a 1280 px wide JPEG thumbnail, six-frame contact sheet and muted MP4 preview of at most ten seconds. FFmpeg and ffprobe are required. `--skip-media` creates metadata only and explicitly leaves media pending. `--out` changes the entry's parent directory; media always stays under the project output. Existing entry/media paths are refused rather than overwritten.

Receipt verification requires a complete renderer receipt matching the exact MP4 hash, format, captured props, source identity, source list and a checksum-valid project delivery snapshot. Partial renders and manual bindings stay `declared`. Evidence verifies provenance, not creative quality or publication rights. A missing or mismatched receipt stays `declared`. Version comes from `git describe --tags --always`; a commit-only version is retained.

Before submitting, review the exported text and settings. Supply `--harness claude-code|codex`, `--model`, `--rights` and `--licence` when known. Missing declarations remain null in the local draft; the tool never declares rights for an author. The published `ShowcaseSchema` requires supported harness, model, rights and entry licence declarations. Site generation, media attachment and README generation reject incomplete drafts; finish these fields before submitting. References export only kind and count. Local paths are stripped and configured leak patterns (including optional local patterns) refuse remaining matches. Review is still needed for private text that no pattern recognises. Author profile links and credits are copied from `community/contributors/<handle>.json` when available.

## Publish reviewed media

Upload the three files produced in `out/<project>/showcase/` as GitHub PR or issue attachments and paste their plain HTTPS URLs into the entry:

```json
{"mediaSources":[{"kind":"thumbnail","url":"https://github.com/user-attachments/assets/thumbnail"},{"kind":"contactSheet","url":"https://github.com/user-attachments/assets/contact-sheet"},{"kind":"preview","url":"https://github.com/user-attachments/assets/preview"}]}
```

Never commit the media. Source kinds must be unique; publishing requires all three when sources are supplied. On a default-branch push that changes a showcase manifest (including a merged PR), the unprivileged `showcase` preparation job checks out the merge commit and selects added or modified `showcases/*/showcase.json` files from the push diff. `pnpm showcase:fetch-media --base BASE_SHA --head MERGE_SHA --out out/showcase-media` downloads sources with no credentials. It accepts HTTPS on `github.com`, `user-images.githubusercontent.com`, `private-user-images.githubusercontent.com` and `objects.githubusercontent.com` only, checking every redirect. Images are capped at 5 MiB and previews at 20 MiB. JPEG, PNG and WebP image signatures and MP4 signatures are checked before decoding.

FFmpeg re-encodes each image as JPEG and each preview as muted H.264 MP4, strips metadata and chapters, limits both dimensions to 1280 px and limits previews to ten seconds. Only local file/pipe protocols are enabled. The artefact contains `<slug>/thumbnail.jpg`, `<slug>/contact-sheet.jpg`, `<slug>/preview.mp4` and a SHA-256/byte-size manifest. Entries without sources leave publication pending.

The privileged job checks out the default branch, reads the artefact as data and runs `pnpm showcase:fetch-media --validate out/untrusted-showcase`. It checks the exact inventory, regular-file types, slug/name patterns, hashes, byte sizes and FFprobe dimensions, codec, duration and absence of audio. In the protected `release` environment it creates the dedicated release if missing, uploads hash-named assets with `--clobber`, then calls:

```bash
pnpm showcase:media --entry showcases/my-film/showcase.json --release-assets out/uploaded-assets.json
pnpm showcase:readme
```

The assets file is the workflow's JSON array of `{name, url}`. Names are `<slug>-<sha256>-thumbnail.jpg`, `<slug>-<sha256>-contact-sheet.jpg` and `<slug>-<sha256>-preview.mp4`. Only this repository's HTTPS `showcase-media` download URLs are accepted. All three media fields must be present for a new media card; unrelated assets are ignored. Multiple versions require an existing reviewed URL or a disambiguated asset list. The command uploads nothing and does not infer a new verification level.

The README's `<!-- showcases:start -->` / `<!-- showcases:end -->` block lists the six latest entries whose verification is receipt, maintainer or reproducible. An empty gallery has a contribution link. Maintainer and reproducible verification are reviewed declarations; these commands never grant them.

## Profiles and statistics

A profile is `community/contributors/<github-handle>.json`:

```json
{"displayName":"Example Contributor","links":["https://example.org"],"bio":"What I work on.","credits":"My contribution credits."}
```

Bio is capped at 280 characters and credits at 500. Links require HTTPS. Statistics use the latest committed metadata of change entries recovered through git history, including later PR stamps and author corrections within each file lifetime before deletion, deduplicating category and PR number; uncommitted entries never count. This expects a checkout of the merged repository history. CHANGELOG contributor credits preserve identity when change history is shallow; they do not invent PR counts. Instruction bytes removed are positive net byte reductions in AGENTS.md files in commits carrying an instructions entry; co-authors share that attribution.

Library blocks count only when their catalogue record has `authors`; missing authors are reported and skipped. A reproduced benchmark bundle counts only with an explicit author/submitter and `reproduced: true` or `verification: "reproduced"`. These optional fields are a gallery adapter: signed run bundles do not supply author or reproduction declarations, so they alone do not earn a reproduced-benchmark badge. Badges are computed in `src/lib/community/stats.ts`; a sensor contribution earns a contributor badge, never a claim of calibration. Profiles are alphabetical, with no PR-count leaderboard.

## Build the site

```bash
pnpm site:build --out out/site
```

This framework-free generator (`site/build.ts`, styles in `site/theme.ts`) reads showcases, profiles, playbooks, the library catalogue, `.agents/agents/*.md`, `contrib/categories.json`, CHANGELOG.md and optional `out/metrics/metrics.json`, `bench/results/*.json` and `out/contrib/needs.json`. It writes:

- a landing page in the studio's art-deco look (hero, departments, genres, library, premieres, the needs board teaser, honest limits);
- `films/` with the gallery filters (playbook, harness, model, verification, maximum budget and duration) and a page per showcase;
- `genres/` and a page per playbook: summary, request words, QA lines, neighbours and the blocks it starts from;
- `library/`, every block with its rendered preview strip, filterable by category and text;
- `crew/`, the agents from their front-matter;
- `needs/`, the contribution board: jobs grouped by category in registry order, filters by category, size and text, and a link that opens a pre-filled opportunity issue;
- contributor, metrics, benchmark and release pages.

Images are copied at build time from tracked files only: `docs/readme/` (illustrations; captions say so) and `docs/library/previews/` (real renders). Nothing is generated. Missing data has a placeholder, and the landing page reads complete with no showcases. Benchmark bundles retain reported intervals and downloadable JSON; no scores are invented. Page scripts are inline, read only data attributes and write only `hidden` and `textContent`. There are no web fonts, external scripts, analytics or network calls: display type uses deco faces that ship with the major systems. The site is dark only; motion is a slow marquee chase that stops under `prefers-reduced-motion`.

Output must be a dedicated directory under `out/`. The Pages base path is `/agentbros/`; preview with a local server that serves the output at that path (for example, a directory with `agentbros` linked to `out/site`). Regeneration tracks generated files in `.site-files.json` and removes obsolete owned pages, data downloads and copied images; unrelated files are retained. The Pages checkout also needs `fetch-depth: 0` for historical contribution statistics. The Pages workflow runs on every push to `main`, on each published release, nightly and by hand. It writes metrics with `pnpm metrics --write` and both needs-board formats with `pnpm contrib:scout --limit 1000 --markdown out/contrib/needs.md --out-json out/contrib/needs.json --online` before building the site; `--online` uses the workflow's read-only token (issues and pull requests) to drop claimed work and work in an open PR, and to mark jobs that already have an issue.

## Anonymous field report

```bash
pnpm field:report --project example
```

The JSON response contains `metadata.markdown` and `metadata.report`: rounds, approvals, rejections, sensor-failure events, spend totals, delivery yes/no, playbook and harness if declared. It excludes project IDs, timestamps, metric details and memory prose. Delivery reflects a recorded delivered event, not a fresh delivery check. Leak scanning applies before output. Nothing is sent, no file is written and no telemetry is collected; choose whether to attach the report to a showcase or issue.
