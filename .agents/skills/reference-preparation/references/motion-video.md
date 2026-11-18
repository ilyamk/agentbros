# Motion, performance, camera and source videos

Tiers and dates: [legend](../SKILL.md#references). Profile limits: `pnpm refs:profiles --action show --family F`. Rights: any `motion`, `performance`, `camera` or `source-video` attachment needs `refs:pack --action rights` in the user's words before approval.

## Prepare

- **Motion or performance clip**: one performer, head and body visible, one continuous shot with no cuts, a locked camera, moderate speed. Real humans drive best.
- **Framing match**: the character image is framed like the clip (full body to full body, waist up to waist up), and its pose matches the clip's first frame.
- **Trim to the model's window** with a `trim` derivative; never send a longer clip and hope.
- **Strip audio** (`strip-audio`) unless the profile uses the reference's sound and the shot wants it.
- **Camera reference**: a plate or previs clip with the intended move and nothing else happening; or a Blender camera path ([previs-3d](previs-3d.md)).
- **Source video to edit or replace**: the exact segment, cropped and trimmed; what must stay is listed in the pack's `preserve` and `otherSubjects`.

## Specs and limits (model-specific)

- Kling Motion Control: one performer, head and body visible, single continuous shot, no cuts or camera moves, moderate speed; the character image framing matches the video — [O] [Kling Motion Control guide](https://kling.ai/quickstart/motion-control-user-guide), checked 2026-11-17.
- Kling Motion Control on fal: motion video 3–30 s, edges from 340 to 3850 px; element binding only with `character_orientation: "video"`, and image orientation limits the video to 10 s — [3P] [fal Kling v3 motion control API](https://fal.ai/models/fal-ai/kling-video/v3/pro/motion-control/api), checked 2026-11-17.
- Kling O3 reference-to-video: one element video of 3–10 s with edges from 720 to 2160 px; with any video attached, images plus elements are at most 4; no native audio with a video input — [3P] [fal Kling O3 reference-to-video API](https://fal.ai/models/fal-ai/kling-video/o3/pro/reference-to-video/api), checked 2026-11-17.
- Kling O3 video-to-video: one source video of 3–15 s, edges from 720 to 3840 px — [3P] [fal Kling O3 video-to-video API](https://fal.ai/models/fal-ai/kling-video/o3/pro/video-to-video/reference/api), checked 2026-11-17.
- Seedance 2.5 reference-to-video: up to 10 videos of 1.8–30.2 s each and in total, edges from 300 to 6000 px, aspect from 0.4 to 2.5, at most 50 references of all kinds — [3P] [fal Seedance 2.5 reference-to-video API](https://fal.ai/models/bytedance/seedance-2.5/reference-to-video/api), checked 2026-11-17.
- Seedance 2.0: up to 3 reference videos — [3P] [fal Seedance 2.0 reference-to-video API](https://fal.ai/models/bytedance/seedance-2.0/fast/reference-to-video/api), checked 2026-11-17. One wrapper also caps their combined length; no schema states it, so the profile carries it as unverified guidance, not a limit.
- Gemini Omni: reference videos of at most 3 s; up to 3 for 3–10 s outputs and 1 for 11–15 s outputs; their audio is ignored; reasoning across several videos "is not supported and may degrade output" — [O] [AI Studio video](https://aistudio.google.com/docs/video), checked 2026-11-17.
- Higgsfield Genjutsu (`model:prepare`): one source video of 4–30 s — [O] [Higgsfield Genjutsu object swap](https://docs.higgsfield.ai/docs/models/genjutsu/object-swap.md), checked 2026-11-17.
- Runway Act-Two: performer and character face the same way and fill similar screen space ([O], RFC 0003 §3.5); a bounded driving-video length and a character pose matched to its first frame are practitioner advice ([3P], no source link recorded). No Runway profile exists here; it cannot be packed.
- Luma Ray3 Modify takes a short input, and the modified subject should appear in the start or end frame ([O], RFC 0003 §3.5, no source link recorded). No Luma profile exists here; it cannot be packed.
- Wan Animate: DWPose extracts pose and face, and a SAM mask isolates the replaced person ([O], RFC 0003 §3.5); coarse masks leak body shape, fine masks risk background drift ([3P]). Sizes snap as in [control signals](control-signals.md). No Wan profile exists here; it cannot be packed.

## In our system

| Need | Requirement role | Typical slot | Derivatives |
|---|---|---|---|
| A performer's movement | `motion` or `performance` | motion-control `motion`, a reference-to-video `videos` slot | `trim`, `crop`, `scale`, `strip-audio` |
| A camera move | `camera` | `videos` | `trim`, `strip-audio`; a Blender `camera-path` |
| The clip to change | `source-video` | `source` | `trim`, `crop`, `fps` |
| A face for motion control | `identity` | `face`, `face-references` | `crop`, `cutout` then `flatten` |

- `refs:plan` intents: `motion-transfer` asks for a motion video; `character-replace` and `video-edit` for a source video; `extend` for the shot to continue.
- Sensors at derive and pack time warn on scene cuts and camera motion in a motion or performance clip, black or frozen spans, and duration outside the slot. A cut inside a motion clip is a reason to trim, not to override.
- Motion-control inputs are positional (`marker: none`): they are bound by field, and the compiler describes them through their role sentence.

## Failure modes

- Cuts, handheld shake or several people in a motion clip: the model follows the wrong body or jumps.
- A framing mismatch (close-up image, full-body clip): limbs invented, face distorted.
- A motion reference with no role limit: the model copies the clip's setting and look as well as its movement.
- An element face very different from the first-frame face: face quality drops — [O] [Kling Motion Control guide](https://kling.ai/quickstart/motion-control-user-guide), checked 2026-11-17.
- An over-length clip passed through: refused by the compiler with the derivative that fixes it; trim, do not edit limits.
