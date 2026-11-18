<!-- agentbros:pr
category: <category>             # one id from contrib/categories.json
size: <size>                     # S | M | L
issue: <issue>                   # positive number; remove this line for S without an issue
autonomy: <autonomy>             # autonomous | assisted | human
harness: <harness>               # claude-code | codex | other
model: <model>                   # actual model id, or none for human-only work
owner: <owner>                   # accountable human's GitHub handle
change: .changes/<slug>.md        # exactly one added entry, matching category
-->

## What changed and why

<!-- Name the problem, opportunity or issue and the resulting behaviour. -->

## Evidence

<!-- Summarise .contrib/evidence.json: commands, results and category evidence. Link leak-clean artefacts; distinguish fixtures from live verification. -->

## What was not verified

<!-- List skipped checks and missing prerequisites, or write None. -->

## Risks

<!-- State compatibility, dependency and rollout risks, or write None. The human owner signs the CLA by PR comment, not here. -->

<!-- Automated LLM triage is currently inactive (contrib/triage.json has enabled: false). When enabled, two model families judge through one OpenRouter key, and triage:likely-slop keeps a PR out of the owner queue until a human looks. See docs/triage.md. -->
