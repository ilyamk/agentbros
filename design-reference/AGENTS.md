# Design Reference — Agent Rules

Last updated: 2026-11-20

Inputs for visual decisions. Read these when analysing references or setting a project's design, before writing scene code.

| Path | Use |
|------|-----|
| `style-cards/catalogue.json` | Original versioned film style rules with stage guidance. See [film styles](../docs/film-styles.md). |
| `DESIGN_SYSTEM.md` | Formats, visual system and scene guidance |
| `color-palettes.md` | Palette references |
| `scene-storyboard.md` | Storyboard patterns |
| `agent-video-systems.md` | Notes on other agent video systems; research, not rules |
| `library/inbox/` | Drop zone for reference videos, with an optional `<name>.md` holding the link, segment and what to learn. Everything but its README is git-ignored |
| `library/<id>/` | Decomposition of one reference (`src/types/reference.ts`). Judged layers and the Russian `breakdown.md` come from the `reference-analyst` agent. Only our `.json` and `.md` are tracked (a `.gitignore` allow-list): never a frame, clip or sound of the film. `speech-text.json` is structure only; the film's words stay in the git-ignored `media/speech-text.full.json` (`ref:redact`). Quote a film's copy in at most four words; describe longer copy. `source.json` `playbooks` tags the playbooks a reference serves (`ref:add --id ID --playbooks a,b`); `private` marks a client's film (`ref:add --private`). Before contributing: `pnpm ref:contribute` ([contributing references](../docs/contributing-references.md)) |
| `library/_corpus.json` | Every analysed reference read together by `pnpm ref:corpus`: metric distributions, techniques by function, gaps, coverage. Git-ignored; rebuild it, never edit it. Never copy an id from its `privateReferenceIds` into a tracked file |
| `gap-triage.md` | The corpus's `missingPrimitives` sorted into covered, new block, new mode, helper or skip, with families, measured timing, a one-line spec and parallel build batches. Update a row when its block ships and the gap is back-linked |
| `techniques/<id>.md` | One card per technique with a working demo or worked example (`TechniqueCardSchema`): what it does, when it fits, timing, which file to read, pitfalls. A technique seen in two or more references is promoted here, then to a block ([edit-research](../.agents/skills/edit-research/SKILL.md)) |
| `creative-standards.md` | The bar every creative agent works to: hard rules, what a strong film has, blacklist, bad and strong pairs |
| `slop-catalogue.md` | Measurable "AI-slop" signatures: each one's sensor and code, threshold (provisional or calibrated) and fix |
| `calibration.md` | How far each film:measure leg can be trusted as a gate: corpus distributions, false positives on professional references, true positives, degradation accuracy, eligible gates. Generalised, no private reference names |
| `creative-lessons.md` | The harness's curated lessons, shared by every user: generalised (no person, product or brand names), each tagged with the creative rubric axes it bears on, promoted from a user's memory only by an approved proposal; the creative director reads it every review round. A user's own lessons live in local memory |
| `music-sources.md` | Free music sources an agent can search and download, with access, filters, licences and verdicts; the route is `pnpm music` |
| `film-style-prompts.md` | How to write a style prompt for a medium, and 66 medium styles with their native moves (lemo-opuscar) |
| `sources/<repo>.md` | What we took from one outside repository, where it lives and what we rejected; the ledger sources are `credits/<id>.json`, rendered into the root `CREDITS.md` |
| `README.md` | How the folders are organised |
| `bg-patterns/`, `device-mockup/`, `screenshots/`, `videos/`, `brand-assets/`, `typography/`, `mood-boards/`, `motion-reference/` | Visual examples |

Where this folder disagrees with the [root AGENTS.md](../AGENTS.md) or `src/lib/design-tokens.ts`, those two win for implementation. Treat these images and videos as references: check rights before using one in a video, and copy approved media into the project with provenance.

Anything taken from an outside repo, film or asset source gets a `credits/<id>.json` entry; run `pnpm credits:write-doc` to rebuild [CREDITS.md](../CREDITS.md). Keep library blocks' `inspiredBy` entries and update reference-film credits' `analysedFor`.
