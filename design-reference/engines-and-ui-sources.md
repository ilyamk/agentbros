# Animation engines and UI sources

Research for the question "our films look like cheap AE templates: should we use GSAP or Motion, and pull UI from 21st.dev, shadcn and similar?" Sources were fetched on 2026-11-11. Where a licence or a fact is quoted, the URL is inline. "Unverified" means no primary source was read.

## Headline

**Remotion now ships an official GSAP integration.** [`@remotion/gsap`](https://www.remotion.dev/docs/gsap) (MIT, since v4.0.517) provides [`useGsapTimeline()`](https://www.remotion.dev/docs/gsap/use-gsap-timeline), which "builds a paused GSAP timeline and seeks it to the current frame, so previews, scrubbing and renders are deterministic". `npm view @remotion/gsap@4.0.539` resolves, so it matches the repo's pinned Remotion `4.0.539`. As a result, `AGENTS.md:110` ("today this means the HTML capture route") and `.agents/skills/engine-selection/SKILL.md` are out of date.

The cheap-template look will not go away because of the engine. GSAP and Motion add better primitives: text splitting, morphing, path drawing and layout. Taste still comes from the library blocks, the craft rules and real proof.

## Current state in the repo (verified)

- `src/lib/verification/lint.ts:8` bans `^(?:gsap|framer-motion|motion(?:\/|$)|animejs|anime\.js|@react-spring/|react-spring)` in render code (`src/components`, `src/templates`, `src/motion`). Lines 59–83 ban Tailwind `animate-*`, CSS `animation`/`transition` keys, `<style>` blocks with `@keyframes`, `requestAnimationFrame`, `setTimeout`/`setInterval` and R3F `useFrame`.
- Because the regex is anchored at the start, `@remotion/gsap` already passes. Bare `gsap` and `gsap/SplitText` (needed to register plugins) are still banned.
- `gsap` is not installed. `@remotion/lottie` and `@remotion/three` are installed; `@remotion/rive` is not.
- `AGENTS.md:108` lists anime.js and framer-motion as forbidden. `AGENTS.md:110` says GSAP is allowed "only as a paused timeline seeked to `frame / fps`".
- HTML capture (`docs/html-capture.md`, `pnpm capture:html`) has three protocols: `avc-frame`, `hyperframes-seek` and `hyperframes-frame-adapter`. `vendor/hyperframes/gsap.ts` is HeyGen's Apache-2.0 adapter, which runs `timeline.pause(); timeline.seek(frame / fps)`.
  - It creates a fresh document for each frame, uses a seeded random and frozen clocks, and blocks the network.
  - It is limited to **100 frames per batch**, 120 s wall time and 1920 px. The docs call it "an asset capture bridge, not an unbounded full-video renderer". It is production-usable for short inserts only.
- `pnpm hyperframes:render` runs the external Hyperframes 0.9.7 CLI. The skill reports byte-identical repeat renders, but only two of 456 catalogue items were tested.
- `public/motion-lab/showcase/PROVENANCE.md` kept `commercialAllowed: unknown` because of the GSAP licence; the owner settled that question on 2026-11-16 (section 1).
- `src/motion/showcase/capture/capture-order.ts` already records a page frame by frame over CDP. It calls `window.__seek(frame)`, sends real mouse events and then `Page.captureScreenshot` at 2x. This is the right pattern for UI we author, but it needs the page to expose `__seek`.
- The library has 46 blocks (`pnpm library:list`), five of them `ui` (dashboard, phone, chat, cursor, toasts). All of them use frame-driven code.

## 1. GSAP

**Licence.** GSAP is under the Webflow "Standard 'no charge' GSAP License" (https://gsap.com/standard-license; the npm `license` field points there). It is not an open-source licence. Quoted live terms:
- Permitted Uses: "implementation and/or use of GSAP Products on any website, web application, or digital interface by any person or entity (which may include … companies that compete with Webflow in other areas of business)".
- Prohibited Uses: "any implementation and/or use of GSAP Products in tools that allow users to build visual animations without code that encourages, induces, or materially assists in creating a solution that competes with Webflow's visual animation building capabilities".
- Restrictions: no Prohibited Uses "without prior written consent"; no reverse engineering "for the purpose of creating Competitive Products"; Webflow "may terminate … in its discretion".
- The page still contains an older "Plain English Summary", which says end users must not be charged a fee. That summary is inside HTML comments and is **not** part of the current terms, so don't rely on it.

**Plugins.** https://gsap.com/pricing/ says "GSAP is now 100% free for all users … we're able to offer the entire GSAP library for free". It lists SplitText, MorphSVG, DrawSVG, ScrollTrigger, Flip, MotionPath, CustomBounce/Wiggle and Physics2D. All of them are on npm `gsap` 3.15.1.

**Owner decision (2026-11-16).** GSAP, plugins included, is used under Webflow's Standard "No Charge" licence, free including commercial use. This repository is not a "tool that allows users to build visual animations without code": agents write frame-driven GSAP code for films, which is a Permitted Use. The restriction stays a condition for everyone downstream: a product where users prompt or click animations into existence, competing with Webflow's visual animation building, needs Webflow's written consent first ([NOTICE.md](../NOTICE.md), [dependency review](../docs/dependency-licence-review.md)).

**Determinism.** A paused timeline seeked to `frame / fps` is a pure function of time when every tween is. The `useGsapTimeline` docs list where that breaks, and the hook throws on these cases:
- `play()`/`seek()`/`progress()`/`tweenTo()` calls
- callbacks (`onUpdate`, `call()`, `then()`)
- async builders
- **plain-object targets**, which "freeze in stills and renders"
- `"random(...)"`, `stagger: {from: 'random'}`, `repeatRefresh`
- stray tweens outside the timeline

Remotion documents this behaviour; **this repo has not tested it.** Plugins that measure layout, such as SplitText and Flip, depend on fonts having loaded before the build. Fonts must therefore resolve before mount (`delayRender`). ScrollTrigger has no meaning in video.

**Integration options.** In order of preference:
1. Inside Remotion via `@remotion/gsap`. It stays on the same timeline as captions and audio, and it is editable.
2. HTML capture or Hyperframes for self-contained shader inserts.

The `useGsapTimeline` pattern is official, not community. A Hyperframes adapter also exists (vendored).

**What would make GSAP first-class:** see the plan, steps 1–3.

## 2. Motion (motion.dev, formerly framer-motion)

- **Licence.** The core library is MIT (https://github.com/motiondivision/motion/blob/main/LICENSE.md, "Copyright (c) 2024 Motion B.V.").
- **External time.** `animate()` returns controls with a settable `time`. https://motion.dev/docs/animate says "time — Gets and sets the current time of the animation … `animation.time = 0.5`", and also documents `pause()`, `speed` and timeline sequences. `MotionGlobalConfig.useManualTiming` exists in the `motion-dom` source but is not documented as a public seek API.
- **Remotion support.** https://www.remotion.dev/docs/third-party says "we don't have a Framer Motion integration".
- **Hard parts:**
  - `<motion.div>` layout animations and `AnimatePresence` measure the DOM across React renders. They are stateful, so a frame visited out of order (as in parallel rendering) gives a different result.
  - `useTime` counts wall-clock milliseconds "since it was first created" (https://motion.dev/docs/react-use-time).
  - Some properties run through WAAPI.
  - Conclusion: animations can be driven from a frame-derived time, but layout animations have no deterministic route. Port them to explicit rects, as `SharedCarry` already does.
- **Motion+.** Paid, one-time per developer, yearly for teams (https://motion.dev/plus). The FAQ says "Motion+ APIs and examples are licensed under MIT … If your product effectively resells Motion+ capabilities to your users, you'll need a Builder's Licence".
  - The terms (https://motion.dev/terms §1.2, §4.2) grant a "perpetual, non-exclusive license … in your personal and commercial projects" but forbid redistributing "the Motion+ source code or premium APIs as a standalone library or competing product".
  - **Porting examples:** this is fine inside a single film. Porting them into our published motion library or public export risks the §4.2 ban and the Builder's Licence clause. Ask Motion before doing that.
  - The free docs examples are reference material. Use their curves and choreography, not their code.

## 3. Other engines

| Engine | Determinism | Remotion fit | Licence (primary source) | Quality ceiling / note |
|---|---|---|---|---|
| **Lottie / dotLottie** | `goToAndStop()` per frame; "depending on the expression, the frame might not render deterministically" (https://www.remotion.dev/docs/lottie) | `@remotion/lottie` installed | Runtime `lottie-web` MIT (unverified here). Free LottieFiles animations are under the [Lottie Simple License](https://lottiefiles.com/page/license): "download, reproduce, modify, publish, distribute … without attributing", but no right "to collect or compile Files from LottieFiles to replicate or develop a similar or competing service" | High when an animator authors in AE. The free catalogue mostly looks like icons and stock (the "template" look). Use it for commissioned or brand Lotties, not as a catalogue |
| **Rive** | State machines advanced by explicit time; `@remotion/rive` `<RemotionRiveCanvas>` (https://www.remotion.dev/docs/rive) | Good, needs `@remotion/rive@4.0.539` | Runtimes MIT (https://github.com/rive-app/rive-runtime). "Free exports play a Rive splash screen. Upgrade to remove it" (https://rive.app/pricing; Cadet $9/seat/mo) | Very high for interactive-looking UI and character rigs; an author is needed |
| **anime.js v4** | `seek()` on timelines; the engine exposes `update()`/`pause()` (https://animejs.com/documentation/engine). Remotion links an example repo (third-party page) | Possible, but banned by lint today; not tested | MIT (https://github.com/juliangarnier/anime/blob/master/LICENSE.md), v4.5.0 | Similar to GSAP with fewer plugins. Not worth a second imperative engine if GSAP lands |
| **Theatre.js** | `sequence.position` is settable (https://www.theatrejs.com/docs/latest/manual/sequences); seekable | Would need a custom bridge | `@theatre/core` Apache-2.0; `theatre/studio` **AGPL-3.0** (repo LICENSE) | **Dormant**: npm last published May 2024 (0.7.2), repo last pushed 2024-08-14. Do not adopt |
| **Remotion Elements / templates** | Native | Native: Studio copies the source into the project (https://www.remotion.dev/docs/elements) | Remotion licence; the Company License is required above 3 employees (https://www.remotion.dev/docs/license/pricing) | Captions, maps, charts, lower thirds. Paid templates are Editor Starter, Watercolor Map and `<Timeline />` (https://www.remotion.dev/templates). A good source of video-scaled blocks |
| **three.js / Blender / Hyperframes** | Already covered by `engine-selection` | — | — | Keep as is |

## 4. UI component sources

Animation dependency evidence comes from each repo's `package.json` (GitHub API, 2026-11-11). "Port" means its animation must be rewritten to frame time; "static" means the markup and styles can be used directly.

| Source | Licence | Animation | Best agent route |
|---|---|---|---|
| **shadcn/ui** | MIT (repo) | Mostly static; uses `tw-animate-css` (`animate-in` classes, banned by our lint) and `motion` in the docs app | `pnpm dlx shadcn@latest mcp init --client claude` (https://ui.shadcn.com/docs/mcp) or `npx shadcn add @registry/item` (https://ui.shadcn.com/docs/directory). Registries are namespaced in `components.json` (https://ui.shadcn.com/docs/registry/namespace) |
| **21st.dev** | Per component author; site terms add restrictions | Mixed (many Motion/GSAP) | The official **21st MCP** replaced Magic MCP: HTTP server `https://21st.dev/api/mcp` with an API key, or `npx @21st-dev/cli@latest init --client claude` (https://github.com/21st-dev/magic-mcp, ISC). Free accounts copy "2 components a day"; Builder is $6/mo yearly (https://21st.dev/pricing). The terms (https://21st.dev/terms) prohibit "scraping or automatically collecting data … without explicit written consent", training AI on the content, and reusing their demo media or metadata, and require "a clear and visible link back" when redistributing. **Use only the MCP or CLI, never a scraper**, and record each component's own licence |
| **Magic UI** (free) | MIT (repo) | `motion`, `tw-animate-css`, `cobe` in the docs app: port | shadcn registry (`@magicui/...`, unverified namespace name) |
| **Magic UI Pro** | "Commercial Use … Re-selling of code is NOT allowed" (https://pro.magicui.design/), $199 one-off | Motion: port | Manual |
| **Aceternity UI** | Pro: [Aceternity licence](https://ui.aceternity.com/licence) allows unlimited end products, explicitly including "Videos", but forbids re-distributing source and "Template Creation … to sell on any marketplace". The licence for the free tier is **unverified** | "Built with … Framer Motion" (https://pro.aceternity.com/pricing): port | MCP access is listed for free and paid plans (same page) |
| **React Bits** | **MIT + Commons Clause** (https://github.com/DavidHDev/react-bits/blob/main/LICENSE.md): you may not "sell, sublicense, or redistribute the components themselves … or as a ported version" | `gsap`, `motion`, `three`, `ogl`: port | Fine inside one film; **not** into our public library or export |
| **Origin UI** | Repo MIT (https://github.com/origin-space/originui), but its homepage now redirects to coss.com, whose repo `cosscom/coss` is **AGPL-3.0** | Unverified | Pull from the MIT origin-space repo at a pinned commit, not from coss |
| **Motion Primitives** | MIT (repo) | `motion`, `tailwindcss-animate`: port | shadcn registry (unverified) |
| **Cult UI** | MIT (repo) | `motion`, `tailwindcss-animate`, `three`: port | shadcn registry (unverified) |

Most "animated" web components are hover-, scroll- or mount-triggered and sized for a page. Their value to us is the **look** (layout, materials, typography); their motion has to be re-timed anyway. Remotion's own advice for Elements says AI-built components "often design it like a website component … video usually needs larger, simpler graphics" (https://www.remotion.dev/docs/elements).

## 5. Real product UI

| Route | Truth | Determinism | Edit later | Use for |
|---|---|---|---|---|
| Recreate in React (library `ui` blocks) | Low: an impression of the product | Full | Full | Concept beats, unreleased features, stylised proof |
| Record the real app in real time (aiscreen MCP, Playwright `recordVideo`) | High | None. Playwright video "defaults to the viewport size scaled down to fit 800x800" (https://playwright.dev/docs/videos), on the wall clock | Re-record | Proof beats, demos with real data |
| Scripted per-frame capture (CDP) | High | Only if the page's own animations are frozen. Our pages expose `__seek`; for a third-party app, use CDP `Emulation.setVirtualTimePolicy` ("replacing real-time with a synthetic time source") or `HeadlessExperimental.beginFrame` (headless only, experimental), both from devtools-protocol 0.0.1740066. **Untested here** | Re-run the script | Hero UI shots of the real product |
| Screenshots / Figma frames animated in Remotion | High for stills | Full | Swap the image | Most launch-film UI: device pushes, crops, highlights over real pixels |

**What pro launch films do: judgement, no source.** From watching them, they mostly use real screen pixels (screenshots or recordings, often re-captured at high DPI). These are composited and animated in a motion tool with camera moves, crops, highlights and redrawn hero elements. Fully recreated UI appears for concept moments. To verify, run the `reference-analysis` skill on two launch films the user admires.

## 6. Recommendation

**Engine per shot:**

| Shot | Engine |
|---|---|
| Typography, data, captions, anything that follows the VO | Remotion library blocks |
| Choreographed text splitting, SVG morph or path draw, complex staggers | GSAP inside Remotion via `@remotion/gsap` (licence cleared 2026-11-16, section 1) |
| Product UI proof | Real screenshots or scripted CDP capture, animated by library `ui`/camera blocks |
| Live-feeling product demo | aiscreen recording, imported as footage |
| Authored character or icon animation | Rive (paid seat, no splash) or commissioned Lottie |
| Shader transitions | Hyperframes route, unchanged |
| 3D | three.js / Blender, unchanged |

Motion stays a **reference**, not a runtime: port its curves and layout ideas to `interpolate`/`spring`/`SharedCarry`.

**Plan:**

1. **Owner decision on GSAP terms** (S). Decide whether this repo, or the product it feeds, is a "tool that allows users to build visual animations without code". If it is not, record the decision in `PROVENANCE.md` and the sidecars. If it is, stop and ask Webflow for written consent.
2. **Add GSAP inside Remotion** (M):
   - `pnpm add -E @remotion/gsap@4.0.539 gsap@3.15.1`.
   - Create one wrapper module, `src/motion/gsap.ts`, that registers SplitText, MorphSVGPlugin, DrawSVGPlugin and CustomEase once, and re-exports `useGsapTimeline`.
   - In `lint.ts`, allow bare `gsap`/`gsap/*` imports **only** in that file. Keep banning `ScrollTrigger`, `ScrollSmoother`, `Observer`, `Draggable` and `Inertia` everywhere.
3. **Prove determinism** (S): one test composition using SplitText, MorphSVG and stagger. Render it twice, with `--concurrency` 1 and 8, and also render stills of frames in random order. Compare frame hashes in the style of `tests/html-capture.test.ts`. Add one library block that uses GSAP only after this passes.
4. **Update the docs** (S): `AGENTS.md:108-110`, `engine-selection/SKILL.md` and `src/motion/AGENTS.md`. Keep HTML capture for shaders and third-party HTML only.
5. **UI sources route** (S–M):
   - Add the shadcn MCP and the 21st MCP to the agent environment, not to the repo.
   - Install components into a scratch area, then port them into `src/motion/library/ui/` with re-timed motion.
   - Record source URL, commit and licence in each block's provenance.
   - Deny-list for the public export: React Bits, Motion+, Magic UI Pro, Aceternity Pro, and anything from the 21st marketplace without an explicit OSS licence.
6. **Real UI capture** (M): turn `capture-order.ts` into a generic `pnpm capture:app` with scripted steps and a virtual-time option. Test whether CSS transitions in a third-party app become repeatable. If they do not, use aiscreen recordings for those apps.
7. **Rive** (S, optional): add `@remotion/rive@4.0.539` only when an authored `.riv` exists. Require a paid export so the splash screen is not shown.

**Risks:**
- GSAP terms can change. The licence lets you keep earlier versions only "under the applicable terms licensed to you prior". Pin the version.
- Layout plugins (SplitText, Flip) re-measure when fonts swap.
- `useGsapTimeline` blocks plain-object tweens, so numbers still come from `interpolate`.
- Third-party component licences differ per item.
- 21st's terms forbid automated collection outside its MCP and CLI.
- Virtual-time capture of real apps is unproven.
