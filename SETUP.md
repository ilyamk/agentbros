# Setup for agents

For Claude Code, Codex or any coding agent told "install this". The full manual is [docs/install.md](docs/install.md); this page is the fast path: about five commands, one question to the user, one report back.

## 1. Clone and plan

```bash
git clone https://github.com/ilyamk/agentbros.git && cd agentbros
./setup.sh            # Windows (PowerShell): ./setup.ps1
```

The plan changes nothing. It prints one JSON line on stdout (progress on stderr). Read `metadata.needsConsent`: the steps that install outside this folder.

| Scope | Means | Ask the user? |
|---|---|---|
| `repo` | packages, Chromium, pinned Python, `.env` copy: only this folder and its caches | no |
| `user` | a tool in the user's home: Node through their version manager, pnpm, uv | yes |
| `system` | Homebrew, apt, winget or sudo: FFmpeg, Chromium libraries | yes |

A `manual` step has a `hint` instead of a command: tell the user what to install.

## 2. Ask once, then apply

If `needsConsent` is empty, apply straight away. Otherwise show the user those steps with their exact commands in one message and ask once. Then:

```bash
./setup.sh --apply --smoke              # user + repo steps, then a one-second test render
./setup.sh --apply --system --smoke     # only if the user also approved the system steps
```

The `harness` step connects the coding agents found on this machine (Claude Code, Codex, Cursor, Copilot, OpenCode, Amp and others) to the skills and the `agentbros` MCP server, inside this folder only. A harness that keeps its config in the user's home (Cline) needs `pnpm harness:setup --apply --global`: ask first ([harnesses](docs/harnesses.md)).

Windows: `./setup.ps1 -Apply -Smoke` (add `-System`). Add `--goal voiceover,music` (`-Goal`) when the user has said what they want to make; goals: `pnpm keys --help`.

Already have Node and packages? `pnpm bootstrap --apply --smoke` does the same repository steps. Every command is safe to rerun.

## 3. Report to the user

Everything the user needs is in `out/setup/REPORT.md` (data: `out/setup/setup.json`). Pass it on in your own words, in the user's language:

1. Ready or not, and what was installed.
2. What works now with no keys.
3. This machine's limits.
4. Keys by goal: which service, free or paid, where to get it. Add keys with **Edit API keys** in **Studio Console → Settings → API keys**, or edit `.env` in this folder. Keep keys out of chat. `pnpm keys` then shows which are set, never their values. A paid key bills their own account and spends nothing until a project budget allows it.
5. Next: the offline demo ([install guide](docs/install.md#4-check-the-install)) or a video request in one sentence.

If the JSON has `metadata.activate`, Node came from a version manager: run that line before `pnpm` in each new shell.

## 4. Then

Read [AGENTS.md](AGENTS.md) before any video request. Later checks: `pnpm preflight` (environment), `pnpm keys` (keys), `pnpm bootstrap` (both, with this report).

When a command fails it prints `"ok":false` with a message that names the fix. Optional tools (Blender, DaVinci Resolve, Vork, local Apple models) are listed in the report and never installed by setup.
