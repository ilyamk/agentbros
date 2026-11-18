# PR triage and instruction audits

> **Status: inactive.** `contrib/triage.json` has `enabled: false` and empty
> `pricing`, so CI runs no automated triage: no judge is called, and no label or
> comment is added. Maintainers can still run [local subscription
> triage](#local-subscription-triage) by hand. When enabled with the shipped
> configuration, both judge slots route through **one OpenRouter key** to two
> model families (Anthropic and OpenAI). That is two families, not two
> independent vendors. `minTierForAutoTriage: 1` means newcomers (tier 0) are not
> triaged automatically unless a maintainer requests it.

`pnpm triage:pr --artefact <dir> --repository OWNER/REPO --pr NUMBER [--dry-run]`
reads `metadata.json`, `body.md`, `change.md` and `diff.patch` as untrusted text.
Two configured judge slots independently apply the same rubric, with no provider
tools. The command outputs `triage:*` labels and a comment, never approves, merges
or closes a pull request. CI applies that result separately.

The verdict is not purely advisory. `triage:likely-slop` removes
`ready-for-owner`, and intake will not add it back while the label stays, so the
PR is kept out of the owner queue until a human looks at it and removes the
label. `triage:needs-human` likewise routes the PR to human review (intake adds
`needs-human` and withholds `ready-for-owner`). `triage:promising` and
`triage:needs-work` do not change the queue.

Both judges must agree on `promising`, `needs-work` or `likely-slop`. Disagreement,
abstention, invalid JSON/schema, a changed canary or injection markers produce
`triage:needs-human`. Slot labels identify each judgement. Model prose is escaped
in comments. Every input is delimited as untrusted material using fresh random
tokens and a separate canary. These checks reduce injection risk; they do not
prove a judgement correct.

The diff prefix is bounded by `maxDiffBytes` UTF-8 bytes, with an explicit
truncation flag and original/included byte counts. Complete file summaries are
bounded to 3000 paths, 4096 characters per path and 1 MiB overall. Omitted content
is explicitly unreviewed. Each artefact input must be a regular file of at most
16 MiB. Legacy artefacts without completeness metadata are treated as incomplete.
The metadata is never an intake verdict or executable instructions.

## Configuration and costs

The trusted checkout supplies config v2 in `contrib/triage.json` (v1 is removed):

```json
{
  "version": 2,
  "enabled": false,
  "judges": [
    { "label": "Claude", "provider": "openrouter", "model": "anthropic/claude-haiku-5.5" },
    { "label": "GPT", "provider": "openrouter", "model": "openai/gpt-6-luna" }
  ],
  "perPrCapUsd": 0.25,
  "monthlyCapUsd": 10,
  "maxDiffBytes": 61440,
  "maxRunsPerPr": 2,
  "minTierForAutoTriage": 1,
  "perOwnerMonthlyRuns": 4,
  "pricing": {}
}
```

`enabled` defaults to false. Disabled PR triage, audit and the CI budget wrapper
exit successfully with `metadata.skipped: "triage disabled"`; no judgement,
reservation, label or comment is created. Local subscription triage is an explicit
maintainer action and remains available when automated API triage is disabled.

Providers are `anthropic` (Messages), `openai` (Responses) and `openrouter` (Chat
Completions). The two slots must have different model families. Direct providers
use their provider as family; OpenRouter uses the prefix before `/`. Thus two
OpenRouter slots can use `anthropic/...` and `openai/...`. Router IDs
(`openrouter/*`, `*/auto`) and IDs without a family are refused. Labels must be
unique, with 1–64 ASCII letters, digits, underscores or hyphens.

`pricing` maps exact model IDs to `inputUsdPerMtok` and `outputUsdPerMtok`. Fill in
verified rates before enabling API triage. Missing prices fail before submission;
unknown never means free. Rates must be positive except for explicitly priced
OpenRouter `:free` IDs, which may use zero for both rates. A null monthly cap
refuses execution. Zero monthly allowance permits no positive-cost call.

Export only the configured providers' keys: `TRIAGE_ANTHROPIC_API_KEY`,
`TRIAGE_OPENAI_API_KEY`, `TRIAGE_OPENROUTER_API_KEY`. These CLIs never load `.env`.
`--dry-run` lists a plan without calls or ledger/report writes and does not certify
that prices, keys or model capabilities are configured.

The default pair is two small models from different families. In a 2026-11-15
offline trial of nine synthetic PRs (local CLIs standing in for the API, so treat
it as indicative), this pair matched a Sonnet 5.5 + GPT-6.1 Sol pair on every
slop and injection case, and at the then-listed OpenRouter prices
(USD 0.10 in / 0.50 out per Mtok each) its planning bound is about USD 0.004 per
ordinary PR and USD 0.02 for a 60 KB diff. The larger pair's bound (about USD 0.09,
and 0.37 for a 60 KB diff) exceeds a USD 0.25 per-PR cap, so large PRs would be
skipped. Re-check prices before filling `pricing`.

### Turning it on

1. Create a dedicated OpenRouter key with a USD `limit` and `limit_reset: "monthly"`
   (see below). That limit is the only real billing cap.
2. Store it as `TRIAGE_OPENROUTER_API_KEY` in the `triage` environment.
3. Create the `automation-state` branch with `triage-budget.json` containing
   `{"version": 1, "reservations": []}`; without it, paid triage refuses to run.
4. Fill `pricing` with the dated per-Mtok prices of both models.
5. Set `monthlyCapUsd`, then `enabled: true`, in a reviewed PR.

### OpenRouter routing

Requests use `https://openrouter.ai/api/v1/chat/completions`, strict JSON-schema
output, `require_parameters: true`, `allow_fallbacks: true` and
`data_collection: "deny"`. Each slot may override `dataCollection` to `allow`.
No attribution headers (`HTTP-Referer`, `X-OpenRouter-Title`) are sent. Paid model
requests set `provider.max_price.prompt` and `.completion` to the configured
$/Mtok rates; `:free` requests omit this field. The returned model family must
match the requested family.

`reasoningEffort` is optional (`low`, `medium`, `high`, `none`) and omitted by
default. Support varies by model/provider and has not been verified live here.
Enable it only after checking the selected route supports the parameter with
structured output. Enabled reasoning reserves twice the usual output allowance.
Unsupported parameters, HTTP errors (including 402/429/5xx), refusals, missing
usage, non-stop finishes (including `length`) and family substitution abstain
without retry. Valid usage still settles a refused or incomplete response's
known charge. Finite nonnegative `usage.cost` in USD credits is used for
OpenRouter settlement; otherwise configured token rates are used.

Free-model limits supplied for deployment planning are 20 requests/minute,
50/day below USD 10 lifetime purchased credits and 1000/day at or above that
threshold. **Verify these limits and model availability live before enabling**;
this implementation and its fixtures have no live-provider acceptance evidence.
Free models still need explicit zero prices and an API key, and can exhaust
request quotas even when their planning cost is zero.

Create a dedicated OpenRouter key with a USD `limit` and
`limit_reset: "monthly"` using the provider's key administration. Verify its
current semantics and reset behaviour before deployment. The provider-side key
limit is the billing cap; our local/remote reservations are planning bounds, not
a guarantee against provider billing above an estimate. Subscription usage is
separate and cannot be inferred from API token costs.

### Durable reservations and settlement

`TRIAGE_LEDGER` selects an append-only JSONL ledger (default
`.cache/triage/ledger.jsonl`). Each call reserves before submission under a local
filesystem lock and records run ID, slot label, provider and model. Valid usage
settles to actual cost; missing usage or ambiguous network failures retain the
bound. A cost above the quote causes abstention and is still accounted for.
Never delete reservations to retry an ambiguous call for free.

A quote conservatively counts prompt/schema UTF-8 bytes, 4096 protocol tokens and
2048 output tokens (4096 with enabled OpenRouter reasoning) at configured rates.
Per-PR costs accumulate across runs under a trusted `repository#pr` identity;
audit reservations have a separate scope. UTC reservation month determines the
monthly total. Legacy unscoped PR charges conservatively count against every PR.

The GitHub wrapper restores the detailed ledger and reserves the quoted whole
pass in `automation-state/triage-budget.json` before spawning judges. Its run ID
binds local ledger calls to that remote reservation. On completion it stores
`settledUsd` and `settled: true`; subsequent PR/monthly admission uses settled
amounts. Settlement re-reads state and retries up to three SHA conflicts. Any
unsettled call, or a failed subprocess with no attributable ledger evidence,
keeps at least the full remote bound (raising it when known charges plus pending
calls exceed the quote). Cancellation likewise leaves the reservation.
Missing state and reservation conflicts refuse execution without spending.

The same head cannot run twice. A changed head may be reviewed up to
`maxRunsPerPr` (default 2), while the PR's prior settled/bound charges plus the
next quote stay within `perPrCapUsd`. Owner quotas count reservations, including
failed/ambiguous runs, rather than monetary cost.

## Intake and abuse defences

Before admission the privileged wrapper obtains PR facts from GitHub REST and
re-runs intake. It requires an open non-draft PR, signed CLA, complete diff facts,
no leaks and no blocking G0/G1 findings. It rebuilds the judge material from those
same facts; downloaded artefact metadata never grants permission to spend.
Author tier must meet `minTierForAutoTriage` (default 1). Tier zero additionally
requires the current `triage:requested` label and a matching latest label event
whose actor currently has write, maintain or admin permission, checked through
the collaborators permission API. Merely having triage permission is insufficient.
`perOwnerMonthlyRuns` defaults to four for each lower-case PR author.

Refusals return `metadata.skipped` without comments or labels. Workflow-run triage
starts after successful `pr-intake`; the wrapper independently checks intake
regardless. Maintainers can apply `triage:requested` and dispatch `ai-triage` with
input `pr` to request a pass. Dispatch still enforces intake, trust, head and
budget limits; the label alone does not trigger spending. There is no
`pull_request_target` path. Application ignores disabled/skipped results and
results for a changed head.

## Local subscription triage

```bash
pnpm triage:local --pr 123 --repository owner/repo --harness codex
pnpm triage:local --pr 123 --harness claude --model sonnet --post
pnpm triage:local --pr 123 --harness both
```

Authenticate `gh` and the selected harness with the maintainer's subscription
before running. The repository defaults to `gh`'s current repository. No judge
API is called by this command and no API ledger charge is invented; harness
subscription usage/limits are separate. `--model` applies to every selected
harness, so omit it with `both` when their model IDs differ.

The command builds the same bounded artefact and prompt as CI from `gh pr view`
and `gh pr diff`. Each judge runs in a fresh empty temporary directory, with its
prompt on stdin, closed after writing, and a ten-minute timeout. Children receive
only PATH, HOME, CODEX_HOME and CLAUDE_CONFIG_DIR when set; GitHub tokens and API
key environment variables are not inherited. Codex uses `exec --sandbox
read-only --skip-git-repo-check -C <tmp> --output-last-message <file> -`, with user
config/rules ignored, ephemeral sessions, shell/execution, app/plugin, image,
browser/computer, skill-search and sub-agent features disabled, and web search
disabled. Read-only alone would still allow reading local secrets; these tool
restrictions are required as well. Claude uses `-p --output-format
json --tools ""`, strict empty MCP config, safe mode, no settings sources,
disabled slash commands and no session persistence. These flags were checked
against the installed CLIs' offline help on 2026-11-15; no live judge was run.
Use a compatible CLI version: unsupported flags fail closed. The harness still
needs its own authenticated home/config directory.

All outputs pass the same strict schema, canary and injection-marker checks.
One judge uses its validated verdict and an explicit “Single local judge” note;
`both` requires agreement. Default output is one JSON envelope. `--post` first
checks that the PR head still matches, then posts the advisory comment through
`gh` and changes only `triage:*` labels. It never merges or closes. Local triage
does not bypass the checks that later admit a PR to the owner queue.

## Instruction audit

`pnpm instructions:audit [--dry-run]` discovers tracked instruction files, splits
Markdown headings while respecting fenced code, and uses the existing context
budget resolver to map tasks. Ancestor instruction text and a heading index
provide comparison material; unseen peer text cannot establish a conflict.
Each slot judges relevance, filler, repetition, outdated rules, conflicts and
placement. The whole audit is preflighted before spending. Execution writes
`out/context/audit.json` and `.md`; differing findings or abstention require human
review. It reports only and never edits instructions.

## Offline verification

`TRIAGE_RECORDINGS=<dir>` replaces fetch with provider-shaped responses named
`<slot-index>-<label>-<call-number>.json` (zero-based slot index, one-based call
number). Only recording mode substitutes `__CANARY__`; missing/different canaries
stay invalid. Use an isolated test ledger because simulated charges are recorded.
Tests cover provider decoding, free pricing, disabled skips, durable settlement,
intake/trust/quota refusal and fake local executables. They make no provider calls
and establish no live GitHub/provider or creative judgement acceptance.
