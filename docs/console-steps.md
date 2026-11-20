# Console steps: the step rail and agent control

Status: the rail is shipped (2026-11-20, the user's pick, concept A of three); the agent-control part below is a proposal.

The project canvas's step rail had three problems the user named: too little spacing, labels wrapping onto two lines, and no way to tell how many steps there are, where they come from or what each icon means. Three concepts were shown side by side; the user chose A ("Orbit"), and the other two and the old rail were removed.

## The rail

Code: `apps/console/components/step-rail/` (`index.tsx` the rail, `marker.tsx` the status marker, `model.ts` motion map, origin, progress, keys; `parts.tsx` origin badge, legend, tooltip). See every status at once with `?fixture=view-step-rail`.

- **Layout.** A horizontal track of even columns (at least 8 rem each; the track scrolls sideways when the pane is narrower and keeps the current step in view). One ring per step, connectors that fill when a step closes (a third filled out of the current step), one-line labels truncated with the full title in the tooltip, the status in words under each label, and "Gate" on a step that needs the user's approval.
- **One motion per status.** running: an arc traces the ring like a loader; awaiting-gate: a halo pulses; done: the check draws in when the step closes; failing: one shake, then a solid red ring (blocked and invalid share the ring with their own icons); stale and unsealed: a dashed ring crawls slowly; skipped: muted with a struck-through label; ready and pending: the step number (pending dashed). The current step pops when it advances; a step that appears after the rail mounted animates in once. Every animation is a `motion-safe:` utility on the `rail-*` keyframes in `styles.css`, so `prefers-reduced-motion` shows the end state.
- **Truthful count and origin.** The header shows "Step n of total", "k of total closed", an overall bar and an origin badge: _Template steps_ (dashed amber), _Film chain_, _Footage chain_ or _Route steps_, with a tooltip naming the route and the playbook and saying what the origin means. The origin is derived in the browser (see the gaps below).
- **Legible icons.** "What the icons mean" shows the eight motions live; every step has a tooltip with its title, status, first reason and owner.
- **Keyboard.** One tab stop; arrows, Home and End move; `aria-current="step"` on the current step.

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
