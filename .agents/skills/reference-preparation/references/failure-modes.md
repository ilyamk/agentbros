# Failure modes and the result review

Tiers and dates: [legend](../SKILL.md#references). Review schema: `PackResultReviewSchema` in `src/types/references.ts`.

## What goes wrong

- **Copy-paste and over-conditioning**: the reference's pose, lighting, background and layout come back in the result. Prevent with role sentences that limit what is taken, neutral identity views and empty plates — [P] [Phantom, ICCV 2025](https://openaccess.thecvf.com/content/ICCV2025/papers/Liu_Phantom_Subject-Consistent_Video_Generation_via_Cross-Modal_Alignment_ICCV_2025_paper.pdf) and [ST-DRC](https://huggingface.co/papers/2606.02441.md), checked 2026-11-17.
- **View-dependent collapse**: near-duplicate angles make the model lock onto one view and snap between them ([characters](characters.md)).
- **Identity versus first frame**: a face element that differs strongly from the first-frame face lowers face quality — [O] [Kling Motion Control guide](https://kling.ai/quickstart/motion-control-user-guide), checked 2026-11-17.
- **Last-frame chaining**: colour shift and distortion accumulate, visible by about the third segment — [P] [StreamingT2V, CVPR 2025](https://openaccess.thecvf.com/content/CVPR2025/papers/Henschel_StreamingT2V_Consistent_Dynamic_and_Extendable_Long_Video_Generation_from_Text_CVPR_2025_paper.pdf), checked 2026-11-17. Re-attach the original references to every shot (`chaining: "anchor-reinject"`, which `refs:plan --action check` requires for `first-from-previous-last`), and colour-match only the boundary frame against a fixed anchor.
- **Ignored references**: an attachment with no clear role sentence is dropped by the model; contradictory identity references blend ([markers](markers.md)).
- **Entangled style and identity**: references from the same scene carry its light and background ([style](style.md)).

## Result review

Make the board with `pnpm refs:pack --project ID --action result-board --id PACK --result FILE`, then watch the whole result beside the pack board. Sampled frames alone cannot establish temporal consistency. Dimensions mirror the OpenS2V-Nexus split of subject consistency, naturalness and text relevance — [P] [OpenS2V-Nexus, NeurIPS 2025](https://proceedings.neurips.cc/paper_files/paper/2025/hash/dae77d03bd51a5acfe8519848a3af6c9-Abstract-Datasets_and_Benchmarks_Track.html), checked 2026-11-17.

| Dimension | Values | Fails when |
|---|---|---|
| `identity` | pass, fail, not-applicable | Face, build or hair differs from the identity attachments through turns and occlusions |
| `wardrobe` | pass, fail, not-applicable | Costume, colours or props differ from the card |
| `preserved` | pass, fail | Anything listed in the pack's `preserve` changed |
| `otherSubjects` | pass, fail, not-applicable | A person or object listed as not to alter changed |
| `motion` | pass, fail, not-applicable | Movement does not follow the motion, performance or camera reference, or the prompt's action |
| `naturalness` | pass, fail | Pose, light, background or framing copied from a reference (copy-paste) |
| `promptFit` | pass, fail | The action, camera or change the prompt asks for is missing |
| `temporalConsistency` | pass, fail | Flicker, morphing edges, drifting details between frames |
| `audio` | pass, fail, replace-in-edit | Native audio wrong for the shot's `audioPolicy`; never judged by listening for an agent |
| `verdict` | pass, repair, reshoot | Any failed dimension cannot pass; reshoot is the user's decision |

- Mechanical facts (size, duration, fps, black or frozen frames, sensor warnings) are the QA reviewer's; identity, naturalness and prompt fit are the critic's judgement; the orchestrator records the review with `--action review-result`.
- Identity similarity from a face-embedding model is optional evidence with its model and version, never a verdict.
- After the review: `pnpm memory --add` an observation (profile family, attachment roles and count, verdict, failing dimension). A problem seen twice becomes a profile `guidance` line, a coverage rule or a sensor threshold, with a test, through `creative-postmortem`.

## Repairs before reshoots

| Failing dimension | First repair |
|---|---|
| `identity` | Add a clearly different angle or a face close-up; remove a style-heavy identity view |
| `naturalness` | Tighten role sentences to "only the face", "only the place and light"; use a neutral-background derivative |
| `motion` | Trim the motion clip to one continuous action; remove cuts and camera shake |
| `promptFit` | Move the action first; one camera move; fewer references |
| `temporalConsistency` | Use a shorter take window; cut before drift; re-inject anchors instead of chaining |

Each repair is a new pack id with the user's approval and a new paid attempt within the authorised budget.
