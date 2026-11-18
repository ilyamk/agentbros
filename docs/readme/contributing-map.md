# Contributing map: infographic and animation spec

Last updated: 2026-11-17

The header image of [CONTRIBUTING.md](../../CONTRIBUTING.md): one picture of how humans and their agents contribute, drawn as a night on the Agent Bros. Pictures backlot. It is an illustration, not a render. The still is generated with Codex `image_gen` (prompt: [PROMPTS.md § G](PROMPTS.md#g-contributing-map)); the later GIF animates the same components, so each component below is drawn as a separate, cleanly bounded object.

Facts come from [CONTRIBUTING.md](../../CONTRIBUTING.md), [contrib/AGENTS.md](../../contrib/AGENTS.md), [gates](../contributing-gates.md), [GOVERNANCE.md](../../GOVERNANCE.md) and [RFC 0001](../rfcs/0001-contribution-system.md) §5, §6, §8, §10. Change the picture when those change.

## Idea

Contributing is making a film at the studio. A pull request is a **reel**. It is shot on a **film strip** (the eight-step loop), carried through the studio's **gates** (G0–G5), and premieres when it is **merged**. Who you are on the lot is your **backstage pass** (tier). What you earn is **screen credit** (credits, badges, showcase, profile). A bad take is either a **CUT** (slop, it counts against you) or a **RETAKE** (process, fix and resubmit), with one golden **appeal** ticket.

Claude and Codex (the brothers, as in the style bible) do the agent work; a human hand signs the CLA, because the human owner is accountable.

## What it says (facts to keep true)

| Mechanism | Fact | Shown as |
|---|---|---|
| Loop | fork → `contrib:scout` → choose size / `/claim` → build with tests → `change:add` → `contrib:check` → `contrib:pr` + CLA → answer review | Eight numbered frames on a film strip |
| Sizes | S ≤300 lines, go; M ≤1000, `/claim` (lapses after 7 days without a draft PR); L needs a proposal and `design-approved` | Three slates S, M, L at frame 3 |
| Needs board | Scout ranks by value: bench, sensor, library, playbook, provider, command … (20 categories, one per PR) | Searchlight on a marquee board at frame 2 |
| G0 accountability | CLA signed by the human, PR block, open-PR limit | Gate with a hand signing in gold ink |
| G1 structure | one category, one `.changes` entry, size, no media or leaks, protected paths need approval | Gate with a measuring slate |
| G2 correctness | lint, typecheck, tests, render | Gate with green ticks |
| G3 value | fix fails on base, novelty, regenerates identically | Gate with a gold star |
| G4 triage | LLM labels, advisory, never blocks | Gate that is always open, a critic with a monocle beside it |
| G5 impact | optional bench run by trusted runners | Dim gate with a dotted outline |
| Merge | `ready-for-owner`, maintainer merges via the merge queue | Red carpet into premiere doors "MERGED" |
| Closures | `closed:slop` (duplicate, media/leak, manual) counts 90 days, two in 30 days drop a tier; `closed:process` never counts | Red clapper "CUT", amber sign "RETAKE" |
| Appeal | `/appeal` once per bot closure, never for media/leak | One golden ticket "/APPEAL ×1" |
| Tiers | 0 newcomer (2 PRs), 1 contributor (3 merges, slop <20 %, 5 PRs), 2 trusted (10 merges + grant, 10 PRs), 3 maintainer | Four backstage passes, ascending |
| Recognition | release credits by category, category badges, showcase gallery, profiles; no ranking by PR count | Credits roll, enamel pins, poster, name card |

## Composition (shipped 16:9 frame, coordinates in % of width × height)

Generate at 1536×1024; everything important sits in the middle 16:9 band (crop to 1600×900). Components do not overlap; between them is plain backdrop, so each can be masked out or regenerated as a sprite.

| Id | Component | Box (x, y, w, h) | Text, exactly |
|---|---|---|---|
| `marquee` | Bulb marquee, the title | 30, 3, 40, 17 | "NOW CASTING", below it "HUMANS + AGENTS" |
| `claude` | Claude with megaphone and a searchlight whose beam lands on frame 2 | 4, 3, 16, 22 | none |
| `codex` | Codex at an editing console, cyan `>_` on the screen | 80, 3, 16, 22 | none |
| `strip` | Film strip arcing left to right, eight frames | 4, 26, 92, 24 | "1 FORK", "2 SCOUT", "3 CLAIM", "4 BUILD", "5 ENTRY", "6 CHECK", "7 PR", "8 REVIEW" |
| `slates` | Three small slates hanging under frame 3 | 26, 50, 12, 6 | "S", "M", "L" |
| `passes` | Four lanyard passes on hooks, rising left to right like stairs | 3, 58, 22, 36 | "0 NEWCOMER", "1 CONTRIBUTOR", "2 TRUSTED", "3 MAINTAINER" |
| `gates` | Six art-deco arches in a row, then red carpet | 27, 58, 40, 22 | "G0 CLA", "G1 SHAPE", "G2 TESTS", "G3 VALUE", "G4 TRIAGE", "G5 BENCH" |
| `premiere` | Premiere doors with velvet ropes at the carpet's end | 67, 58, 11, 22 | "MERGED" |
| `outtakes` | Red clapper, amber sign, golden ticket | 33, 83, 34, 12 | "CUT", "RETAKE", "/APPEAL ×1" |
| `rewards` | 2×2: film-credits scroll, enamel pins, showcase poster, name card | 80, 58, 17, 36 | "CREDITS", "BADGES", "SHOWCASE", "PROFILE" |
| `route` | Thin gold dotted line: strip frame 8 → G0 → … → MERGED → rewards; tier passes linked to rewards by a faint line | — | none |
| `reel` | A glowing cyan film canister, the PR token, resting before G0 | 25, 66, 3, 5 | none |

Frame icons (left to right): a film strip splitting in two like a fork; a searchlight on a board of category tins; a ticket stub with a stamp; Codex's console with a green tick; a slate being chalked; a clipboard of ticks; a sealed envelope with a gold signature; a director's chair with a speech bubble.

## Style

The README style bible and avoid list ([PROMPTS.md](PROMPTS.md#style-bible-prefix-for-every-prompt)): 1930s studio glamour meeting the AI terminal; ink black #0B0B0F, marquee gold #F5C518, tungsten amber, cyan #22D3EE for agent-made things, red #EF4444 for cuts. For this piece: a clean infographic read, not a busy scene. Semi-flat, vector-like illustration with soft gold rim light and light film grain; each component a crisp, separate object on a dark, low-detail backlot (faint soundstage silhouettes, a starry sky); one light direction (top left). Labels in condensed art-deco caps (cream or gold) or cyan monospace, large enough to read at 900 px wide.

## Animation (the GIF to come)

Route: Remotion by layers, as the [animated-infographic](../../playbooks/animated-infographic/AGENTS.md) playbook describes. Image-to-video from this still was tried on 2026-11-17 (FLUX-3 first-last-frame draft): to keep the labels, its prompt froze everything but light, and the clip came out static (mean frame difference 0.23/255). Generated video is at most an ambient plate under masked text.

Loop of 8 s at 30 fps (GIF at 15 fps, 960×540); the last frame equals the first. Build it in Remotion from a clean plate (backdrop only) plus one transparent sprite per component above, regenerated with the same prompt and the component's box, or traced to SVG for the strip, gates, route and passes. Motion per component:

| Id | Idle (always) | Story beat |
|---|---|---|
| `marquee` | Bulbs chase clockwise (frame-stepped, 6 bulbs per second) | Flashes once when the reel reaches MERGED |
| `claude` | Lens eye blinks every 3 s; searchlight sweeps ±8° | Beam locks on frame 2 while the reel is there |
| `codex` | `>_` caret blinks 2 Hz | Green tick types on when the reel is at frame 4 |
| `strip` | Sprocket holes crawl slowly (texture scroll) | Frames 1–8 light up one after another as the reel passes (0–3 s) |
| `slates` | Sway on their strings | The chosen slate (S) claps shut at frame 3 |
| `reel` | Soft cyan pulse | Rides the strip, drops down the route, passes the gates, rolls the carpet |
| `gates` | Dark gold | Each arch lights gold as the reel passes (3–5.5 s); G4 critic lifts the monocle, the arch never closes; G5 flickers dotted, optional |
| `premiere` | Velvet ropes still | Doors open, flashbulbs pop, confetti of film chips (5.5–6.5 s) |
| `rewards` | Credits scroll upward continuously | A new line slides in, a pin pops with a glint (6.5–7.5 s) |
| `passes` | Gentle swing on lanyards | Pass 0 flips to pass 1 with a glint (7.5 s) |
| `outtakes` | Still | Alternate loop: a ghost reel bounces off G1, CUT slams down with a camera shake of 4 px; another hits RETAKE, which swings, and the golden ticket flips |

Ease: springs with high damping for physical props (slates, passes, ticket), `Easing.inOut(cubic)` for the reel's travel, hard steps for bulbs. Prefer library blocks (`pnpm library:list`) for bulbs, confetti, credits roll and the dotted route.
