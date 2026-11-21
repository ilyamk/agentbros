# Templates, recipes and local animatics

`video:recipe` lists the maintained registry, seven narrative recipes and opt-in style profiles. Registry entries include ID/version, reusable component, purpose/tags, formats, motion constraints, timing, sync/audio slots, safe-zone/caption rules, source/licence status and validated sample props. Selection by tags returns its rationale; artistic suitability still needs review.

```bash
pnpm video:recipe --action list
pnpm video:recipe --action preview --input /absolute/path/recipe.json
pnpm video:recipe --action materialize --input /absolute/path/recipe.json --dry-run
pnpm video:recipe --action materialize --input /absolute/path/recipe.json
pnpm render --project gravity-draft
```

Example request:

```json
{
  "schemaVersion":1,"projectId":"gravity-draft","recipeId":"educational-explainer",
  "topic":"Почему предметы падают?","formats":["vertical","square","landscape"],
  "styleProfile":"educational-editorial","durationSec":180,
  "beats":[
    {"id":"question","headline":"Почему предметы падают?","text":"Начнём с простого наблюдения."},
    {"id":"definition","headline":"Причина, а не ярлык","template":{"id":"scene.definition","version":1,"props":{"lines":["Наблюдение","Причина","Проверка"]}}}
  ],
  "media":[]
}
```

Beat IDs come from the chosen recipe. Materialization creates a new project only, refusing even an existing empty directory. `project.json` is the final commit marker. The draft includes `pipeline/recipe.json`, a local `animatic.html` and clearly labeled visual placeholders where media is absent. It does not generate/approve audio, factual claims or paid assets, and remains `productionReady:false` until normal production stages and QA are complete.

To reuse existing stock/imported/entity media, supply `media: [{"source":"projects/source-project/assets/imported/HASH.png","kind":"image"}]`. Read an approved entity's exact role path/version and retain its binding metadata; root render planning supports explicit entity bindings separately. Recipes never silently choose a new canonical character version.

Choose an optional [film style card](film-styles.md) with `styleCard`. For counted material use the `scene.physical-data` template on the beat that needs it.

## Registry previews

```bash
pnpm video:recipe --action template-preview --template scene.device-proof --project device-template-preview
pnpm render --project device-template-preview --format square
```

Six registered scenes: hook, definition, metric, image proof, device proof and chart proof. Existing word/line/scale/clip/count primitives are registered first. Source data must be supplied for charts/counts; preview values are explicitly illustrative.

A canonical scene selects `template: {"id":"text.word-reveal","version":1,"props":{"text":"One clear idea"}}`. Image templates accept an image reference. Caption templates overlay their scene's visual and consume ordered source timestamps: karaoke, calm phrase or deliberate keyword emphasis. Caption groups in this foundation are bounded by maxWords; authored linguistic grouping/localization remain editorial decisions. Templates run entirely from Remotion frame state. Registered fades are currently 12 frames and scale starts at 0.85. Text translation and GSAP are outside the current registry, which is its scope rather than a project-wide ban: write a custom frame-driven component using the [motion grammar](../.agents/skills/motion-and-typography/references/motion-grammar.md) when the idea needs more. CSS clocks stay forbidden everywhere.

All registered scenes/primitives use shared design tokens for their wrapper hierarchy and safe zones; registered legacy chart/device internals retain their existing styling. Long-form recipes change story structure and duration instead of forcing the advertising arc. Local animatic duration equals scene sum minus actual overlaps.

## Verification

```bash
pnpm test -- tests/templates-recipes.test.ts
RUN_RENDER_TESTS=1 pnpm exec tsx --test tests/templates-render-browser.test.ts
```

The browser test renders six scenes and three caption profiles in all formats, including a long Russian headline and deterministic seek comparison. It uses the test-only local font substitute to avoid Google Fonts requests; final production font/visual QA remains distinct. Default unit tests cover schema/motion restrictions, exact caption boundaries, recipe timing and no-write dry-run/materialization behavior.

Craft guidance: `.agents/skills/motion-and-typography`, `captions-and-localization` and `video-recipes` contain decision examples and review criteria instead of duplicated API/model price tables.
