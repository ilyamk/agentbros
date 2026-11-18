# Insert into footage

Use the recording workflow for the user's footage; Vork makes a derivative insert, not a replacement for ingest, editing approval or sound. The original plate stays immutable.

RU: «Закрепи светящийся объект на столе в этом пятисекундном плане. Используй предоставленную камеру или явно размеченную плоскость; сохрани руку перед объектом и покажи контрольные треки».

EN: “Anchor a luminous object on the desk in this five-second shot, using the supplied camera or explicitly calibrated plane; preserve the foreground hand and show held-out track overlays.”

`vork:vfx` uses a strict request: plate, width/height, native FPS/duration and either a camera or calibration (focal length in pixels, plane size in metres, four initial image corners). Optional matte/depth/proxy inputs keep their provenance. `prepare` records PTS; `solve` estimates only the rigid plane and retains held-out residuals; `build` makes the authored insert; `review` records what still needs inspection.

The local matte command can supply holdouts. Depth is an estimate/reference until the author builds an explicit proxy; it is not a scanned room. General motion, rolling shutter, distortion and hidden geometry are not solved by the planar route. A low reprojection error does not certify contact, occlusion or reflected light. Inspect the full clip, track overlays, mask boundaries and slow motion before accepting the shot.

Native camera.json accepts flat or nested OpenCV K/R matrices, square pixels, zero distortion and a zero-origin matching clock. Fractional FPS is retained. An optional initial pose defines ray-plane intersections when the four marks are not rectangle corners.

The qualified M1 Max lost its Metal device with native shadow-catcher transport, including a serial tiny render. Keep failures. Explicit `shadowMode: contact` instead authors a projected contact approximation; it supplies no physical reflection. `none` makes no shadow. Neither is an automatic substitute for the default `shadow-catcher`; use Blender when physical contact is essential. Review local masks and contact in `pnpm vision:pack --input <render.mp4> --output <fresh-review> --profile motion`, then inspect the hash-bound pages before judging.

For physical shadows/reflections, explicitly choose `renderBackend: blender-cycles` with shadow-catcher mode. Build returns the hybrid job and renderer command; run it with `vork:vfx --action render`. The supported static Vork mesh crosses through strict GLB; Cycles multiplies the physical catcher pass into the linear plate before foreground protection. Retain hybrid receipt v2, geometry receipt, multilayer EXR and hero masks. No automatic renderer fallback. See [the physical route](../../../../docs/vork.md#explicit-physical-cycles-route).
