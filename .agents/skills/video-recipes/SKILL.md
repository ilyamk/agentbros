---
name: video-recipes
description: Preview and materialize a draft project.json animatic from a registered recipe (social, ad, product, education, documentary, music-motion) with `video:recipe`; pnpm next then renders, checks and delivers it.
---

Read [recipe direction](references/recipe-direction.md) for story/coverage choices. Discover maintained recipes/styles/templates with `pnpm video:recipe --action list`; schemas are `src/types/recipes.ts`. Choose a structure that matches the viewer's task. Do not force education/documentary into a sales funnel.

Write a versioned recipe request with projectId, recipeId, topic, formats, optional opt-in styleProfile, media sources and beat overrides. Use precise registered beat IDs. Copy and cite approved entity reference paths from entity cards; keep revision bindings in the project's entity-bindings artifact when a shot uses them. Local media references and actual API generation are separate operations.

Run `pnpm video:recipe --action preview --input <request.json>` before materializing. `--dry-run` never writes. `materialize` creates a new project only and refuses overwrites. Its placeholders and empty audio are explicitly draft; it does not claim production readiness or spend API budget. The resulting canonical project is on the timeline route: `pnpm next --project <id>` names its render, editorial QA and delivery steps.

Produce a treatment and beat-purpose map: audience outcome, hook/payoff, proof/source, coverage, spoken cadence, continuity and sound intent. Evaluate the animatic for comprehension/pacing, then replace placeholders and supply approved script/media/audio in its project.json. Do not treat a renderable draft as a finished video or an approval.

Recipes and workflows are alternatives inside a playbook ([playbooks](../../../playbooks/AGENTS.md), coverage table): choose the playbook first, then the recipe it names. For product ads or sourced lessons with supplied originals (recuts and shorts of the user's own recording start from `pnpm footage:next`), use `pnpm video:workflow --action list` and read only the selected [workflow guide](../../../docs/workflows.md). These workflows create independent canonical projects and checked source mappings. Shorts freeze approved selections; derive a newly reviewed series to change their content. Run `--scenario <id> --request REQUEST.json` to plan first; `--action create` imports local originals without generation. `--dry-run` forces plan even with create. Follow the returned render instructions, keeping `--timeline` when the workflow's authoritative edit uses TimelineIR.

Product benefits need demonstrated evidence and one actionable CTA; education needs prerequisites, a worked example and qualified source claims. Recording edits and shorts retain protected context and authentic source speech. Review the emitted treatment and mappings before delivery. Production readiness still requires exact render receipts, current human visual/semantic approval, rights/claim evidence and measured sound through [qa-and-delivery](../qa-and-delivery/SKILL.md). Missing inputs are actionable failures; never replace them by an invented approval or silent paid generation.

For a concrete supplied-input scenario, read only the relevant [worked production decision](../creative-studio/references/worked-production-decisions.md): it records evidence, a rejected alternative and a targeted repair without manufacturing creative acceptance.
