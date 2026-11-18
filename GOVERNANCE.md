# Governance

## Maintainer and authority

The maintainer is [@ilyamk](https://github.com/ilyamk). The maintainer approves designs, protected-path changes, context growth and trust grants; resolves appeals; coordinates security reports; and merges through the merge queue. Submit work through PRs and follow [the Code of Conduct](CODE_OF_CONDUCT.md).

## Trust tiers

Use the limits in [CONTRIBUTING.md](CONTRIBUTING.md#choose-work-within-your-tier) and the computation in [offline gates](docs/contributing-gates.md). Tier 0 is the default; three merges with slop share below 20% earn tier 1. The share counts only `closed:slop` closures from the last 90 days: rules 3 (duplicate) and 5 (media or leak) and a maintainer's manual slop closure. Procedural closures (rules 1, 2, 4, 6 and 7) carry `closed:process` and never affect the tier. Tier 2 requires ten merges and a maintainer grant; tier 3 is maintainer authority. Only maintainers may apply trust overrides. Two deterministic slop closures in 30 days lower the owner one tier for that window. Do not infer approval from a contributor-supplied label or context file.

## Proposals and decisions

For size L, a new dependency, a new category or a contract change, open a proposal issue with an RFC draft at `docs/rfcs/NNNN-slug.md`; choose the next unused number. Include the problem, alternatives, compatibility, costs, risks, definition of done and verification. Use [RFC 0001](docs/rfcs/0001-contribution-system.md) as the existing decision record and template.

Discuss the design before implementing it. Wait for the maintainer's `design-approved` label; protected paths also require this approval at S/M size. Keep a PR to its approved scope; seek a decision again when a material design assumption changes. Record the decision, date, rationale and unresolved questions in the RFC's status/decision section. Acceptance of a design does not waive tests, CLA, category gates or owner review.

Resolve ordinary implementation questions in the PR with code and evidence. Ask the maintainer to decide unresolved scope or compatibility trade-offs. For an incorrect closure by the bot, use `/appeal <reason>` once and await human review. An appeal exempts the PR from the rule that closed it only; rule 5 (media or leak) cannot be appealed, and a maintainer's manual closure is discussed with the maintainer, not appealed. Triage model labels are advisory; they cannot approve, merge or close a PR. Coordinate vulnerability decisions privately under [SECURITY.md](SECURITY.md).
