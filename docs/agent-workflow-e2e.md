# Agent workflow evaluation

Last updated: 2026-11-16.

`bench:workflow` evaluates observable outcomes and artefact handoffs. A scenario declares a task, permitted effects, resource limits and independent acceptance checks. It does not prescribe a total command sequence, exact output filenames or one transcript producer. Production agents continue using the existing commands; the observer is installed only in evaluation harness processes.

## Run a layer

```bash
pnpm bench:workflow --action list
pnpm bench:workflow --action run --mode contract
pnpm bench:workflow --action run --mode native
pnpm bench:workflow --action run --suite bench/workflows/v3/suite.json --mode agent --scenario leaf-handoff --harness codex --model gpt-6.1-sol --allow-agent --dry-run
pnpm bench:workflow --action run --mode agent --scenario recording-shorts --harness claude-code --model MODEL --allow-agent
pnpm bench:workflow --action check --directory out/bench/workflow-RUN/recording-shorts
pnpm test:agent-workflow
pnpm bench:workflow --action run --suite bench/workflows/v4/suite.json --mode contract --no-spend
pnpm bench:workflow --action run --suite bench/workflows/v4/suite.json --mode native --no-spend
pnpm bench:workflow --action quality --benchmark bench/workflows/v4/quality/structured.json --directory bench/workflows/v4/quality --no-spend
```

Contract mode uses explicitly labelled fixture backends, real public CLIs and existing production consumers. It never starts an LLM. Native mode uses installed resources, with downloads forbidden; absent resources are skipped. Neither layer proves that a model discovers or chooses a tool. Agent mode requires an explicit harness, model and `--allow-agent`: harness API/subscription costs are separate from the zero media-provider budget. Dry-run validates pins and authority without starting commands, harnesses or workspaces.

Suite v4 requires `noSpend`: real agent mode is refused before a version probe or harness launch, including executable overrides. The explicit `--no-spend` flag applies the same refusal to older suites. The suite contains the original contracts plus actual brief, localisation, timeline, subtitle, rendering and delivery consumers. It uses scenario/report revision 3 with explicit oracle registration; revision 2 remains readable and frozen suites are unchanged. Four independent `layers` record contract, installed-native, agent and quality coverage. A passed contract never marks the other layers passed. Installed-model content refusal (`MODEL_REFUSAL`) is an inconclusive native/quality finding, with its original structured diagnostic retained; it is not a successful handoff or a missing-resource skip. No safeguard bypass or automatic model retry is attempted.

Local render scenarios use an installed Chromium only. `AGENTBROS_WORKFLOW_BROWSER=/absolute/path/to/installed/chromium` selects an existing executable, useful across worktrees; it never installs one. Missing browsers are reported as skips. The renderer uses the existing offline fixture font module and makes no production typography or human review claim. The real production timeline or a motion-library block is rendered, decoded, bound to a render receipt and consumed by delivery. Draft delivery and changed-source refusals are required outcomes; fixture review declarations never approve a user's film.

Real-agent terminal oracles initially cover recording-to-shorts preparation, local preview voice import/refusal, and an actual root-to-leaf-to-consumer handoff. Other scenarios report `inconclusive` in agent mode without launching a harness until their live-agent oracle is registered. Unknown scenario adapters never fall back to a convenient unrelated check. The registered Codex CLI 0.169.0 / gpt-6.1-sol profile is `bench/workflows/v3/suite.json`; it has model-specific observed-context allowances, retaining the original v2 limit failure. It requires that exact harness/model/version. Other harnesses use an independently registered profile or the original v2 bounds. `MODEL` is a placeholder for the selected installed harness's exact model; no model is selected silently.

## Observable contracts and freedom

Scenario command families scope task effects. Passive discovery and standalone `--help` for registered literal TypeScript commands remain available, including paid commands' help without execution. Frozen-raw offline transcription is also available for auxiliary verification. Help does not require production inputs; mixed help/mutation requests, downloads, approval flags and paid transcription remain refused. These allowances arose from real trials that exposed false restrictions in the evaluator.

The recording scenario accepts reconstruction from frozen raw Scribe material or an eligible installed speech engine. The agent chooses preparation, output paths and independent work order; acceptance requires an observed shorts consumer of those exact transcript bytes. Caption pages are independently replayed with the existing caption library to validate timing/word preservation. That replay does not complete an agent's missing downstream handoff. Dedicated subtitle-export and rendered-video routes need their own consumer adapters before they can count as equivalent routes in this scenario.

The preview-voice chain produces a draft, imports the exact audio through `asset:import`, checks its retained native provenance and exercises the existing delivery draft-refusal boundary. It does not create a production-ready delivery or voice approval. Translation, Vision, sound events and Foundation Models have typed advisory-candidate checks with preserved IDs, intervals and authority. Their review candidates are evaluator adapters, not proof that campaign, timeline or script agents consumed them in production.

The additional v4 consumers check real adoption: translated units populate an explicit scene mapping consumed by `campaign --action localize-create`; new audio/alignment review remains required. `reframe:track` produces a command consumed by `timeline:edit` on a plain video clip. `film:brief --local-evidence FILE` consumes one project-owned result/receipt from text analysis, text assistance, image description or sound events. Source/output hashes, task, operation identity, IDs and text spans are checked. Its bounded, quoted advisory data and binding survive in the saved owner/fixer prompt; independent critics refuse this input. Relevant tasks and inputs remain optional choices for agents; unavailable backends are not advertised as executable suggestions.

## Recorded quality corpora

`--action quality` scores supplied candidate bytes without inference or qualification writes. The versioned manifest pins inputs, references, optional baselines, licence and annotation provenance, and fixes per-case metric thresholds. Reviewed corpora require at least three cases and pinned review evidence. A declared reviewer is recorded attribution, not authenticated proof. The supplied structured corpus is synthetic and demonstrates metrics only.

Metrics cover ASR WER/onset p95, protected translation content and reference conformance, source-bound text spans/IDs, Vision region overlap and labelled temporal audio-event matching. TTS scoring decodes receipt-bound audio with FFmpeg and measures energy/duration; claimed audio checks are not accepted as measurements. Baseline comparisons use the threshold's declared direction. Synthetic results always remain `productionQualified:false`; independently reviewed corpus conformance also never grants automatic film or model approval. Missing independent annotations remain an untested quality layer.

Task-related local tool hints use an explicit stage table, handle nested next-step answers and identify missing language parameters. Ready tools include input preparation guidance; unavailable variants have no executable argv. Preparation, user action and alternatives remain separate. `film:brief` includes the hints in both `metadata.localTools` and the saved brief the subagent reads by path (`metadata.brief`; `--print` returns it as `metadata.prompt`), so dispatching by reference retains them. These are optional affordances; approvals and workflow gates remain authoritative.

## Observer and trust

`src/lib/bench/workflow-observer.ts` invokes trusted command implementations with literal argument arrays, a scoped working directory, bounded output and a minimal environment. Known input/output path arguments and project IDs are checked before spawning. Explicit adapter registration is required: an arbitrary free CLI is not automatically safe for delegated execution. Paid submission, approval, overwrite, global preparation/download and documentation mutations are refused. Local model policy is `never`/autonomous. The new evaluation CLI does not load repository `.env` files.

Agent mode reuses the existing benchmark harness launcher and isolated Git worktrees. A temporary `pnpm` shim sends public command requests over bounded file IPC to the external executor. Per-actor HMAC contexts authenticate request bodies and nonces; contexts are passed only to the owning harness environment, never written into workspace requests, and redacted from retained traces. This prevents a writable inbox path alone from granting another actor identity. Requests and replies are published atomically after complete writes; setup and message paths reject workspace symlinks. This works without enabling network access in the existing workspace sandbox. It changes no global executable or production agent configuration. File creation and reading remain ordinary agent operations; a file-only success claim cannot replace observed execution.

`workflow-delegate "<narrow task>"` starts one real leaf harness when the scenario permits it. The observer assigns actor/parent identities and retains a separate child transcript. A leaf cannot delegate. Root-only claims about child success do not establish a trace. All actors share an observed token allowance, command/delegation limits and campaign deadline. Usage arrives at completed harness messages/turns, so an in-flight response can overshoot; missing usage is unknown. `observedTokens` retains the known lower bound even when an aborted actor has no final usage; `tokens` remains null when a complete total is unavailable. No exact provider-side token or billing cap is claimed.

Relevant trusted source files are fingerprinted and checked for mutation. Real non-fixture agent trials require clean committed source. Development fixture runs retain their exact source fingerprint and dirty label; the commit alone does not describe an uncommitted implementation. A changed implementation refuses continued evaluation.

This is trusted local evaluation, **not an operating-system security boundary**. Agent-authored inputs/transcripts are data. The executor, oracle and evidence live outside the agent-writable workspace. Direct harness actions outside that executor are not certified; an untrusted harness needs independent OS/network/filesystem isolation. Parent/child permissions are not strengthened by a JSON role label. Harness authentication remains the configured harness's responsibility; media-provider credentials are withheld.

## Evidence and interpretation

Private results live under `out/bench/workflow-*/`: frozen scenario bytes, source inventory, reports, bounded harness traces and content-addressed input/output blobs. Pins are captured at observation time, so later input changes cannot rewrite earlier evidence. No media binary or private transcript is committed. Workspaces and owned command groups are cleaned up; `pendingOwnedCommands` describes observed direct command closure. Global orphan counts outside tracked groups are unknown.

Reports distinguish `passed`, `failed`, `skipped` and `inconclusive`, with boundary findings for discovery, preparation, execution, validation, handoff and consumption. They retain actual Node identity, actor ownership, raw counts, repeated calls and observed usage. A completed evaluation with missing native resources is not acceptance of those resources. A CLI failure retains report paths in error metadata.

`check` validates recorded scenario and blob integrity as data. It never executes recorded argv, harness transcripts or submitted code. It does not authenticate the recording's author or independently prove that the claimed execution occurred. Do not award production or public benchmark qualifications from these records.

## Frozen scenarios and extension

`bench/workflows/v2/suite.json` is a separate protocol/suite with newly frozen material. Version-1 benchmark manifests and their known historical material mismatch are retained unchanged. After registration, changed task/material bytes need new versioned paths and manifests.

The initial scenarios cover recording handoff, unsupported languages, draft voice provenance, translated cues, crop candidates, audio markers, source-bound structured drafts, preparation policies, user-only settings, missing language/nested hints, leaf handoff, bounded recovery, playbook intake and budget ownership. Test names and report limitations distinguish simulated backend state from installed execution and actual harness trials.

To add a task, define its versioned schema/pins, expected outcomes and effect limits; register a trusted producer/consumer oracle and any public-command I/O adapter; add positive and negative fixtures; then add installed/native or real-agent trials separately. Accept equivalent routes through semantic artefact checks and causal hashes, not transcript substring matching. Keep quality annotations and hidden human judgements independent of agent-writable outputs. Suite v4 covers short local render/rights refusals and fake-provider recovery; broader production campaigns and independently annotated model-quality corpora remain coverage expansions. A green infrastructure scenario does not certify every product workflow.
