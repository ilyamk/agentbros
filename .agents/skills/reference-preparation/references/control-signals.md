# Control signals: depth, pose, edge and mask

Tiers and dates: [legend](../SKILL.md#references). Profile limits: `pnpm refs:profiles --action show --family F`.

A control signal constrains structure, not look: pose drives the body only, depth drives layout and volume, an edge or lineart video drives contours, a mask says where a change may happen. A marker is never a mask.

## What exists here today

- No profiled family has a dedicated depth, pose, edge or mask slot. `refs:plan --action draft` with intent `control-to-video` therefore carries a pose sequence as a `motion` input on a profile that takes motion video, with a `pose-video` derivative, and says so in its notes. Control-video routes such as Wan VACE have no profile, so they cannot be packed; tell the user rather than hand-building a request.
- Derivative engines (`refs:derive --action plan` reports each step's engine and status):
  - `depth-video`, `pose-video`, `mask-video` and `audio-clean` with engine `fal` run as paid jobs through the durable job path; the default endpoints are in `src/lib/references/derive/fal.ts`. They need the user's yes to the quote and `--confirm-spend`.
  - The same ops with a local engine, and lineart `edge-video`, are not built yet; plan them as `fal` steps or as a Blender pass.
  - Canny `edge-video` runs locally with ffmpeg.
  - A Blender `depth`, `normal` or `mist` pass is local and exact for a scene you built ([previs-3d](previs-3d.md)).
- A paid or Blender step leads its derivative; chain the local steps after it in a second derivative whose input is the first (`input.derivativeId`).

## Prepare

- Match the target exactly: the control video has the output's resolution, fps and frame count. Use `scale`, `fps`, `trim` and `snap` derivatives; never let the model resample.
- Depth from a temporally consistent video depth model, never frame-by-frame image depth.
- Pose from one performer, the same clip the shot's timing comes from.
- Masks: choose coarse or fine for the shot (replacement of a person wants coarse enough to hide the old silhouette; a local fix wants fine).

## Specs and sources

- Pose, depth, canny and lineart control videos drive Wan VACE; control videos match the target resolution, fps and frame count exactly, and Wan sizes are multiples of 16 — [O] [Comfy Wan VACE tutorial](https://docs.comfy.org/tutorials/video/wan/vace), checked 2026-11-17.
- Video Depth Anything adds a temporal head and loss over Depth Anything V2 and processes long video in 32-frame overlapping segments — [P] [arXiv 2501.12375](https://arxiv.org/html/2501.12375v3), checked 2026-11-17. Per-frame Depth Anything V2 flickers ([3P], RFC 0003 §3.6).
- Wan Animate masks: coarse masks leak body shape, fine masks risk background drift ([3P], RFC 0003 §3.5).

## In our system

| Signal | Requirement role | Derivative op | Engine today |
|---|---|---|---|
| Depth | `depth` | `depth-video`, or `blender-pass` with `pass: "depth"` | fal (paid) or Blender |
| Pose | `pose` | `pose-video` | fal (paid) |
| Edges | `edge` | `edge-video` with `kind: "canny"` or `"lineart"` | ffmpeg (canny); lineart not built |
| Mask | `mask` | `mask-video`, or `cutout` on an extracted frame | fal (paid) for video; matte-onnx for a still |
| Exact size and length | any | `scale`, `fps`, `trim`, `snap` | ffmpeg |

- Sensors warn on temporal flicker and frame count of a control video (`src/lib/references/sensors.ts`); a flicker warning is a reason to change the engine, not to raise the threshold.

## Failure modes

- Per-frame depth flicker: the generated surface boils.
- A mismatched frame count or size: the model stretches or loops the guide, and motion drifts out of sync.
- Pose from a clip with several people: the skeleton jumps between them.
- A clay or grey render passed as depth: it is a picture, not a depth map (see [previs-3d](previs-3d.md)).
