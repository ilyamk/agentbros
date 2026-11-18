# Material

The material step of the [production chain](../production-chain.md).

At material, a Genjutsu item may carry `modelPreparation: {id, sha256}`. The plan can be proposed before approval; after the material plan is approved, its preparation must also be approved before generation. `film:rights --preparation ID` records source-use permissions for an immutable preparation in any project, independently of the unchanged replica rights gate. Input rights, visual approval and the material/spend gate are distinct. The owner plans and checks; the orchestrator performs local preparation and records only actual user decisions. See [prepared Genjutsu](../higgsfield-prompting.md#prepared-genjutsu-workflow).

## Reference requirements (RFC 0003)

The material step's done check `references-ready` follows its two approvals. Every generated visual item not yet acquired (`generated-image`, `generated-video`, or any non-audio item on the `generated` route) carries `referencePlan: {mode: "none", reason}` (the generation deliberately uses no reference inputs) or has a shot in the optional output `pipeline/references.json`, matched by `materialItemId`.

- Before the material approval, those shots have no `refs:plan --action check` error and no required requirement left `missing`. Inputs that are `planned` or `pending-approval`, such as a chained first frame taken from another shot's output, may wait, and so may the packs.
- After it, every required requirement is `ready`. A `shot-output` requirement counts once that shot's material item is acquired. The item's `referencePack: {id, sha256}` must be bound to an approved, current pack in `pipeline/reference-packs/<id>/`.

`pnpm refs:plan --project <id> --action draft|check|status|board` writes and checks the requirements. Each failure of the check, and each open requirement in `status`, names the command that resolves it: `entity:card` create or approve, `asset:import`, `refs:derive`, `refs:pack` prepare or approve, or `film:approve`. Projects with no generated items pass. An acquired item is already made: `references-ready` skips it, and `material-sourced` checks only that its bound pack revision is still the approved one on disk and that its file is in that pack's `outputs.json`. A film whose material step was sealed or approved before reference packs (no `references.json`, no item with `referencePack` or `referencePlan`) gets advisories, not failures, so its approval is not voided. See [RFC 0003](../rfcs/0003-reference-packs.md) §10.1.
