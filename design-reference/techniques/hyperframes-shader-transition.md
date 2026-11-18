---
id: hyperframes-shader-transition
name: Hyperframes shader transition
intent: A look that would cost more to build than the clip is worth comes from a named shader.
route: hyperframes
timing: Render about 1.8 s per video second; 3 s clip took 7 to 18 s on a loaded M1 Max
primitive: scripts/hyperframes-render.ts
sources: [".agents/skills/engine-selection/SKILL.md"]
status: draft
---

**What it does.** Renders a shader transition through the external Hyperframes tool and imports it as a clip.

**When it fits.** A shader transition or ready-made effect, where the look matters more than the parameters.

**When it does not.** Anything that follows props, captions or later script changes: an imported clip must be rendered again.

**Timing.** Times come from the trial in the skill. No Motion Lab piece demonstrates this technique, so the card stays `draft` until one does.

**Read.** `.agents/skills/engine-selection/SKILL.md`, section "Hyperframes route"

**Pitfalls.** `domain-warp-dissolve` is a 1920x1080 catalogue card; for portrait, call `@hyperframes/shader-transitions` from your own scenes. Vendor GSAP, the shader bundle and fonts, or renders fail with the network denied. GSAP's licence is an open decision: read the skill's Licence section before use.
