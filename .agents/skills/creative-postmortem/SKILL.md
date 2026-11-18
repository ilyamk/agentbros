---
name: creative-postmortem
description: Turn the user's verdict on a film into shared lessons, and turn a problem that repeats into a changed rule or sensor. Use after a user has judged a film, or when the same problem has appeared twice.
---

# Creative postmortem

Read the approved brief, relevant project artefacts and `AGENTS.md` first. Use this skill when its decision is needed; do not invoke every craft skill for a simple edit. Keep leaf-agent work at depth one. Existing approval and no-spend instructions take precedence.

## Who makes a lesson

**Only the user's verdict makes a lesson.** Not a critic's score, not a passing sensor, not an agent's opinion, not your reading of why it failed. Agents wrote the film and agents judged it; only the viewer who said what they saw can teach the next film.

Lessons have two homes. The user's own go to their local memory (`memory/`, git-ignored, rules in [memory/AGENTS.md](../../../memory/AGENTS.md)); [creative-lessons.md](../../../design-reference/creative-lessons.md) holds only the harness's curated, generalised lessons, promoted there by an approved proposal. Each `--add` takes `--playbook`, `--step`, `--platform` and `--project` scope when known.

| What you have | Memory type | How it is recorded |
|---|---|---|
| The user said it, about a film they watched, in their words | `lesson`, `decision` or `preference` | After they confirm the wording: `pnpm memory --add --type lesson --summary "<generalised>" --quote "<their words>" --axis <axes>` |
| A critic's finding, a score, a measurement | `observation` | `pnpm memory --add --type observation --summary "..." --agent <who> --evidence <path or command>` |
| Your theory of the cause | `observation`, labelled hypothesis | The same, with a summary starting `Hypothesis:`; tested on a later film |
| A tool that failed and the workaround you used | `gap` | `pnpm memory --add --type gap --summary "..." --agent <who> --evidence <command>` |
| A project delivered | `episode` | `pnpm memory --add --type episode --summary "..." --project <id> --measured "<delivery evidence>"` |
| The same observation or gap again | One more sighting | `pnpm memory --seen <id>`, never a second entry |
| A repeat: occurrences >= 2 in `pnpm memory --consolidate` | Trigger for a change | A proposal, below |
| A delivered film no playbook covered | Material for a new playbook | Propose a draft `playbooks/<id>/` from the project's method to the user; write it on their go-ahead ([playbooks](../../../playbooks/AGENTS.md)) |
| A user-accepted film under a `ready` playbook | Evidence | The playbook's `evidence` (project, date, LOG id) on the user's acceptance; the orchestrator may then set `proven` |

Leaf agents do not write memory: they propose entries in their reports, and the orchestrator records them.

Separate what the user saw from why it happened. "The middle drags" is theirs. "Because shots are 4 s" is yours until they agree or a comparison shows it, and even then it's a measurement that agrees rather than a proven cause. Never claim a performance or conversion effect without audience metrics.

## Writing a lesson

1. Quote the user in their own language, and show them the sentence you propose. It becomes a lesson when they confirm it.
2. **Generalise it.** The lesson must hold for the next film, about another product: never a product's, brand's or person's name, never a feature only this product has. "Show the product working before second 3" is a lesson; "show the Clear inbox earlier" is a detail for the entry's body. Keep the specifics there.
3. **Tag the rubric axis** it bears on (`--axis`): one or more of `picture`, `hook`, `distinctiveness`, `truth`, `feasibility`, `ambition`, `native` (ideas) or `hookLine`, `reading`, `musicFit`, `oneMessage` (scripts). The creative director moves a score only through a tagged lesson ([creative rubric](../creative-studio/references/creative-rubric.md)). A lesson that names no axis informs, but scores nothing.
4. Record it with `pnpm memory --add --type lesson`: the generalised sentence as `--summary`, their words verbatim as `--quote`, `--playbook` when the project has `pipeline/playbook.json` (`pnpm playbook --id <pb>` then lists it beside the harness lessons), and the evidence (frame, render, what is not known) in `--body-file`. Never append a personal lesson to `design-reference/creative-lessons.md`; it gets there only as an approved proposal.
5. Name something to do differently. "Be more dynamic" is not usable. "Start from music and a reference's numbers" is.
6. If a lesson says the opposite of an existing one (`pnpm memory --query "<topic>" --type lesson`), ask which holds, and when. Record the one that holds with `--supersedes <old id>`; do not silently keep both.

A decision recorded with `film:approve --proxy benchmark` is not the user's: it never becomes a lesson, and a benchmark film the user has not watched teaches nothing.

What the user wants changed in a film goes through `pnpm feedback` first ([production chain](../../../docs/production-chain/feedback.md)); its `capture` hint fills `--step` and `--axis`, never the quote. A rejected film teaches as much as an accepted one. If the user accepts a film with no comment, record nothing: acceptance alone does not say why.

## The steering loop

A film is one instance, and the system that made it is the thing to improve. When the same problem appears a second time, fixing the film alone is the wrong move. Change the bar or the instrument, so the next agent cannot repeat it.

```
user's verdict -> lesson in memory -> did this happen before? (--seen, --consolidate)
                              no  -> keep the lesson, watch for it
                              yes -> propose a change to a rule or a sensor, naming the memory ids -> user decides
                                       -> apply, and check it against the films that showed the problem
                                       -> watch those ids: did the problem stop recurring?
```

Choose the change by what could have caught it:

| The problem | Change |
|---|---|
| Measurable from the file: frozen time, no audio, uniform shots | A sensor or a target: `film:measure`, `plan:check`, `motion:check` |
| Visible, but needs judgement: no idea, catalogue of effects | The critic's floors or the method in `.agents/agents/creative-critic.md` |
| An agent did it because nothing forbade it | The rule, in `design-reference/creative-standards.md`, or that agent's definition |
| The order made it inevitable: the music came after the edit | The chain, in `src/lib/film/chain.ts` |
| The critic passed something the user rejected | The critic's floors first: it missed its job, and that is the most serious repeat |

Prefer changing a sensor to adding a rule, since a sensor can't be skipped. Prefer changing a rule to adding one, because a list that only grows stops being read. Keep what a sensor reports honest: a sensor passing must never read as "good".

## Proposing a rule or sensor change

Do not apply it yourself. Put this to the user, in their language, and record it in the project's `pipeline/spine.md`:

```markdown
### Proposal: <short name>

- **Problem:** what repeats, in one sentence.
- **Memory ids:** the observations, gaps and lessons that caused it (`pnpm memory --consolidate` `suggest`).
- **Seen in:** at least two occurrences, each with its project, render and timecode or critique, and the user's words.
- **Change:** rule or sensor; the file and section; the exact new text, or the new threshold and what it reads.
- **Would have caught:** run on the films above. The result for each, with the numbers.
- **Would wrongly catch:** run on the reference films (`design-reference/library`). The result for each. A rule our references fail is wrong.
- **Cost:** what this forbids that we sometimes want; who has to do more work.
- **Not known:** what this does not establish.
```

For a sensor, the two "would" lines come from running it, never from reasoning about it. Add a test fixture for the case it catches. Approved changes go in the file named, with the lesson linking to it, and the proposal's outcome goes in the spine, including a "no".

Record it in memory too: `pnpm memory --propose --summary "<short name>" --change <sensor|rule|playbook|tool|chain|critic|retire> --target <files> --cause <memory ids> --test <test file> --agent orchestrator --evidence "<consolidate run>"`. On the user's go-ahead, `pnpm memory --approve <id> --quote "<their words>"`; on a no, `pnpm memory --reject <id> --text "<why>"` (add `--quote "<their words>"` when it had been approved). A subagent in its own git worktree implements an approved proposal with a test that fails before and passes after; after the merge, `pnpm memory --applied <id> --commit <sha>` (the commit must be reachable from HEAD).

### The meta-loop

A change is itself a hypothesis. After it lands, `pnpm memory --consolidate` reports it under `review`: a cause, or an entry that superseded it, seen (`--seen`) on a day after `appliedAt` makes it a candidate ineffective; no sighting for 30 days, a candidate verified; otherwise it is watching. Put the candidate to the user; only on their confirmation, `pnpm memory --verdict <id> --state verified|ineffective --quote "<their words>" --text "<why>"`. For an ineffective change, propose retiring or replacing it (`--propose --change retire` with the same causes and evidence), and close the old one with `--verdict <id> --state retired` once that lands; a rule that did not help is noise for every agent that reads it. A personal lesson that held across projects can be proposed, generalised, for `design-reference/creative-lessons.md`; the user approves the wording.

## Worked decisions

- The user calls a film's rhythm dead, and a critic had scored it 4. Record their words as a lesson. Then propose a critic floor from the numbers both films share, and test it against ten references.
- A second film ships with text over text in a wipe. The critic caught it the first time, as a finding. Make it a sensor proposal rather than a third reminder in the brief.
- A critic says a track feels corporate. That is an observation in memory. It becomes a lesson only when the user says it about that track.

Failure to avoid: claim a template increases conversion because it looks attractive to the agent; write a lesson from a critic's praise; add a rule after one film; let the same problem go round a third time because each film got its own fix.

## A project.json project

In a project.json project (the timeline route), produce `reviewed-lesson` in `pipeline/craft/creative-postmortem.json` (or the owning artefact when its schema already covers these fields): brief/version, hypothesis, compared revisions, measured outcomes, observed defects, confounders, reusable decision and review evidence. Distinguish observed facts, artistic choices and unresolved assumptions. Preserve approved source/version pins. Express the decision in the owning artefact (the project.json or the brief) before generating assets. Tools and generation permissions come from the creative-studio router.

- Record that a chart hold improved comprehension in an actual review and preserve the compared clips.
- Record that removing a duplicated voice fixed a measured audio defect.

## Alternatives and review

Without audience metrics, report production/clarity observations only. Keep a proposed creative hypothesis separate from verified evidence.

Review: Is every lesson in the user's words, and did they confirm it? Does each proposal hold two occurrences and results from actually running it? Can another agent reproduce or revise the decision from the recorded artefact? Use [evaluation briefs](../creative-studio/references/evaluation.md) for review; heuristic scores do not prove audience response.

For Blender repeats, inspect `pnpm blender:improve gaps` and `history --target TARGET`, plus tracked `blender-arsenal/improvements/*.json` surfaced by `memory --consolidate`. Follow [guarded self-improvement](../blender-3d/references/self-improvement.md); an A/B win is evidence, not a user-confirmed lesson. Do not repeat a reverted change without a different hypothesis.
