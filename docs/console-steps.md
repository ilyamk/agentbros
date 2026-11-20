# Console steps: rail concepts and agent control

Status: proposal (2026-11-20). Nothing here is shipped beyond the temporary concept preview; the user picks a concept first.

The project canvas's step rail (`apps/console/components/step-rail.tsx`) had three problems the user named: too little spacing, labels wrapping onto two lines, and no way to tell how many steps there are, where they come from or what each icon means. This page records the three concepts on preview and proposes how agents should drive steps so the rail stays truthful.

## Concept preview (temporary)

The rail section carries a switcher (`apps/console/components/step-rail-concepts/switch.tsx`). Its choice lives in the query string, so a link reproduces it:

| Query                                            | Shows                                                                                                                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rail=current` (default)                         | Today's rail, unchanged                                                                                                                                                 |
| `rail=a`                                         | **A · Orbit**: horizontal track with even columns, a ring per step, connectors that fill as steps close, one-line labels with the status under them                     |
| `rail=b`                                         | **B · Progress bar**: a large `n / total`, one segmented bar (a segment per step), a "Now → Next" line; built for 15–20-step film chains                                |
| `rail=c`                                         | **C · Checklist**: a vertical list with status in words, owner, duration, gate and the first reason on the current row, under a source card                             |
| `rail=all`                                       | All four, one above the other                                                                                                                                           |
| `railData=live` (default) / `every` / `simulate` | This project's view / one step per `StepStatus` / a scripted run that advances, opens a gate, fails and recovers, marks a step stale, adds a step mid-run and skips one |

Fixture mode needs no project or token: `http://127.0.0.1:<port>/?fixture=view-step-rail&rail=all&railData=simulate#/projects/step-rail-demo`. The `view-step-rail` fixture is a `project:new` project on the timeline route, showing the template finish the user saw on a model-generation job.

All concepts share one model (`model.ts`):

- **One motion per status.** running: an arc traces the outline like a loader; awaiting-gate: a halo pulses; done: the check draws in when the step closes; failing: one shake, then a solid red ring (blocked and invalid share the ring with their own icons); stale and unsealed: a dashed ring crawls slowly; skipped: muted with a struck-through label; ready and pending: the step number (pending dashed). The current step pops when it advances, and a step that appears after the first render animates in. Every animation is a `motion-safe:` utility on keyframes in `styles.css`, so `prefers-reduced-motion` shows the end state.
- **Truthful count and origin.** Each concept shows "Step n of total", "k of total closed" and an origin badge: _Template steps_ (dashed amber), _Film chain_, _Footage chain_ or _Route steps_, with a tooltip naming the route and the playbook and saying what the origin means. The origin is derived in the browser (see the gaps below).
- **Legible icons.** A "What the icons mean" legend shows the eight motions live; every step has a tooltip with its full title, status, first reason and owner. Labels never wrap: one line, truncated, full text in the tooltip.

When the user picks, the winner replaces `step-rail.tsx`, the switcher, the demo data and the `view-step-rail` fixture go, and the console's motion rule (`apps/console/AGENTS.md`) is amended for the motions kept.

## How steps reach the rail today

`ProjectView.steps: StepRow[]` (`src/types/console.ts`) is built per route in `src/lib/console/view/build.ts`:

| Route            | Source                                                                                                         | Notes                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| film, replica    | `readFilm` → the chain state `film:next` keeps                                                                 | Real steps with gates, owners, critic rounds, start and close times |
| footage          | `footage:next` answer (`footageSteps`)                                                                         | Real steps of the recut chain                                       |
| timeline, recipe | `timelineSteps`: `timelineNext()` (`src/lib/pipeline/timeline-next.ts`) mapped over the fixed `TIMELINE_STEPS` | Always render → qa → delivery → done                                |
| campaign         | none                                                                                                           | The container shows no rail                                         |

Start times come from the journal (`starts`); `view.current` is the next-step answer's step. `apps/console/panels/groups.ts` then groups step ids into panels (current, waiting, attention, closed).

## Gaps

1. **Template steps on any timeline project.** A `project:new` project whose real work is a model generation (a face swap, an image set) still shows render → editorial QA → delivery check. Nothing says these are the generic finish rather than the work.
2. **No origin in the contract.** `StepRow` has no source, and `ProjectView` drops `RouteInfo.detectedBy`; the concepts infer the origin from the route and step ids.
3. **`running` is a guess on the timeline route.** It means "the next step and the action is not `ask`"; nothing confirms an agent is working on it.
4. **Failures and staleness do not surface.** `timelineNext` action `fix` (QA errors) and stale renders map to `running`, never to `failing` or `stale`.
5. **No close time or duration** on timeline steps, so the done list and concept C show none.
6. **No step can be added during work.** Steps are recomputed from fixed lists; a critic round, an extra format or a generation job never appears as a step, and no journal event announces one.

## Proposal: agents drive steps through events, the projector stays the source

The console stays a view: steps are never written by the browser. Agents and CLIs record step facts in the project journal; the projector derives `StepRow` from chain state first and journal second.

**Contract (additive, `src/types/console.ts`):**

- `StepRow.origin?: "chain" | "template" | "agent"` and `ProjectView.stepsSource?: { route, playbook?, detectedBy, kind: "chain" | "template" | "mixed" }`.
- `StepRow.closedAt` and `durationMs` filled for every route.

**Journal events (one writer, `src/lib/console` journal helpers):**

| Event                                                            | Written by                                                                          | Effect on the rail                                                     |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `step.planned { step, title, after?, origin: "agent", reason }`  | a playbook's planner or the orchestrator, through a CLI such as `pnpm steps --plan` | Adds a step (it animates in); never removes a chain step               |
| `step.started { step, owner, operationId? }`                     | `film:brief` dispatch, `generate:*` job submit, `render`, `qa:editorial`            | `running` with owner and start time; without it the step is `ready`    |
| `step.finished { step, result: "done" \| "failing", evidence? }` | the same commands on exit (their JSON envelope `ok`)                                | `done` with close time, or `failing` with the error code as the reason |
| `step.skipped { step, words }`                                   | `film:done --skip`, or a planner removing a planned step                            | `skipped` with the reason                                              |
| `step.stale { step, because }`                                   | an input hash change seen by `pnpm next` (render older than `project.json`)         | `stale`                                                                |

**Projector rules:**

1. Chain routes (film, footage) keep their chain as the truth; events only add timing, owners and agent-planned steps after a chain step.
2. The timeline route builds its steps from the bound playbook when it declares them (`playbooks/<id>/` steps, e.g. `generate → review → deliver` for a model job), else from `step.planned` events, and only falls back to `TIMELINE_STEPS` marked `origin: "template"`.
3. `timelineNext` actions map faithfully: `fix` → `failing`, stale render → `stale`, `ask` → `awaiting-gate`, `run` → `ready` until a `step.started` arrives.
4. A step with `step.started` but no finish after the command's process ended is `failing` with "interrupted".

**Tests:** projector unit tests per route for each event, a `view-step-rail` fixture per origin, and the console tests already added for each concept's statuses (`apps/console/components/step-rail-concepts/concepts.test.tsx`).
