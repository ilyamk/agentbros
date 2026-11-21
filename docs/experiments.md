# Project experiments

Last updated: 2026-11-20

Choose an experimental method for one project while the ordinary playbook runs from the same checkout. Availability is explicit. `pnpm next` names active versions and the affected step includes the method. The film owner's brief receives the same instruction. The regular creative and delivery gates apply to both paths.

## Select and run

```sh
pnpm experiment --action list --project lesson-01
pnpm experiment --action enable --project lesson-01 --id tutorial-camera@1
pnpm next --project lesson-01
```

Create and bind the project before enabling an experiment. Use `--action disable` with the same project and ID to change course before that step starts. A started selection stays pinned in `pipeline/experiments.json`. Use a fresh project with the same inputs to compare against a different approach. Existing projects opt in explicitly.

### Series kit

Enable `tutorial-series-kit@1` on a `content-series` campaign before it prepares its `product-tutorial` film members. With no input it uses the built-in kit. For a series look, pass `--input` with a local JSON file.

```json
{
  "title": {"accent":"#42D9BC","text":"#FFFFFF","ground":"#101A20"},
  "captions":"calm",
  "cursorColour":"#42D9BC",
  "cuePack":"synth-ui"
}
```

Captions accept `calm`, `karaoke` or `keyword`. Cues accept `synth-ui` or `none`. The look, build and sound agents use the kit to agree and apply those settings in the episode's composition and handles voice timing for that episode. The campaign pins the same kit on each tutorial child. The render identity validates and records the child kit. Visual and sound review still verifies how the composition uses it.

### Tutorial camera

On the beat sheet, run `pnpm experiment --action camera --project lesson-01 --input camera.json`. Supply repository-relative paths to the capture manifest and edited word timing JSON. Event and word indices are zero-based. Measure the region in the capture's CSS pixels. When capture and narration start at different times, specify `captureStartSec` and `wordsStartSec` on the same timeline.

```json
{
  "capture":"public/projects/lesson-01/assets/capture/capture.json",
  "words":"public/projects/lesson-01/audio/voice.words.edited.json",
  "actions":[{"event":0,"word":6,"target":{"x":960,"y":480,"width":140,"height":60},"holdSec":1.2}]
}
```

The proposal in `pipeline/tutorial-camera-proposal.json` contains editable `stops` and `portraitStops` for `CameraRead`, with arrival frames at the composition frame rate and a cursor track in source pixels. The default composition rate is 30fps and can be set with `compositionFps`. The report calls out late words, absent framing targets and movements that leave too little reading time. Check the result in the animatic and adjust the shot arrangement as needed.

### Recipe proof scenes

Choose `"experiment":"proof-scenes@1"` in a product or educational recipe request. Preview to see the proof scene options. To use one, add a `proofSource` locator and the registered template to the selected beat. The ordinary beat template is still available for other beats.

```json
{
  "id":"example",
  "proofSource":"materials/repairs.csv, repair-count, rows 1–12",
  "template":{"id":"scene.metric","version":1,"props":{"headline":"Repairs completed","to":12}}
}
```

The persisted recipe records the chosen proofs and sources for review. This produces a draft animatic through the normal materialisation path.

### 3D shot techniques

Enable `three-shot-techniques@1` for product-promo, explainer, motion-design or animated-infographic before the look step. Freeze `brief`, `concept`, `script` and `sources` for comparisons. [Search and render the examples](drei-techniques.md).

## Compare two projects

Use the same clean commit, model, limits and evidence for both projects. Create and bind the projects, enable one experiment on the candidate, then freeze each side before running the affected step. For a proof recipe, freeze after materialisation and before rendering. Keep the JSON and frozen inputs in the ignored project footprint.

```sh
pnpm experiment --action freeze --project lesson-a --input public/projects/lesson-a/compare.json
pnpm experiment --action freeze --project lesson-b --input public/projects/lesson-b/compare.json
```

Each input contains the experiment ID, model, limits, files by role, and render subjects. An example for the camera experiment follows. Use the appropriate project ID on each side, keeping slot names, formats and file contents identical.

```json
{
  "experiment":"tutorial-camera@1",
  "model":"your-exact-model-id",
  "limits":{"maxCostUsd":0,"timeLimitSec":900},
  "inputs":{
    "brief":"public/projects/fixtures/brief.md",
    "script":"public/projects/fixtures/script.md",
    "capture":"public/projects/fixtures/capture.json",
    "narration":"public/projects/fixtures/narration.wav",
    "words":"public/projects/fixtures/narration.words.json"
  },
  "subjects":[{"slot":"lesson","project":"lesson-a","format":"landscape"}]
}
```

For the series kit use roles `brief`, `episodes`, `materials` and `style-change`, with one subject per episode and format. For proof scenes use `brief`, `concept`, `script` and `sources`. Pin actual material and claims files using additional roles. The recorded model and limits are the operator's declarations. Keep harness run evidence when measuring those independently. A bespoke project has one full renderer output, so use separate project pairs for its other formats.

Render both sides through their normal route. If a subject uses custom render options, declare its `audioMaster` or `fontContext` on that subject. Record the required manual corrections on each, citing the subject slot, frame and description, then prepare the pair.

```sh
pnpm experiment --action outcome --project lesson-a --input public/projects/lesson-a/corrections.json
pnpm experiment --action outcome --project lesson-b --input public/projects/lesson-b/corrections.json
pnpm experiment --action compare --baseline lesson-a --candidate lesson-b
```

Each corrections file contains `manualCorrections` and a corresponding `corrections` array of `{slot,frame,description}` objects. Compare checks the frozen pins, selection and complete renderer receipts. Give each reviewer only the `review/` directory, which has the full videos in shuffled order and a ratings form. Keep `private.json` with the mapping, technical evidence and correction counts. Ask reviewers to evaluate accuracy, readability, pace and fit to the brief. Use a human listener for sound.

## Promote a version

Keep an experiment opt-in while collecting evidence. Use two development briefs and three unseen briefs with three independent runs per mode on each unseen brief. The initial targets are 30 per cent fewer required manual fixes after a series style change, and 20 per cent fewer fixes in the camera or proof-scene stage. Compare median correction counts. An unseen brief with zero baseline corrections provides parity evidence only.

To change a version to `stable`, record the target gain on at least two unseen briefs, editorial parity on all three, and zero critical failures. Assess both landscape and portrait where supported. Check a combined tutorial before routinely using the camera and kit together. Keep the same ID for a status change. Give changed experiment behaviour a new version. A stable method remains an explicit choice until the playbook adopts it as a default.
