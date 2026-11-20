# Console project page: header, step rail and agent control

Status: the step rail is shipped (2026-11-20, the user's pick, concept A of three). The project header has three concepts on preview, pending the user's pick. The agent-control part is a proposal.

The project canvas's step rail had three problems the user named: too little spacing, labels wrapping onto two lines, and no way to tell how many steps there are, where they come from or what each icon means. Three concepts were shown side by side; the user chose A ("Orbit"), and the other two and the old rail were removed.

## The rail

Code: `apps/console/components/step-rail/` (`index.tsx` the rail, `marker.tsx` the status marker, `model.ts` motion map, origin, progress, keys; `parts.tsx` origin badge, legend, tooltip). See every status at once with `?fixture=view-step-rail`.

- **Layout.** A horizontal track of even columns (at least 8 rem each; the track scrolls sideways when the pane is narrower and keeps the current step in view). One ring per step, connectors that fill when a step closes (a third filled out of the current step), one-line labels truncated with the full title in the tooltip, the status in words under each label, and "Gate" on a step that needs the user's approval.
- **One motion per status.** running: an arc traces the ring like a loader; awaiting-gate: a halo pulses; done: the check draws in when the step closes; failing: one shake, then a solid red ring (blocked and invalid share the ring with their own icons); stale and unsealed: a dashed ring crawls slowly; skipped: muted with a struck-through label; ready and pending: the step number (pending dashed). The current step pops when it advances; a step that appears after the rail mounted animates in once. Every animation is a `motion-safe:` utility on the `rail-*` keyframes in `styles.css`, so `prefers-reduced-motion` shows the end state.
- **Truthful count and origin.** The header shows "Step n of total", "k of total closed", an overall bar and an origin badge: _Template steps_ (dashed amber), _Film chain_, _Footage chain_ or _Route steps_, with a tooltip naming the route and the playbook and saying what the origin means. The origin is derived in the browser (see the gaps below).
- **Legible icons.** "What the icons mean" shows the eight motions live; every step has a tooltip with its title, status, first reason and owner.
- **Keyboard.** One tab stop; arrows, Home and End move; `aria-current="step"` on the current step.

## Project header

### What the header is for

The header is the first thing read on every project page (Canvas, History, Timeline), often in a narrow pane beside the chat. In order of how often the user needs it:

| #   | The user's question        | Fact                                                                                               | Today                                                                                            |
| --- | -------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | Which project is this?     | Title; route, film type, playbook                                                                  | Title and a plain `film · promo · product-promo` line                                            |
| 2   | Is anything happening now? | Control state, the active agent and how long it has worked                                         | "Running" badge for the step next to "No agent running": two different "running"s side by side   |
| 3   | Where are we?              | Current step, its status, n of N                                                                   | Step title and status badge, no position                                                         |
| 4   | Does anything wait for me? | Pending decisions                                                                                  | Not in the header at all; only further down the canvas                                           |
| 5   | What has it cost?          | Spend against the ceiling                                                                          | A chip that looks like a button, no proportion                                                   |
| 6   | What can I do?             | Pause or resume (often), stop and autonomy (rarely), switch page, open Studio or the editing table | Pause and Stop as equal buttons, autonomy as a button-like chip, tools squeezed onto the tab row |

Problems with today's two bands: everything has the same weight (status badges, settings chips and actions look alike); the consequential Stop sits beside Pause; nothing says what waits for the user; the live state is split across three elements; on a phone the controls wrap into a pile.

### Rules every concept follows

- **One fact, one element, one look.** Status is text with a dot or marker, never a button; actions are buttons; settings live behind "more".
- **The fitting action only.** Pause while running, Resume while paused or stopped (filled, the one thing to do); Stop and "Change autonomy and budget" in the ⋯ menu, Stop in red after a separator. Both still open the existing confirm dialogs (`ControlDialog`, `AutonomyDialog`).
- **"Waits for you" is a first-class pill** (amber, with the count): it scrolls to and focuses the first decision card on the canvas, or opens the canvas from other pages. Hidden when nothing waits.
- **Same language as the rail.** The current step uses the rail's marker (orbit, pulse, check …) and "Step n of N".
- **Money as a proportion.** Spent, "of" the ceiling, and a thin bar that turns amber past 80 %.
- **Responsive by priority.** On a phone: title, live state, waiting, money, the fitting action and the tabs. Studio and the editing table are desktop tools and appear from the `md` breakpoint.
- **Micro-motion with meaning, off under reduced motion.** The live dot breathes only while an agent works; the live text and the waiting count pop or slide in when they change; the money and progress bars ease to their new width.

### The three concepts (preview: `?header=current|a|b|c`)

| Concept             | Shape                                                                                                                                                                                                                                                           | Best for                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **A · Command bar** | Two quiet rows. Row 1: title, meta and the live line (dot, agent, time) on the left; waiting pill, spend meter, Pause and ⋯ on the right. Row 2: tabs, the current step with the rail's marker and "Step n of N", tools on the right.                           | Dense and calm; a laptop beside the chat         |
| **B · Status hero** | A summary: meta in small caps over a large title, the current step with a progress bar and the live line, three tiles on the right (waiting, budget, autonomy) above the actions; tabs and tools below.                                                         | Checking in on a long run; explains the most     |
| **C · Live strip**  | A thin full-width strip carries only the live state, tinted by it (violet working, grey idle, amber paused, red stopped), with the current step, waiting pill, Resume/Pause and ⋯; below, the title with meta and spend, a segmented page switch and the tools. | Reading the state at a glance; the most distinct |

Code: `apps/console/shell/header/` (`parts.tsx` shared facts and parts, `concepts.tsx`, `preview.tsx` the switcher, `header.test.tsx`). The switcher sits above the header; `current` shows today's `TopBar` and tab row. When the user picks, the winner replaces `shell/top-bar.tsx` and the tab row in `shell/project.tsx`, and the preview goes.

## How steps reach the rail today

`ProjectView.steps: StepRow[]` (`src/types/console.ts`) is built per route in `src/lib/console/view/build.ts`:

| Route            | Source                                                                                                         | Notes                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| film, replica    | `readFilm` → the chain state `film:next` keeps                                                                 | Real steps with gates, owners, critic rounds, start and close times |
| footage          | `footage:next` answer (`footageSteps`)                                                                         | Real steps of the recut chain                                       |
| timeline, recipe | `timelineSteps`: `timelineNext()` (`src/lib/pipeline/timeline-next.ts`) mapped over the fixed `TIMELINE_STEPS` | Always render → qa → delivery → done                                |
| campaign         | none                                                                                                           | The container shows no rail                                         |

The journal already carries step facts: every event has an optional `step` (from the step lease), and `stepStarts` (`src/lib/console/view/activity.ts`) takes a step's start from its first `cli.start`, `agent.dispatch` or `agent.start`. `cli.end` (with `ok`, `error`, `elapsedMs`) and `job.state` carry the same `step` but are not used for step status. `view.current` is the next-step answer's step. `apps/console/panels/groups.ts` then groups step ids into panels (current, waiting, attention, closed).

## Gaps

1. **Template steps on any timeline project.** A `project:new` project whose real work is a model generation (a face swap, an image set) still shows render → editorial QA → delivery check. Nothing says these are the generic finish rather than the work.
2. **No origin in the contract.** `StepRow` has no source, and `ProjectView` drops `RouteInfo.detectedBy`; the rail infers the origin from the route and step ids.
3. **`running` is a guess on the timeline route.** It means "the next step and the action is not `ask`"; nothing confirms an agent is working on it.
4. **Failures and staleness do not surface.** `timelineNext` action `fix` (QA errors) and stale renders map to `running`, never to `failing` or `stale`.
5. **No close time or duration** on timeline steps, so the done list shows none.
6. **No step can be added during work.** Steps are recomputed from fixed lists; a critic round, an extra format or a generation job never appears as a step, and no journal event announces one.

## Proposal: agents drive steps through events, the projector stays the source

The console stays a view: steps are never written by the browser. Agents and CLIs record step facts in the project journal; the projector derives `StepRow` from chain state first and journal second.

**Contract (additive, `src/types/console.ts`):**

- `StepRow.origin?: "chain" | "template" | "agent"` and `ProjectView.stepsSource?: { route, playbook?, detectedBy, kind: "chain" | "template" | "mixed" }`.
- `StepRow.closedAt` and `durationMs` filled for every route.

**Journal (reuse the existing kinds, add one):**

| Event                                                                      | Today                     | Proposed use for steps                                                                                             |
| -------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `cli.start` / `agent.dispatch` / `agent.start` with `step`                 | Start time (`stepStarts`) | Also the only thing that makes a step `running`; without it the next step is `ready`                               |
| `cli.end` with `step`, `ok`, `error`, `elapsedMs`                          | History only              | Closes the step: `ok` → `done` with `closedAt`, `ok: false` → `failing` with `error` as the reason                 |
| `job.state` with `step`                                                    | Money and jobs panels     | A paid generation (`generate:*`) shows as the step's work: queued/running keeps it `running`, `failed` → `failing` |
| `step.planned { step, title, after?, reason }` (new kind in `EVENT_KINDS`) | —                         | Adds an agent-planned step (it animates in) from the orchestrator or a playbook; never removes a chain step        |

Commands outside the film and footage chains (`render`, `qa:editorial`, `delivery`, `generate:*`) hold no step lease, so their events carry no `step` today. They should set it from the timeline step they serve (`--step`, or the next-step answer's step passed through `AGENTBROS_STEP` the way `AGENTBROS_RUN_ID` already propagates). Skips keep going through `film:done --skip`, which already journals its `cli.end`; stale stays derived from file times, not from events.

**Projector rules:**

1. Chain routes (film, footage) keep their chain as the truth; events only add timing, owners and agent-planned steps after a chain step.
2. The timeline route builds its steps from the bound playbook when it declares them (`playbooks/<id>/` steps, e.g. `generate → review → deliver` for a model job), else from `step.planned` events, and only falls back to `TIMELINE_STEPS` marked `origin: "template"`.
3. `timelineNext` actions map faithfully: `fix` → `failing`, stale render → `stale`, `ask` → `awaiting-gate`, `run` → `ready` until a `cli.start` or `agent.start` for that step arrives.
4. A step whose last `cli.start` has no `cli.end` after the process ended is `failing` with "interrupted".

**Tests:** projector unit tests per route for each event, a fixture per origin, and the rail's existing status tests (`apps/console/components/step-rail/step-rail.test.tsx`).
