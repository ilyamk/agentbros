# Markers: how a prompt names its inputs

Tiers and dates: [legend](../SKILL.md#references). Dialects as data: each profile's `dialect` in `src/lib/models/reference-profiles.json`; compiler: `src/lib/references/dialects.ts` and `compile.ts`.

## The rule

You never write a marker. `refs:pack --action prepare` compiles the prompt from the spec: the action, one binding sentence per attachment built from its `roleSentence`, the invariants verbatim, then camera, audio, preserve, other subjects, avoid and additional text, in the profile's `promptOrder`. It then checks a bijection: every marker in the final prompt names exactly one attachment, every attachment that carries a marker is named, and no marker of another dialect is present. A marker you type into a prompt field is either redundant or refused. Write the prompt fields in plain words ("the woman", "the red bottle", "the market at dusk").

## Dialects

| Dialect (`dialect.kind`) | What the compiler emits | Families with a profile here | Evidence tier in the profile |
|---|---|---|---|
| `at-indexed` | `@Image{n}`, `@Video{n}`, `@Audio{n}`, numbered per modality (or per `markerGroup`) | seedance-2.0, seedance-2.5 (wrapper); genjutsu object-swap, motion-transfer, restyle (observed, `genjutsu-legacy` template) | see each profile |
| `at-element` | `@Element{n}` for an element, `@Image{n}` and `@Video{n}` for the rest | kling-o1 (official), kling-o3, kling-o3-video, kling-v3-motion-control (wrapper) | see each profile |
| `prose-indexed` | "image {n}" in prose | nano-banana-2.1 (wrapper), flux-2 (official) | see each profile |
| `natural` | a role description, e.g. "the woman in the first reference image" | gemini-omni (official), kling-v2.6-motion-control (unverified) | see each profile |
| `at-named` | `@name` tags | none profiled | — |
| `parameter` | no prompt markers; references go in parameters | none profiled | — |

- `marker: "none"` slots are positional: a start or end frame, the motion-control character image and motion video. They are bound by field and described through their role sentence, never numbered.
- `markerGroup`: slots sharing a group share one numbering.
- A dialect tagged `unverified` warns on the plan and the board; it becomes `observed` only after a recorded passing result (`pnpm memory --add`, then the creative-postmortem route).

## Sources

- Kling O1, O3 and 3.0 Omni use element and indexed at-markers, e.g. "Change X in @Video1 to @Element1" ([O], RFC 0003 §3.9).
- Seedance 2.x indexed at-markers are house use, documented by wrappers; some interfaces show `@Image 1` and one wrapper uses `[Audio1]` ([3P], RFC 0003 §3.9). The profile's templates are what is compiled.
- The Genjutsu `@Video1` and `@Image1` convention is a house prompt convention that has worked in practice, not a provider guarantee ([Obs], [Higgsfield prompting](../../../../docs/higgsfield-prompting.md#marker-prompting)); `model:prepare` composes it.
- Runway Gen-4 References use short named at-tags starting with a letter ([3P], RFC 0003 §3.9; no source link recorded, so no length bound is given); no Runway profile exists here.
- FLUX.2 binds by prose index, "the subject from image 1, the style of image 2" — [O] [BFL FLUX.2 prompting guide](https://docs.eu.bfl.ai/guides/prompting_guide_flux2), checked 2026-11-17.
- Gemini Omni takes natural language only; tags are deprecated — [O] [AI Studio Omni](https://aistudio.google.com/docs/omni), checked 2026-11-17.
- In every dialect, a reference not tied to an explicit requirement in the prompt tends to be ignored, and contradictory identity references blend — [O] [Dreamina reference inputs FAQ](https://dreamina.capcut.com/ai-video/ai-video-reference-inputs-faq), checked 2026-11-17.

## Failure modes

- A hand-typed marker that points at the wrong attachment after the order changed: the compiler refuses foreign or dangling markers, so do not type them.
- A marker carried to a model of another dialect: ignored, or read as text.
- A binding sentence that says "this image" without a role: the model takes everything from it (see [failure modes](failure-modes.md)).
- A marker treated as a mask: a marker identifies an attachment; it does not confine a change to a region.
