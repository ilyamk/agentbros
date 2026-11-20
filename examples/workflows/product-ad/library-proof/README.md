# Motion library filter demo

The Studio Console fixture contains twelve blocks. Selecting the transitions category leaves two. The capture script records the real search results and the filter bounds at two browser sizes. It writes the screenshots under `public/projects/library-proof/captures/` and the matching Remotion props to `out/qa/proof/props.json`.

Run from the repository root with Playwright Chromium installed. To use an existing Chromium installation, set `CHROME_PATH` to its executable.

```sh
pnpm console:build
node examples/workflows/product-ad/library-proof/capture.mjs
pnpm exec tsx examples/workflows/product-ad/library-proof/score.ts
pnpm motion:render --entry src/motion/library/scenes/preview.tsx --composition Lib-scene-feature-demo-L --props out/qa/proof/props.json --output out/qa/proof/feature-landscape.mp4
pnpm motion:render --entry src/motion/library/scenes/preview.tsx --composition Lib-scene-feature-demo-V --props out/qa/proof/props.json --output out/qa/proof/feature-portrait.mp4
pnpm motion:render --entry src/motion/library/scenes/preview.tsx --composition Lib-library-reel-L --props out/qa/proof/props.json --output out/qa/proof/reel.mp4
pnpm motion:render --entry src/motion/library/scenes/preview.tsx --composition Lib-library-reel-V --props out/qa/proof/props.json --output out/qa/proof/reel-portrait.mp4
```

For a different product, supply two stills of the same view before and after an interaction. Each plate uses the capture's logical width and height, normalised target and result centres and optional control dimensions in capture pixels. A supplied portrait plate has its own framing. The shared control crops the selected state directly from the after image. The final camera stop uses `resultZoom`. Optional `resultNames` supply the reel's payoff. Timing assumes 30 fps.

The transition performance runs for 324 frames. The two result IDs select the authored edition. A sectioned metal ring introduces the cut, changes ground and opens into the closing mark. The score script synthesises the picture cues locally. Omit `capture.performance.score` for a silent cut, or omit `capture.performance` for the general product reel.
