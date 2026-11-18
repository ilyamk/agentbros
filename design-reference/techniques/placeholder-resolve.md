---
id: placeholder-resolve
name: Placeholders resolve into content
intent: The screen reads as being generated: each region waits as a placeholder and becomes its real content in turn.
route: remotion
timing: "ace: about 0.2 s a region, staggered about 0.2 s, linear; nexaa: grows from a point in 0.5 s (power2.inOut), text dissolves 0.25 s; ugc-app: white blurred tiles resolve in about 8 f, outward from the centre"
curve: linear dissolve; power2.inOut growth
primitive: stagger, radialOrder, progress
demo: src/motion/library/ui/PlaceholderResolve.tsx
sources: ["design-reference/library/ace/techniques.json", "design-reference/library/nexaa/techniques.json", "design-reference/library/ugc-app/techniques.json", "src/motion/library/ui/PlaceholderResolve.tsx"]
status: draft
---

**What it does.** Regions of a screen (or tiles of a wall) appear as placeholders, a soft two-colour gradient, a skeleton whose bands scroll and that can grow from a point to its rect, or a soft white blurred block, and each resolves into its real content on a stagger: by index, in reading order, or outward from the centre ring by ring. Library block: `placeholder-resolve`; `resolvePlan`, `PlaceholderTile` and `PlaceholderRegions` wrap any image or clip.

**When it fits.** Beats where the product makes the thing for the viewer; an answer or a page filling in; a wall of clips arriving from the middle.

**When it does not.** When the content itself is the surprise and the placeholder would only delay it; when there is no real content to resolve into (a placeholder resolving into another placeholder reads as a mock-up).

**Timing.** ace (t12): after a 7-frame dissolve the cells resolve one at a time, each over about 0.2 s and about 0.2 s apart, close to linear (lower left, then upper right, then upper left). nexaa: the shimmer grows from a dot at the reply line's start to the answer's size in 12 frames (power2.inOut), its bands slide sideways, then the text dissolves in over 6 frames (24 fps: 15 and 8 frames at 30 fps). ugc-app: neighbouring tiles appear as soft white blocks and resolve into their clips in about 8 frames, outward from the centre.

**Read.** `src/motion/library/ui/PlaceholderResolve.tsx` (API in the header), `src/motion/library/ui/ui-plan.ts` (`resolvePlan`, `resolveState`, `growRectFrom`).

**Pitfalls.** The content must be the real product: crops of a capture (`capture:app`), never a drawn stand-in; the block's neutral cards are placeholders on purpose. A white tile's blur reads as fog if it lasts longer than about 10 frames. Keep the stagger order meaningful (reading order for a page, radial for a wall).
