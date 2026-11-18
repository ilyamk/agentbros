# Measure and critic

What the critic and `film:measure` see in the [production chain](../production-chain.md): read at measure and critic.

## The critic sees motion

`critic:pack` writes transition strips with a frame-difference map under each tile, `clips/cut-*.mp4` (1.6 s around each of the first 12 cuts) and the frame-difference curve. With a reference from the library, `side-by-side.jpg` pairs our film and the reference on matching downbeats (the i-th of each; matching times when either has none) and the reference's `pilot-spec.md` joins the reading order. `sound.json` holds the mixed master's loudness and duck depth (from `mix-report.json`), the film's sync v2 and the reference's own sync metrics.

## Sync metric v2

`film:targets` records the reference's `cutsOnBeatLift`, `cutsOnDownbeatFrameRatio` and `cutsOnDownbeatFrameLift` (downbeats within one frame) and `signedMedianCutToBeatSec`, with `syncMetric: 2`. A lift is ratio / chance: 1 is what random cuts score. `film:measure`'s `cuts-on-audio` leg asks for half the reference's lift above chance on beats or downbeats where the reference reaches 1.5, and otherwise passes: professional films mostly do not cut on the beat (corpus median lift 1.0, [calibration](../../design-reference/calibration.md)), so beat sync gates only when the chosen targets cut on their grid. `cut-to-beat-offset` is read only when the targets or the film cut on the beat (lift 1.5 or more), and warns when cuts trail it. Targets without `syncMetric` are read the old way (additive lift over chance on all audio anchors), as is any track whose grid trust is `none`. The critique's `actions` are ranked, at most 7, each naming a frame range, the file, component or library block and the change; the fixer does the top items only.
