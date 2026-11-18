# Agent Bros Bench

> **Status (2026-11-17):** no campaign has run yet. `bench/allowed_signers` authorises nobody, `bench/results/` does not exist, and the judge slots in `bench/config.json` are unset (placeholder models, `monthlyCapUsd: null`, `null` calibration thresholds), so picture judging refuses and the creative layer has not run. Treat everything below as the protocol, not as results.

Bench protocol version 1 measures tasks at a fixed harness commit. A cell is task × harness × model × harness commit, with at least three independent runs. It supports Claude Code and Codex. Run campaigns are distinct from production videos: simulated gate answers never become human approvals, and an honestly reported blocked gate can be a valid behavioural outcome.

## Suites and material

[bench/suite.json](../bench/suite.json) pins nine public no-spend scaffolds: footage editing, shorts from long footage, a template/workflow explainer and motion design, plus five campaign tasks (ad experiments, catalogue videos, a reference family, a localised campaign and a content series). [The instruction suite](../bench/instructions/suite.json) contains 13 tasks with automatic trusted checks. Task contracts live in `src/types/bench.ts`. Paths, answers and check scripts are hash-pinned. Remote manifests are representable but must be fetched and pinned locally before this offline runner accepts them. Nothing fetches task media implicitly.

The footage fixtures are synthetic test patterns and tones, with an existing synthetic dialogue timing fixture as editorial material. They are not natural speech or ASR ground truth. `tests/fixtures/bench/prepare.mjs` creates the local clip with ffmpeg when the harness runs it. No asset binaries are committed. No-spend means no external media-provider expenditure; harness subscriptions are separate and cannot be inferred from output.

Pre-register suite and protocol versions, commit, exact model IDs, run count, judge models, calibration records, analysis configuration and private anonymisation seed before execution. `campaign.json` freezes the run configuration; judging writes its own `protocol.json`. Keep version 1 files immutable after registration: new tasks or changed task bytes use new paths and a new suite version, retaining older manifests. Hidden split suites/material remain outside git and use `--suite` with paths rooted in the trusted checkout.

## Run and collect

```bash
pnpm bench:run --task motion-design --harness codex --model MODEL --runs 3 --dry-run
pnpm bench:run --task motion-design --harness claude-code --model MODEL --runs 3 --commit COMMIT
pnpm bench:run --suite bench/instructions/suite.json --task bespoke-command --harness codex --model MODEL --runs 3
```

Dry runs validate hashes, budgets, suite and commit without starting a harness or creating a worktree. Execution creates detached clean worktrees under `.cache/bench/worktrees/`, reuses installed dependencies, stages licence-clean material, and stages a validated `OperationStore` policy outside the project directory before starting the harness. The prompt requires the harness to install that ceiling with `budget` immediately after project creation; until then, existing paid admission refuses uninitialised budgets. Production provider commands still reserve and own their own durable jobs. Paid tasks additionally require an explicit positive `--max-cost-usd` no greater than their declared ceiling; this is **per run**, so three runs can authorise three times that amount. Provider billing may exceed planning bounds. Never bypass the provider admission layer.

The runner starts `claude -p --output-format stream-json --verbose` or `codex exec --json`, using locally checked flags recorded in `src/lib/bench/run.ts`. Fixed answers are inserted in the initial prompt verbatim as the user's benchmark decisions. This is not an interactive gate responder: unsupported human-only gates must remain blocked. Claude permission prompts are denied when its configured mode cannot authorise an operation; no permission bypass is used.

The entire child process group is killed on wall-time, observed token or output limits and when the harness exits; worktrees are removed in `finally`. Token usage is observed at completed messages/turns, so an in-flight provider response can overshoot before usage arrives. Missing usage remains unknown, not zero. Complete final JSON events count even without a newline, including token limits. Interrupted JSONL tails are preserved and labelled truncated; malformed complete events remain invalid even when followed by an incomplete tail. Only complete valid events contribute counts. No harness-native exact token cap is claimed. External provider credentials are withheld from no-spend children; this runner is a trusted local orchestrator, not an operating-system security boundary. Run untrusted harnesses only in an independently isolated worker without network or secrets.

Results live under `out/bench/<campaign>/<cell>/`: render, receipts, project footprint, changed source/test files, prompt, task, transcript, stderr and manifest. Large binary files are listed as omitted with hashes; unavailable checks never imply success. Size limits cover collection and transcript output. Ledger totals prefer actual spend, then estimates; unpriced entries remain `null`. Durable operation state is included for later billing inspection. Harness subscription costs are not ledger spend.

Tests inject executables with `BENCH_HARNESS_BIN_CODEX` or `BENCH_HARNESS_BIN_CLAUDE_CODE`. These overrides are trusted local code and are never real sessions in verification.

## Sign and verify

```bash
pnpm bench:sign --bundle out/bench/CAMPAIGN/CELL --key /path/to/ssh-key
pnpm bench:verify --bundle out/bench/CAMPAIGN/CELL --allowed-signers bench/allowed_signers
pnpm bench:verify --bundle out/bench/CAMPAIGN/CELL --github-user HANDLE --online
```

Signing uses `ssh-keygen -Y sign -n agentbros-bench`. Offline verification requires a maintainer-controlled SSH `allowed_signers` file. GitHub registered public keys are fetched from `https://github.com/<handle>.keys` only with `--online`; there is no implicit lookup. An unsigned bundle, disallowed signer, changed hash, unlisted file, stale task or recomputed-claim mismatch is refused.

Verification uses trusted local suite/check code, never scripts from a submitted bundle. It recomputes transcript counts, ledger totals, process criteria and available file measurements (dimensions, frame rate, duration, loudness and true peak). Public task constraints independently check requested dimensions, 30fps and the allowed duration range. Where delivery reports, snapshots and media are present, it replays the existing delivery service on a disposable copy, keeping the submitted bundle read-only. Missing source/code/binary evidence can block full delivery replay. File-only `motion:check` layers also recompute flash ranges, packet frame counts, codec, dimensions and pixel aspect for clips up to 120 seconds at 30fps. Scene execution, DOM readability, drift and safe-zone evidence are not automatically asserted by this version. Creative acceptance and truthful environment/wall-time claims need independent review or reproduction.

CI already calls `bench:verify --bundle "$BUNDLE" --allowed-signers bench/allowed_signers`. The initial signer file authorises nobody; the maintainer must supply registered keys. Verification does not upload, publish, label an issue or reproduce a run.

## Public export

All new originals have `visibility: private`, including every hidden-split run.
Keep signed originals privately for reproduction. Publish **only** exported bundles:

```bash
pnpm bench:export --bundle out/bench/CAMPAIGN/CELL --out out/bench/public/CELL --key /path/to/ssh-key --allowed-signers bench/allowed_signers
pnpm bench:verify --bundle out/bench/public/CELL --allowed-signers bench/allowed_signers
```

Export verifies the signed original against its pinned suite (`--suite` selects
an external suite), then creates a new signed manifest and `summary.json` with
counts, timing, spend and status. It copies no source artefacts: hidden task
content, fixed answers, prompts, transcripts, raw stderr, project files and media
are excluded. Task names become opaque hash identifiers and host details are
redacted. Generic `leak:check` patterns plus optional local patterns scan the
public JSON and paths; a hit refuses export without writing a public copy.
A fresh output directory is required; the original is unchanged.

`bench:verify` accepts originals and public exports. The latter receive
`community-export`: signature and integrity verified, measurements **claimed**,
`recomputed: null`. They cannot supply picture judging or deterministic task
recomputation; those require private originals. A public summary signature never
establishes hidden-task acceptance.

## Picture judging and ratings

```bash
pnpm bench:judge --bundles bundles.json --allowed-signers bench/allowed_signers --calibration calibration.json --output out/bench/judging-CAMPAIGN --seed 123 --dry-run
pnpm bench:rate --campaign out/bench/judging-CAMPAIGN --output out/bench/ratings.json
```

`bundles.json` is an array of signed bundle directories for one task. Each cell must contain three distinct runs. The judge first verifies bundles, extracts three stills per render, decodes/re-encodes PNGs to strip metadata, assigns seeded opaque keys and builds every pair in both orders. Packets contain only stills and allowlisted measured technical numbers. The private mapping, seed and manifests stay in `private-key.json`, never in judge prompts. The prompt explicitly prohibits audio quality judgements; the packet schema rejects audio and arbitrary prompts. Stills do not establish motion quality.

Judging refuses while `bench/config.json` has `monthlyCapUsd: null`, unset calibration thresholds or unselected models. Admission requires enough distinct original/degraded `ref:degrade` comparisons and agreement with a maintainer-controlled human set. Records bind exact suite, model, protocol and picture-prompt hash. A changed judge, prompt or suite needs fresh calibration. Calibration records are declared evidence: maintainers must protect the human set and audit degradation provenance.

Two vendors use the existing triage adapters with a picture-only transport, dedicated bench ledger, conservative preflight quotes, durable reservations and no automatic ambiguous retry. Exact model pricing must already exist in `contrib/triage.json`. Bench monthly and campaign caps override triage caps for this separate ledger. `--recordings DIR` replays `<vendor>-<n>.json` response files with a separate recording ledger; replay is labelled and is not live provider validation.

`bench:rate` fits Bradley–Terry log abilities by MM, splitting ties into half wins and using a small symmetric prior for finite separation. A disconnected comparison graph is refused. Ratings require every registered run pair in both orders and every pre-registered judge, rejecting duplicate pairs or missing vendors. A seeded block bootstrap resamples a run pair with both presentation orders and judges together, producing 95% rating and delta intervals. The measured noise floor is the 95th percentile of absolute fitted differences between repeats of the same cell, or a higher pre-registered floor. Deltas within that floor or whose interval crosses zero are **no detectable change**. JSON and Markdown publish intervals and noise beside every rating. Normalisation uses fitted probability against the geometric-mean candidate per known ledger USD and wall-time minute; zero/unknown cost yields no per-USD number.

## Honesty and publication labels

- `community`: identity and hashes passed, and available deterministic claims were reproduced (including truthful failed-task results). This does not certify honest execution or creative quality.
- `community-export`: public summary signature and integrity passed; no deterministic recomputation is asserted.
- `reproduced`: the maintainer or a tier-2 runner has independently reproduced a randomly chosen campaign sample within the measured noise. No command here awards this label.
- `maintainer`: maintainer-run evidence, including the private hidden split. Never infer this label from an SSH signature.

Publish protocol registration, exported public bundles, omitted/restricted-material declarations, raw judgements, intervals, measured noise and analysis code with every public table. A mismatch on independent reproduction leaves that campaign unverified. The submitter must not choose official judges or supply their calibration verdicts. Audio gets measured technical checks and a human listening panel; no LLM sound verdict is supported.

## Submit a bundle for GitHub verification

Use the Benchmark bundle issue form. Paste one plain HTTPS archive URL into **Bundle URL**, one detached SSH signature URL into **Signature and signer**, and the cell/protocol identities into **Cells and protocol identity**. Use a USTAR `.tar` or `.tar.gz` archive containing the bundle files directly at its root, including `manifest.json`; the detached signature becomes `manifest.json.sig`. For example, create a portable archive with `tar --format=ustar -czf bundle.tar.gz -C bundle .`. Extended TAR headers are refused. A signature already inside the archive must match the detached signature.

A maintainer adds `bench:submitted` to start `bench-verify.yml`. Its unprivileged job checks out only default-branch scripts, parses the issue as data, and runs `pnpm bench:fetch-bundle --out out/bench-bundle`. Downloads require HTTPS GitHub releases/attachments on `github.com`, `user-images.githubusercontent.com`, `private-user-images.githubusercontent.com`, `objects.githubusercontent.com` or `release-assets.githubusercontent.com`; every redirect is checked and no credentials are sent. The archive and expanded contents are capped at 500 MiB; the signature is capped at 64 KiB. Extraction checks checksums, inventory limits, contained paths and file/directory collisions before writing, and refuses absolute paths, parent traversal, links, devices and extended entries.

The job runs `pnpm bench:verify --bundle out/bench-bundle --github-user ISSUE_AUTHOR --online`, taking the account from the event rather than from the issue text. The existing verifier checks registered GitHub SSH keys, the signed manifest, hashes, inventory and deterministic measurements. `github:bench-report` validates the result against the benchmark schemas and prepares an artefact. Acquisition failures and malformed verifier output become rejection reports. Public exports keep their existing integrity-only limitations; they do not claim deterministic recomputation.

A separate job with `issues: write` validates the report again, binds it to the triggering issue and author, confirms `bench:submitted` is still present, upserts one bot comment, and sets exactly one of `bench:verified` or `bench:rejected`. Artefacts are never executed. These labels report verification, not creative quality or reproducibility. Live GitHub behaviour still requires a sandbox-repository trial.
