import { defineItem, type LibraryItem } from "../types";
import { CLIP_FILL_FRAMES, ClipFill, clipFillDefaults, clipFillSchema } from "./ClipFill";
import { FOCUS_PULL_FRAMES, FocusPullPreview, focusPullCues, focusPullSchema } from "./FocusPull";
import { PARALLAX_RIG_FRAMES, ParallaxRigPreview, parallaxRigSchema } from "./ParallaxRig";
import { PHOTO_MOVE_FRAMES, PhotoMove, photoMoveDefaults, photoMoveSchema } from "./PhotoMove";
import { SNAP_ZOOM_FRAMES, SnapZoomPreview, snapZoomSchema } from "./SnapZoom";
import {
  CAMERA_BREATH_FRAMES,
  CameraBreathPreview,
  cameraBreathCues,
  cameraBreathDefaults,
  cameraBreathSchema,
} from "./CameraBreath";
import { PopulatePullOutLibraryPreview } from "./VideoWall";
import {
  dropFrames,
  POPULATE_PULL_OUT_FRAMES,
  populatePullOutCues,
  populatePullOutDefaults,
  populatePullOutSchema,
} from "./PopulatePullOut";
import {
  reframeCues,
  UI_PUNCH_REFRAME_FRAMES,
  UiPunchReframePreview,
  uiPunchReframeDefaults,
  uiPunchReframeSchema,
} from "./UiPunchReframe";
import { SPEED_RAMP_FRAMES, SpeedRampPreview, speedRampCues, speedRampDefaults, speedRampSchema } from "./SpeedRamp";

import { GlassLens, glassLensCues, glassLensDefaults, glassLensSchema } from "./GlassLens";

export const items: LibraryItem[] = [
  defineItem({
    id: "glass-lens",
    category: "camera",
    title: "Glass lens follows a detail",
    description:
      "A travelling magnifier enlarges concentric regions of a still or visual plate while the rest stays visible. Hold a stop over a small product detail or part of a diagram so the viewer can read it in context.",
    tags: ["magnifier", "macro", "glass", "detail", "evidence", "focus"],
    component: GlassLens,
    schema: glassLensSchema,
    defaultProps: glassLensDefaults,
    durationInFrames: 96,
    formats: ["vertical", "landscape", "square"],
    inspiredBy: ["DesignBookmark Motion: Glass lens, concentric magnification (method only)"],
    importPath: "src/motion/library/camera/GlassLens",
    cues: glassLensCues,
  }),
  defineItem({
    id: "parallax-rig",
    category: "camera",
    title: "2.5D parallax rig",
    description:
      "A flat layout becomes a place: planes at real depths slide, scale and defocus against each other as the camera dollies, trucks, cranes or orbits, with optional handheld micro-shake. Use `rigPose(frame, { move, from, to, amount, handheld })` from src/motion/library/camera/ParallaxRig as the pose of `<Camera>` around your own `<DepthLayer>`s.",
    tags: ["parallax", "2.5d", "dolly", "truck", "orbit", "crane", "handheld", "depth"],
    component: ParallaxRigPreview,
    schema: parallaxRigSchema,
    defaultProps: { move: "orbit", amount: 520, handheld: 0.25, aperture: 0.012, headline: "Ship in hours." },
    durationInFrames: PARALLAX_RIG_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: ["src/motion/camera.tsx Camera/DepthLayer", "Apple product film 2.5D card parallax (idea only)"],
    importPath: "src/motion/library/camera/ParallaxRig",
    cues: () => [],
  }),
  defineItem({
    id: "focus-pull",
    category: "camera",
    title: "Push-in with focus pull",
    description:
      'A slow push towards the scene while focus racks from the background headline to the foreground card, handing the eye from statement to proof. Use `focusPullPose(frame, { pushFrom, pushTo, push, rackFrom, rackTo, focusFrom, focusTo })` from src/motion/library/camera/FocusPull with `<Camera lens={{ aperture: 0.03 }}>`. `mode: "ramp"` instead defocuses the whole footage layer over about 0.75 s on sine.inOut while an overlay (an end card, a mark, an offer) stays sharp: `<DefocusRamp at frames blur overlay>`.',
    tags: [
      "push-in",
      "rack focus",
      "depth of field",
      "dolly",
      "calm",
      "premium",
      "defocus",
      "blur ramp",
      "end card",
      "footage",
    ],
    component: FocusPullPreview,
    schema: focusPullSchema,
    defaultProps: { push: 260, focusFrom: 900, focusTo: 0, aperture: 0.03, handheld: 0.15, headline: "Ship in hours." },
    durationInFrames: FOCUS_PULL_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "src/motion/AGENTS.md camera example (rack keys)",
      "cinematography rack focus convention",
      "design-reference/library/gojiberry: defocus-end-card 47.20-56.53 s (from about 48.3 s the whole plate defocuses while the mark and wordmark type on sharp over it; mode ramp, soft from about 48.4 s to 49.1 s, evenly: about 0.75 s, sine.inOut)",
    ],
    importPath: "src/motion/library/camera/FocusPull",
    usage:
      'focusPullPose(frame, {...}) with <Camera>; or, for mode ramp, import { DefocusRamp } from "src/motion/library/camera/FocusPull"; <DefocusRamp at={walkOut} frames={22} blur={24} overlay={<EndCard />}>{footage}</DefocusRamp> (defocusRamp in camera-plan.ts gives the blur per frame).',
    cues: (props) => focusPullCues(props as Parameters<typeof focusPullCues>[0]),
  }),
  defineItem({
    id: "snap-zoom",
    category: "camera",
    title: "Snap-zoom punch",
    description:
      "The frame punches in on a beat, blurs for two frames and rings out with a small settle; repeated beats ratchet closer. Wrap any scene in `<SnapZoom beats levels originX originY handheld>` from src/motion/library/camera/SnapZoom, or drive your own transform with `snapScale(frame, beats, levels)`.",
    tags: ["snap zoom", "punch", "beat", "music", "energy", "handheld", "emphasis"],
    component: SnapZoomPreview,
    schema: snapZoomSchema,
    defaultProps: { beats: [22, 54], levels: [1, 1.24, 1.62], originX: 0.82, originY: 0.56, handheld: 0.3 },
    durationInFrames: SNAP_ZOOM_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: ["music-video snap zoom on the kick (idea only)", "src/motion/kinetic-math.ts settle/hitDecay"],
    importPath: "src/motion/library/camera/SnapZoom",
    cues: (props) =>
      (props as { beats: number[] }).beats.map((frame, i, all) => ({
        frame,
        kind: "hit",
        sfx: "impact",
        weight: i === all.length - 1 ? "hero" : "support",
        label: "snap",
      })),
  }),
  defineItem({
    id: "photo-move",
    category: "camera",
    title: "Photo move (Ken Burns)",
    description:
      'A still photo moves from a start crop to an end crop (focus boxes normalised to the image): a push in to a face, a pan from one person to another, a pull out to the place. Zoom is geometric and never slower than minSpeed (2% a second by default) so it does not measure as frozen; fill "blur" sets a photo of another orientation whole over a blurred copy. Take imageWidth, imageHeight, from, to and fill per format from `pnpm photo:focus`. `frame: "card"` sets the moving photo in a card with a 1 px edge on a paper ground (about 0.25 W x 0.45 H, right third), with an optional second card cut on behind it at about 3 degrees (`secondAt`) and a small serif `caption`.',
    tags: [
      "ken burns",
      "photo",
      "still",
      "slideshow",
      "push-in",
      "pan",
      "zoom",
      "blur fill",
      "memories",
      "real estate",
      "image card",
      "archive",
      "paper",
      "stacked cards",
    ],
    component: PhotoMove,
    schema: photoMoveSchema,
    defaultProps: photoMoveDefaults,
    durationInFrames: PHOTO_MOVE_FRAMES,
    formats: ["vertical", "landscape", "square"],
    inspiredBy: [
      "Ken Burns effect (documentary technique, idea only)",
      "design-reference/library/abdulah: t04-image-card-on-paper 5.43-6.87 s (one archive photo card about 0.25 W x 0.45 H at x 0.56-0.81 on #F8F6F2, the spoken word set small in serif; at F177 a second card stacks behind, rotated about 3 degrees and offset, on a cut)",
    ],
    importPath: "src/motion/library/camera/PhotoMove",
    cues: (props) => {
      const p = props as { frame?: "full" | "card"; secondAt?: number };
      return p.frame === "card" && (p.secondAt ?? -1) >= 0
        ? [{ frame: p.secondAt!, kind: "cut", sfx: "tick", weight: "support", label: "second card cuts on behind" }]
        : [];
    },
  }),
  defineItem({
    id: "clip-fill",
    category: "camera",
    title: "Clip over blurred fill",
    description:
      "A video clip of the other orientation (a phone's portrait clip in a landscape film, a landscape clip in a vertical one) plays whole over a blurred, darkened, muted copy of itself instead of black bars. Use when a crop would cut the subject; when it would not, crop with reframe:track instead.",
    tags: ["blur fill", "portrait clip", "pillarbox", "letterbox", "phone footage", "event", "orientation", "video"],
    component: ClipFill,
    schema: clipFillSchema,
    defaultProps: clipFillDefaults,
    durationInFrames: CLIP_FILL_FRAMES,
    formats: ["vertical", "square", "landscape"],
    inspiredBy: ["blurred pillarbox fill of broadcast and social video (common practice, idea only)"],
    importPath: "src/motion/library/camera/ClipFill",
    cues: () => [],
  }),
  defineItem({
    id: "camera-breath",
    category: "camera",
    title: "Camera breath",
    description:
      "A held, not locked, camera around any shot: slow seeded drift, a breath in scale and a faint roll, overscanned so edges never show, with an optional punch-in on hits that releases by itself. Use on holds and end cards that must still live; keep amplitude under 14 px.",
    tags: ["handheld", "breathing", "drift", "hold", "alive", "punch-in", "hit", "subtle", "camera"],
    component: CameraBreathPreview,
    schema: cameraBreathSchema,
    defaultProps: cameraBreathDefaults,
    durationInFrames: CAMERA_BREATH_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "src/motion/library/finish/FilmFinish drift (idea reused)",
      "src/motion/timing intentCurves snap/glide",
    ],
    importPath: "src/motion/library/camera/CameraBreath",
    usage:
      'import { CameraBreath, breathPose } from "src/motion/library/camera/CameraBreath"; <CameraBreath amplitude={10} hits={[hit]} punch={0.05}>{shot}</CameraBreath>. Use breathPose(frame, fps, unit, settings) to drive your own <Camera> pose.',
    cues: (props) => cameraBreathCues(props as Parameters<typeof cameraBreathCues>[0]),
  }),
  defineItem({
    id: "speed-ramp",
    category: "camera",
    title: "Speed ramp",
    description:
      "Any shot plays slow, surges fast with a directional blur that grows with the speed, and eases back to slow motion, continuous with no stutter (`timeRemap`). Use on footage or procedural motion to put a beat's energy into time itself; land the return on a hit.",
    tags: ["speed ramp", "slow motion", "time remap", "fast forward", "motion blur", "energy", "beat", "footage"],
    component: SpeedRampPreview,
    schema: speedRampSchema,
    defaultProps: speedRampDefaults,
    durationInFrames: SPEED_RAMP_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "src/motion/timing timeRemap/speedAt",
      "editorial speed ramps on action footage (common practice, idea only)",
    ],
    importPath: "src/motion/library/camera/SpeedRamp",
    usage:
      'import { SpeedRamp } from "src/motion/library/camera/SpeedRamp"; <SpeedRamp initialSpeed={0.3} segments={[{ at: 30, speed: 4, ramp: 10 }, { at: 64, speed: 0.25, ramp: 14 }]}>{shot}</SpeedRamp>. For <Video> from @remotion/media, seek with Math.round(timeRemap(frame, segments)) yourself.',
    cues: (props) => speedRampCues(props as Parameters<typeof speedRampCues>[0]),
  }),
  defineItem({
    id: "ui-punch-reframe",
    category: "camera",
    title: "UI punch reframe",
    description:
      "Hard-cut reframes of one interface or record at a list of scales and anchors instead of a zoom (wide, the field at 2x as typing starts, wide again when the line outgrows the frame, the button at 7x), each cut on motion, with an optional 16-frame expo.out settle (in scale, or sideways with `settlePan`: `uiPunchReframeNexaaSettle`) and a slow drift in each hold; text stays sharp on every frame. Use to read a real product screen at legible size; feed it a capture at 2x or more for the macro.",
    tags: ["reframe", "punch in", "hard cut", "ui", "interface", "record", "macro", "typing", "product", "screen"],
    component: UiPunchReframePreview,
    schema: uiPunchReframeSchema,
    defaultProps: uiPunchReframeDefaults,
    durationInFrames: UI_PUNCH_REFRAME_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "design-reference/library/nexaa: ui-punch-in-reframe 6.58-11.13 s (wide to 2x on the field as typing starts, back to wide, 7x on the send button; scale never animated; after the cut-in the framing slides right 0.125 W at a constant scale, 75% done after 0.12 s, uiPunchReframeNexaaSettle)",
      "design-reference/library/context-dev: ui-punch-in-reframe 4.37-8.43 s (four hard reframes on one record, each cut on motion, alternating sides)",
      "design-reference/library/ace: punch-in-cut-settle 9.18-9.45 s (settle after the cut, expo.out, done in 16 frames, 2-4% travel)",
    ],
    importPath: "src/motion/library/camera/UiPunchReframe",
    usage:
      'import { UiPunchReframe, reframePose, reframeCues } from "src/motion/library/camera/UiPunchReframe"; <UiPunchReframe shots={[{ at: 0, scale: 1, x: 0.5, y: 0.5 }, { at: 18, scale: 2, x: 0.36, y: 0.6 }]} settleFrames={16} settleShare={0.03} drift={0.006}>{capturedScreen}</UiPunchReframe>. Shots are framings of the stage (shares of the frame); put each `at` on a moment of motion (a glyph typing, a click).',
    cues: (props) => reframeCues((props as { shots: Parameters<typeof reframeCues>[0] }).shots),
  }),
  defineItem({
    id: "populate-pull-out",
    category: "camera",
    title: "Populate, then pull out",
    description:
      'While the view is close (about 1.2x) and drifting at constant speed, items land one at a time every 4-6 frames; then the camera pulls back to the whole result at 1x on expo.out in about 15 frames, or in two stages (a quick first pull, then a jump that settles on circ.out over about 38 frames). `variant: "wall"` turns it into a wall of real people\'s clips: white blurred tiles resolve into clips ring by ring from the centre (placeholder-resolve) while the view pulls back on power2.out for 15 frames then power1.out for 51 (`<VideoWall>`), its columns optionally scrolling in opposite directions, bowed on a cylinder and under a frame-fixed vignette (`wallScroll`, `wallCurve`, `<WallVignette>`; `populatePullOutWallPreset`). Use to turn many small arrivals into one picture of the full board, grid or crowd; the whole-frame drift counts as motion spread in a film, so keep it to this shot.',
    tags: [
      "pull out",
      "pull back",
      "reveal",
      "populate",
      "board",
      "grid",
      "crowd",
      "drift",
      "result",
      "camera",
      "video wall",
      "people",
      "social proof",
      "clips",
    ],
    component: PopulatePullOutLibraryPreview,
    schema: populatePullOutSchema,
    defaultProps: populatePullOutDefaults,
    durationInFrames: POPULATE_PULL_OUT_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "design-reference/library/postiz: populate-then-pull-out-reveal 22.17-25.43 s (events every 4-6 frames under a linear drift, then 1.2x to 1.0x, fastest in its first 3 frames, settled over 15)",
      "design-reference/library/context-dev: one-becomes-crowd-pull-out 11.07-13.67 s (two-stage pull-out, the second on circ.out) and stepped-push-into-crowd 0.03-2.13 s",
      "design-reference/library/ugc-app: person-wall 2.90-6.90 s (white blurred tiles F133-F141 resolve into clips by about F148, outward from the centre; pull-back from F156 on power2.out 0.5 s then power1.out 1.7 s to about 16 columns, still moving at the cut F207)",
    ],
    importPath: "src/motion/library/camera/PopulatePullOut",
    usage:
      'import { PopulatePullOut, pullOutPose, dropFrames, populatePullOutCues } from "src/motion/library/camera/PopulatePullOut" (VideoWall from ./VideoWall); <PopulatePullOut closeScale={1.2} driftZoom={0.04} driftX={0.08} pullAt={72} pullFrames={15} focusX={0.4} focusY={0.5} variant="single" midScale={1.35} secondAt={96} secondFrames={38}>{board}</PopulatePullOut>. Place items with dropFrames(count, from, 5, 1, pullAt) so they never land together. Wall: <PopulatePullOut variant="wall" closeScale={4} midScale={2.2} pullFrames={15} secondFrames={51} focusX={0.5} focusY={0.5} ...><VideoWall cols={16} rows={5} clips={proxyClips} start={8} /></PopulatePullOut>.',
    cues: (props) => {
      const p = props as {
        events: string[];
        dropFrom: number;
        every: number;
        pullAt: number;
        variant: "single" | "two-stage" | "wall";
        secondAt: number;
      };
      return populatePullOutCues(
        p,
        p.variant === "wall" ? [p.dropFrom] : dropFrames(p.events.length, p.dropFrom, p.every, 1, p.pullAt),
      );
    },
  }),
];
