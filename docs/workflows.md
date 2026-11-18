# Complete local video workflows

`video:recipe` makes an animatic. `video:workflow` plans or creates a concrete project using supplied original files, spoken scripts/timings and explicit evidence. It never calls generation, ASR, stock discovery, upload or publishing APIs. Four maintained scenarios share the existing renderer, TimelineIR, edit, audio, caption, QA and delivery tools.

| Scenario | Request and creative direction |
|---|---|
| `product-ad` | [Product advertisement](workflows/product-ad.md): demonstrated product behavior, evidence-backed benefits and one CTA |
| `education` | [Education](workflows/education.md): question, prerequisites, explanation, worked example, application and recap |
| `recording-edit` | [Recording recut](workflows/recording-edit.md): reviewed source intervals retaining speech, captions and semantic context |
| `shorts-series` | [Shorts series](workflows/shorts-series.md): explicitly approved contextual selections, independent derived projects and pinned sources |

A user's own recording (recut, captions, shorts) starts from `pnpm footage:next --project <id>` ([footage editing](footage-editing.md)), which emits the `recording-edit` and `shorts-series` steps; call them directly only as that low-level step.

```bash
pnpm video:workflow --action list
pnpm video:workflow --scenario product-ad --request REQUEST.json
pnpm video:workflow --scenario product-ad --request REQUEST.json --action create
pnpm video:workflow --scenario product-ad --request REQUEST.json --action create --dry-run
```

Plan is the default and writes nothing. Create requires all scenario inputs, refuses occupied project destinations, and preserves original files. The JSON response names new artifacts and subsequent render/review steps. Source checksums prevent stale substitutions. Supply a new project ID for a revised creation; use revision-checked timeline commands for existing ads, lessons and recording edits. Shorts freeze approved episode inputs: change their content by deriving a newly reviewed series, with a new series ID.

Requests resolve local paths against the workspace, not the request file's directory. The request itself must be regular JSON no larger than 8 MiB; a symlink request is rejected. Source/path and semantic checks belong to each strict scenario schema and its planner. For trusted workspace MCP use `avc_video_workflow`; the launcher bounds nested originals to its canonical root. Manifest-driven creation is disabled in single-project scope because a series can create multiple projects. This is a trusted local tool, not a multi-tenant sandbox.

Follow the scenario-specific render and chapter instructions. Use licensed cached originals with `render --font-context` for fully offline production rendering; tests may explicitly substitute fonts and cannot grant a production font licence. Export clean/captioned variants and SRT/VTT via the existing tools. Run pipeline preflight, measured audio and event/browser QA. Missing pipeline creative stages require real review or the existing explicit manual delivery mode, never fabricated stage completion.

The workflow creates renderable source-bound artifacts. It does not authenticate the person named in supplied reviews, prove external claims/licences, or guarantee creative quality. Final publication uses [strict delivery](delivery.md): snapshot, render receipt, source/story-bound approvals, rights/claims, exact visual review and output checks. A draft without those records remains `draft-needs-review`.

Local verification: `pnpm test:workflows` enables actual browser/MP4 cases, including the 180-second lesson, in addition to unit/negative cases. Set `WORKFLOW_ARTIFACTS_DIR` to an absolute local directory to retain fixture media and frame reports. Synthetic fixture approvals, speech tones and font substitutes remain explicitly test evidence; no paid APIs or billing are involved.

Recording-edit version 2 supports VFR and exact 30000/1001 with explicit reviewed PTS-based normalization to a 30fps master; version 1 preserves verified 30fps CFR behavior. Run `pnpm test:recording:timing` for the actual recording render cases. The older lesson suite uses reduced render scales; `WORKFLOW_ARTIFACTS_DIR="$PWD/out/qa/vfr-fullhd" pnpm test:longform:fullhd` renders the 180-second lesson at actual 1920×1080, scale 1. Then run `pnpm test:longform:fullhd:qa` with the same artifact directory for independent fresh stills.  and Full HD benchmark; the separate 10–20-minute benchmark remains open.
