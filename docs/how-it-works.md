# How it works

Last updated: 2026-11-16

A one-page overview for people. Agents read [AGENTS.md](../AGENTS.md), which holds the full rules.

## What the studio is

Agent Bros. Pictures is a video studio you run through a coding agent, Claude Code or Codex, opened at the repository root. You describe the video; the agent chooses a method, asks you at every gate that matters (idea, look, music, final cut, any spending) and renders locally with Remotion. Paid generation is optional and always budgeted.

## Three commands

```bash
pnpm playbook --match "make a 30 second launch video for my app"   # 1. which kind of video is this?
pnpm film:init --project <id> --type motion-graphics --playbook product-promo --product <path>   # 2. the playbook's Start block
pnpm next --project <id>                                           # 3. what next? Do it, then ask again
```

1. **Choose.** A [playbook](../playbooks/AGENTS.md) is one kind of video (product promo, explainer, shorts from a long recording …) with its method, quality bar and tools. `--match` ranks them from your own words, in English or Russian; a weak or tied match means the agent asks you.
2. **Start.** Each playbook's `Start` block names its first commands: `film:init` for a new film, or `project:new` then `footage:next` for your own recording. `pnpm playbook --use <id> --project <id>` binds a playbook to an existing project.
3. **Loop.** `pnpm next --project <id>` returns the next step on any route: an agent to dispatch, a script to run, a question for you, or stop. Repeat until delivery.

## Two production modes, plus your footage

- **Bespoke film** (what `film:init` and the film playbooks start): a chain of agent steps (strategy, ideas, script, look, music, beat sheet, build, critique) writes scene code for this one film from the motion library. [Production chain](production-chain.md).
- **A `project.json` draft** (quicker): `video:recipe` fills registered templates into a `project.json`, which `pnpm next` renders, checks and delivers. [Template recipes](template-recipes.md).
- **Your own recording** is edited, not generated: transcript, cuts, captions, shorts and reframes are proposed as plans you approve. [Footage editing](footage-editing.md).

## Where things live

| What | Where |
|---|---|
| Rules for agents | `AGENTS.md` at the root and one per area ([CLAUDE.md](../CLAUDE.md) only imports it) |
| Kinds of video | `playbooks/<id>/` (`AGENTS.md` method, `playbook.json` triggers and route) |
| Agents (one role each) | `.agents/agents/` ([index](../.agents/agents/README.md)) |
| Skills (craft knowledge) | `.agents/skills/`; `.claude/` links to both |
| Motion blocks | `src/motion/library/` ([motion library](motion-library.md)) |
| Your projects and renders | `public/projects/<id>/`, `out/<id>/` (never committed) |

## Contributing

Start at [CONTRIBUTING.md](../CONTRIBUTING.md), then [contrib/AGENTS.md](../contrib/AGENTS.md) for categories and gates. Before a pull request run `pnpm check`; instruction changes also run `pnpm instructions:lint`. A new kind of video is a new playbook ([adding one](playbooks.md#adding-or-changing-a-playbook)).
