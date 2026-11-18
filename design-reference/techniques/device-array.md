---
id: device-array
name: Isometric device array
intent: The app on every device: copies of one device lie in an isometric grid, each with its own real screen, and the camera trucks across them.
route: remotion
timing: truck right 0.25 of the frame width and down 0.14 of its height across the shot, sine.inOut
curve: sine.inOut
demo: src/motion/library/three/StudioProductStage.tsx
sources: ["design-reference/library/cashfree/techniques.json"]
status: draft
---

**What it does.** `studio-product-stage` with `layout: "array"`: copies of the phone, laptop or card lie flat in a centred grid (`isoGrid`), each showing the next screen of `array.screens`, seen by a camera at the isometric angle (45 degrees round, 35.26 down) with a narrow lens, trucking across the grid on a sine in-out. Mode of the block `studio-product-stage`.

**When it fits.** The end of a device carousel, after the page on a browser and on a tablet (cashfree); "works on every phone", many users at once.

**When it does not.** One hero device: keep the default turntable or a `blender-plate`. Screens that are not real captures of the product (real-UI rule): pass `capture:app` stills. When glass, metal and contact shadows must convince, render `scripts/blender/device_array.py` (the phone GLB per cell, `screens` cycled, orthographic camera at the same isometric angle and truck) and pass it as the block's `plate` (`pnpm assets:sync --id plates:device-array`).

**Timing.** cashfree device-carousel: hard cuts at 23.43, 25.03 and 25.93 s; the phone array on white with the camera trucking right 0.247 and down 0.142 of the frame, pull-out, gsap sine.inOut (motion.json s021, trackedShare 0.94).

**Read.** `src/motion/library/three/StudioProductStage.tsx` (`DeviceArray`); `isoGrid`, `truckOffset` in `src/motion/library/three/three-plan.ts`; `scripts/blender/device_array.py` (4x4 phones, 60 f at 480x270 and 16 samples in about 110 s, most of it importing 16 GLBs; production 1920x1080 at 64).

**Pitfalls.** Phone GLBs are fetched with `pnpm assets:sync`; without them use `shape: "card"`. Each device loads its own screen texture: keep the grid at 16 or fewer. Glossy phone glass reflects the studio on a white ground and can wash a screen out; a darker `ground` or an `hdri` helps.
