# Local campaigns, pinned worlds and localization

This layer plans and instantiates local projects. It makes no generation requests,
provider POSTs, submissions, publication actions or inferred billing entries.
Episodes begin as recipe animatics, with `productionReady: false`.

`CampaignManifestSchema` v1 contains a campaign ID/revision and USD cap; a versioned
brand (`name`, palette, rules); a versioned world (`invariants`, entity pins); and
unique episodes (`id`, `projectId`, assigned `quotaUsd`, explicit `language`, `voice`
and a validated recipe request). Recipe project IDs must match their episode IDs.

Each world pin names `sourceProjectId`, entity kind/ID, exact revision and
`contentHash`. The planner requires existing human approval for that revision,
checks recursively linked entities and checks original reference files against
registered hashes. New candidate or canonical revisions never replace a pin.
Provenance, rights, original paths, approval and voice/language controls are saved
in every immutable episode snapshot. Shared source originals stay in their source
project; no regeneration or duplicate import is performed. These pins are agent
production references; the planner does not invent how a character acts in a scene.
Supplied recipe media paths provide the rendered visual bindings.

```bash
pnpm exec tsx scripts/campaign.ts --manifest campaign.json --action plan
pnpm exec tsx scripts/campaign.ts --manifest campaign.json --action create
pnpm exec tsx scripts/campaign.ts --manifest campaign.json --action cost-report
```

Default action is `plan`. Creation stages the batch, reserves each new project
folder exclusively, publishes `project.json` last and rolls back its new folders
on failure. Existing projects, including empty project folders, are refused.
`pipeline/campaign-snapshot.json` and `campaign-binding.json` preserve identities.
At use time `assertCampaignReferences(projectDir, rootDir)` revalidates pins.

Allocations use conservative integer micro-USD arithmetic. Their sum cannot exceed
the campaign ceiling. Every episode receives a local OperationStore policy bounded
by its assignment; allocation is not provider spend. OperationStore persists the
binding identity as optional `campaignAllocation`, retaining legacy databases.
Policy increases above quota, changed bindings, deleted bindings and symlinked
bindings are rejected. Quotas do not automatically grow if someone edits the
campaign manifest. Revised allocations require a deliberate new campaign/project
workflow rather than silently changing existing liabilities.

Cost reports separate campaign ceiling, episode allocations, outstanding
reservations, actual supplied billing receipts, refunds and recorded paid attempts.
Instantiation itself creates no jobs, receipts or paid attempts. Confirmed provider
charges above an estimate remain reportable facts; quotas do not rewrite receipts.

## Supplied localization

`TranslationSchema` v1 requires source/new project IDs, explicit source/target
languages, voice, translation provenance `source`, declared words-per-second and
exactly one supplied translation per canonical scene. Every scene supplies spoken
`text` and `headline`; optional `subtext`, literal `labels` replacements and caption
phrases remain supplied data. The system never translates automatically. Text is
checked against each scene's actual owned duration using the supplied cadence.

```bash
pnpm exec tsx scripts/campaign.ts --manifest translation.json --action localize-plan
pnpm exec tsx scripts/campaign.ts --manifest translation.json --action localize-create
```

Creation always uses a new project ID. Source audio, word timestamps and edit
journals are not copied. Speech/voice/language changes set `audioStale`; alignments
always require a new explicit review. Changed native-audio talking-head footage is
redirected to the new project's replacement presenter path. This remains stale even
if the translated scene has an empty spoken string; old embedded speech cannot
become valid through an empty script.

`pipeline/localization.json` preserves the source hash, exact supplied translation,
stale flags and readiness. Production renderers call
`assertLocalizationReady(projectDir)` and reject an unreviewed draft. To complete a
repair, supply replacement audio and new word alignments, then call
`reviewLocalization(projectDir, review)` or use:

```bash
pnpm exec tsx scripts/campaign.ts --manifest localization-review.json --action localize-review
```

The review JSON contains `projectId`, `reviewedBy`, `evidence`, `expectedSourceHash`,
`audio` and `alignments` (paths relative to the localized project). Review must cover
the actual renderer files: per-scene `voiceover/<id>.mp3` and
`voiceover/<id>.words.json` / `.words.edited.json`, or the new embedded presenter.
Audio needs a real audio stream; word intervals must be valid and word text must
match supplied translated speech. Review records hashes of canonical project,
audio and alignments. Later file or project changes invalidate readiness. This is
attributed local review metadata, not authentication or an electronic signature;
a person must actually listen/check the result and supply evidence.

## Reviewed outcomes

`OutcomeSchema` stores supplied episode/campaign IDs, timestamp, metric source,
cohort, actual metric values, notes/claims and review attribution. `--action outcome
--output new-evidence.json` creates an exclusive evidence file with its hash and
`causalAttribution: "not-inferred"`. It never manufactures views, conversion rates,
benchmarks or claims that a creative change caused a metric. Use these records as
reviewed inputs to a subsequent creative postmortem.

Verify locally:

```bash
pnpm typecheck
pnpm exec tsx --test tests/campaigns.test.ts tests/budget*.test.ts tests/jobs*.test.ts
```

Tests use real synthetic local image/audio files and mock billing facts clearly
labelled as test fixtures. No provider call or real budget is used.


Optional provider dubbing uses versioned language bindings and explicit scene
conformance. Pass `dubbing: {binding, language}` with a localisation review to pin
the exact selected dub; wrong-language, unrelated renderer audio, contradictory
word source hashes and known stale revisions fail. See [audio integrations](audio-integrations.md)
for requests, conformance receipts and the separate alignment/listening review.
