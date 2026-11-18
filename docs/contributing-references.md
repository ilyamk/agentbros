# Contributing references

Last updated: 2026-11-15

Anyone can analyse a film they admire on their own machine and contribute what was learned: the numbers, the judged layers, technique cards and library blocks. The repository carries only that work. It never carries the film: no frame, no clip, no sound, and none of its words beyond a short quotation. Everything below is local and free.

## The local workflow

1. **Inbox.** Drop the film in `design-reference/library/inbox/`, with an optional `<name>.md` beside it for the link, the segment and what to learn. Everything there except its README is git-ignored.
2. **Add.** `pnpm ref:add --file design-reference/library/inbox/<name>.mp4 --id <id>` writes `<id>/source.json` (origin, sha256, probe, rights, crop) and copies the media to `<id>/media/`, which is git-ignored. A link works too: `--url … --rights unknown`. A client's film, or anything you may not name, gets `--private` (see [private references](#private-references)).
3. **Measure.** `pnpm ref:analyze --id <id>` writes the measured layers: shots, speech and screen text, audio, motion, sync, and the contact sheets and edit map in the git-ignored `visuals/`. The film's words go to the git-ignored `media/speech-text.full.json`; the tracked `speech-text.json` keeps their structure only (below).
4. **Judge.** The [`reference-analyst`](../.agents/agents/reference-analyst.md) agent looks at every sheet and a frame strip for each move, then writes `story.json`, `visual.json`, `edit.json`, `techniques.json`, `blueprint.json` and `breakdown.md` ([reference analysis](reference-analysis.md)). `pnpm ref:validate --id <id>` must give `passed: true`; read its warnings, including quotations over the limit.
5. **Corpus.** `pnpm ref:corpus` reads every reference together into the git-ignored `_corpus.json`: pace, sync and loudness as distributions, techniques by function, recurring gaps.
6. **Edit research.** The [edit-research](../.agents/skills/edit-research/SKILL.md) skill turns techniques seen in two or more references into technique cards (`design-reference/techniques/<id>.md`) and library blocks, each crediting the references in `inspiredBy`, and calibrates sensors on degraded copies (`pnpm ref:degrade`).
7. **Credit.** Add the reference's row to [CREDITS.md](../CREDITS.md) section 2: its id, the source (the link, or `unrecorded` with the file name), `Rights` as in `source.json`, and the media's sha256 prefix.
8. **Check, then open the pull request.** `pnpm ref:contribute --id <id>` (or `--all`) must pass.

## What may be contributed

| Contribute | Never contribute |
|---|---|
| `source.json` (origin, sha256, probe, rights, crop, notes without the film's copy) | The film, a clip of it, its sound, stems or a cropped copy (`media/`) |
| Measured layers: `shots.json`, `audio.json`, `audiomap.json`, `motion.json`, `sync.json`, and `speech-text.json` as structure | Frames, contact sheets, strips, edit maps or any still of the film (`visuals/`, any image under a reference) |
| Judged layers and `breakdown.md`, with the film's copy described (role, word count, case, size, timing) | The film's words: a transcript, its on-screen copy, headlines or a script, in any language (`media/speech-text.full.json`) |
| Technique cards, library blocks, sensors and calibration numbers built from them | A quotation of the film over four words, or a run of five of its words without quotation marks |
| A CREDITS row naming the reference | A private reference, its id anywhere in a tracked file or a commit message |

Two rules make this mechanical:

- **Only `.json` and `.md` are tracked under `design-reference/library/<id>/`.** `.gitignore` ignores everything else there, so an image, video or audio file cannot be added by accident; `media/`, `visuals/` and `compare/` are ignored whole. To track any other kind of file, a maintainer adds an explicit `!` line for that exact path with a reason. None is allowed today.
- **`speech-text.json` is structure only.** Per word: its time span and letters-and-digits count. Per piece of screen text: its spans and frame-refined onset, box (position and size as shares of the frame), word count, character count, letter case (`upper`, `lower`, `title`, `sentence`, `mixed`, `none`), OCR confidence, and `textId`, an opaque number that is the same for the same text within that film, so the corpus can merge repeated samples without the words. `language` is kept. The words themselves live in `media/speech-text.full.json`, read only by the blueprint leak check, the verbatim check and the replica spec check; without it those checks say they were skipped.

Quotations: a few words to name a label or a move (`'IS LIVE'`, `'80%'`) are fine. A headline, sentence or line of the script is described instead: "a seven-word all-caps question", "a two-line launch sentence with inline icons". Cite screen text by index and time (`screenText[12] @ 3.53 s`), not by its words.

## The check

`pnpm ref:contribute --id <id>[,<id>]` or `--all` prints one JSON line and exits non-zero with `VALIDATION` when anything below holds. `--all` leaves private references out and lists them as `localOnly`.

| Check | Fails when | Fix |
|---|---|---|
| `media` | A file under the reference other than `.json`/`.md`, or anything under `media/`, `visuals/` or `compare/`, is tracked, staged, or not ignored | `git rm --cached` it; the ignore rules keep it local |
| `verbatim` | `speech-text.json` holds words; a quotation over four words; a run of five of the film's words copied without quotes (needs the local full text) | `pnpm ref:redact --id <id>`; describe the copy |
| `private` | The reference is private (`private: true`, or ignored in `.git/info/exclude`), or flagged private but not excluded | Keep it local; `pnpm ref:add --id <id> --private` |
| `private-id` | Any tracked or staged file, path, block `inspiredBy` or commit message since `main` (`--base`) names a private id, in any spelling (`acme-studio`, `Acme Studio`, `acme_studio`) | Write "a private reference"; reword the commit |
| `provenance` | No CREDITS section 2 row with the id, or its sha256 prefix or `Rights` disagree with `source.json` | Add or fix the row |
| `inspired-by` | A block's `inspiredBy` names a reference with no CREDITS row | Add the row, or correct the citation |

Without the local full text the check still runs and says so in `warnings`: only quotation marks are checked, not unquoted copies. `tests/reference-contribute.test.ts` holds the repository itself to the same bar: no file but `.json` and `.md` under the library, no words in any `speech-text.json`, no long quotation in the library, the technique cards, the gap notes or a block's `inspiredBy`.

`pnpm ref:redact --id <id>` (or `--all`) moves words left in a tracked `speech-text.json` to the local file and rewrites the tracked layer. On a checkout that only has the structure (another machine, or after pulling this change), it recovers the words from git history when they were ever committed and the structure still matches.

## Private references

A private reference is a film you may study but not name: a client's film, or one shared in confidence. It takes part in your local corpus like any other and never reaches a tracked file.

- **Preferred:** `pnpm ref:add --file … --id <id> --private` (or `--id <id> --private` for one already added). It sets `private: true` in `source.json` and adds `/<library>/<id>/` to `.git/info/exclude`, so git never offers its files. `ref:corpus` marks it (`references[].private`, `privateReferenceIds`): never copy those ids into a card, block, note or commit message; cite "a private reference" and give it a neutral CREDITS row (no id).
- **Also recognised:** a line in `.git/info/exclude` alone, the older way. `ref:contribute` treats an excluded reference as private. The flag is better because it travels with the analysis if the directory is copied, and the check can tell you when the exclude line is missing.
- **Never** list a private reference in `.gitignore`: that file is tracked and would publish the id.

## Pull requests

Run `pnpm ref:contribute --all` and `pnpm ref:validate --id <id>` for each reference you touched, and paste the `passed` lines into the pull request. Say which references are new, which techniques or blocks they back, and confirm the rights status in their CREDITS rows.
