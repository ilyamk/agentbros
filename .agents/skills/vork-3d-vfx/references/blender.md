# Blender hand-offs

Use the existing Blender craft kit for staging, motion, light and real product models. Save a copy from a live session, then `pnpm vork:bridge --action from-blender --input <scene.blend> --output <fresh-dir>`. This invokes the qualified GPL bridge through `blender:run`, with automatic script execution disabled and an isolated profile. Original files are not overwritten.

RU: «Возьми утверждённую Blender-сцену. Сохрани камеру, экран и силуэт, добавь в Vork процедурное раскрытие поверхности. Покажи отчёт переноса и сравнение с исходным рендером».

EN: “Use the approved Blender scene, preserving camera, screen and silhouette; add an authored Vork surface reveal and show the export report beside the source render.”

Inspect `export-report.json`, including omissions. Supported Principled graphs translate to OpenPBR, so highlights can differ. Unsupported material/world/display features fail; do not replace them silently. A strict refusal means revise the exported material knowingly or keep rendering that shot in Blender.

`pnpm vork:bridge --action to-blender --input <scene.json> --output <fresh-dir>` returns the supported native geometry subset. `--action composite` accepts a JSON request with `blend`, `image`, optional `frames` and `start`; it adds an alpha-over before the existing composite output in a new `.blend`. EXR stays linear; PNG uses its declared display transform. Never apply AgX twice.

Vork Y-up and Blender Z-up are converted by the bridge/glTF importer. Do not rotate twice. Check framing in every delivery aspect ratio, source FPS, the frame-1/frame-0 boundary and optical settings.
