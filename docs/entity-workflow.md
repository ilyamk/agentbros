# Entity cards and harness images

An imported original is identified by `sha256:<hash>`. Entity cards bind view roles such as `front`, `profile-left`, `expression:happy`, `packshot-front` or `plate-wide` to those IDs ([coverage and view roles](#coverage-and-view-roles)). A version freezes original paths and hashes. Character, object, location, style and scene cards have specific creative fields and shared invariants, rights and generation notes.

## Import and candidate creation

Import the local file returned by an available agent image tool; record the exact tool/model reported by that tool. An unavailable model identity stays `unknown`. Harness subscription access is not an external API invoice.

```bash
pnpm asset:import --project lesson --input /absolute/path/host.png --origin agent-harness --metadata /absolute/path/import-metadata.json
pnpm entity:card --project lesson --action create --input /absolute/path/host-card.json
pnpm asset:board --project lesson
```

Example import sidecar:

```json
{"provenance":{"origin":"agent-harness","tool":"Codex image tool","model":"unknown","prompt":"Character front reference","billing":{"status":"unknown"}},"rights":{"licence":"unknown","commercialAllowed":"unknown"}}
```

Example character card (replace the hash with the import result):

```json
{
  "id":"host","kind":"character","name":"Host","description":"Illustrated science teacher",
  "createdBy":"agent","invariants":["Orange suit","Same face proportions"],
  "appearance":{"physical":"Illustrated astronaut","wardrobe":"Orange suit"},
  "persona":{"role":"Teacher","traits":["Curious","Patient"],"speakingStyle":"Calm explanatory"},
  "references":[{"assetId":"sha256:REPLACE_WITH_64_HEX_HASH","role":"front"}],
  "likenessConsent":{"status":"not-applicable"}
}
```

Agent creation produces a candidate. Approval is a separate explicit command backed by the actual user's authorization:

```bash
pnpm entity:card --project lesson --action approve --kind character --id host --revision 1 --expected-revision 1 --actor creator --authorization-evidence "Recorded user approval of host revision 1" --confirm-user-approval
pnpm entity:card --project lesson --action show --kind character --id host
```

The actor and evidence are declarations supplied by the caller, not authenticated identity. Approval does not infer likeness, voice or licence consent. Documented consent fields require their own supplied evidence and scope.

## Revision and reuse

`revise` accepts a complete card and requires `--expected-revision`; stale edits fail. `--base-revision` forks a historical card into a new revision. Canonical revision remains pinned until explicit approval of another version; canonical selections retain actor/evidence history.

```bash
pnpm entity:card --project lesson --action revise --input /absolute/path/host-card-v2.json --expected-revision 1
pnpm entity:card --project lesson --action list
```

Scene cards use `links: [{"kind":"character","entityId":"host","revision":1}]` plus action/objective/blocking/continuity fields and optional `shotIds`. Approving a scene verifies that linked versions are approved and their asset hashes still match.

`resolveEntityReferences()` supplies the same pinned role references for vertical, square and landscape. `compileEntityBindings()` materializes an approved role into `scene.imageUrl` or an image left panel without modifying the source project config; it validates scene/media compatibility. Its explicit bindings preserve the exact entity revision used by a shot. Local originals remain public-relative renderer paths; provider uploads are a separate adapter responsibility.

## Coverage and view roles

Reference roles come from a fixed vocabulary (`EntityViewRoleSchema` in `src/types/reference-view.ts`: `front`, `three-quarter-left`, `profile-right`, `back`, `face-closeup`, `packshot-front`, `label-detail`, `plate-wide`, `style-board`, `voice-sample`, `expression:*`, `outfit:*`, `plate:*`, `lighting:*`, `custom:*`). Optional `facts` per reference: `yawDeg`, `background`, `lighting`, `outfitId`, `handsEmpty`, `containsOtherPeople`, `styleNeutral`; leave unknown ones absent. Cards may hold `fixedSentence` (the verbatim invariant prompt sentence); a character's `voice` may hold `sampleAssetIds` and `pronunciation`.

`pnpm entity:card --project lesson --action coverage --kind character --id host` checks the pinned revision against `src/lib/references/coverage.json`: `missing` views, `ruleFindings` (`warn`, or `unknown` for undeclared facts) and `unrecognisedRoles` for old free-string roles. It is advisory and blocks nothing. Model inputs from cards: [reference packs](reference-packs.md).

## Artifacts

```
public/projects/<id>/entities/<kind>/<entity-id>/
  entity.json              # latest/canonical pointers and canonical selection history
  versions/000001.json      # immutable card and reference snapshots with content hash
  approvals/000001.json     # immutable explicit approval of that version/hash
public/projects/<id>/entities/asset-board.html
```

The board is a static local review page with actual media previews, source/model/licence/billing metadata, canonical role labels, per-view facts and advisory coverage. It uses native HTML media for inspection and executes no scripts or provider requests. Originals and cards are verified before use; missing/corrupt media and escaping symlinks fail explicitly.

For canonical renders, `pipeline/entity-bindings.json` may contain an array of validated `EntityShotBinding` records. The render plan resolves only the pinned approved version and checks original checksums before building props. The source project is not rewritten. An explicitly edited timeline remains its own frozen snapshot; changing a canonical entity binding does not silently replace an edited clip.
