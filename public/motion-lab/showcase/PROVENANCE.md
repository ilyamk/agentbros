# Showcase clips

Illustrative footage for composition `Showcase`. The brand, prices and dates are invented.

| File | Tool | Source |
|------|------|--------|
| `coffee-pour.mp4` | Blender 5.2.3 LTS Cycles with rigid-body simulation, task CREATIVE-B1 | Byte copy of `out/qa/creative-b1/final/render.mp4` in the main checkout; record in `blender-run.json` beside it |
| `roast-shader.mp4` | Hyperframes 0.9.7, `@hyperframes/shader-transitions` `domain-warp`, Apache-2.0 from the repository root at commit `8c799ebd` | Composition is `src/motion/showcase/capture/roast-shader.html`; its two images are stills of `ShowcaseRoastGreen` and `ShowcaseRoastDark`. Rendered with `--no-strict` because the linter misreads the vendored bundle. Sidecar: `roast-shader.mp4.provenance.json` |
| `order-capture.mp4` | Remotion's Chrome Headless Shell over the DevTools protocol, 2x, then ffmpeg x264 | `src/motion/showcase/capture/capture-order.ts` recording `order-page.html` with real mouse events. Font: Golos Text from Google Fonts (OFL) |

GSAP licence: the vendored GSAP is under Webflow's Standard "No Charge" licence, which the owner cleared for this project's use on 2026-11-16 ([NOTICE.md](../../../NOTICE.md)). The sidecar still records `commercialAllowed: unknown` for `roast-shader.mp4` until its rights record is redone. The shader bundle embeds html2canvas 1.4.1 (MIT).
