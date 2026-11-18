# Programme the effect

Prompt structure: function → notice → source → geometry/material → action → camera/light → effect → numerical budget → acceptance. Match scene units (metres, seconds, radians, linear Rec.709), Y-up, local camera -Z and zero-based output frames. The seed and source dependency pins belong to the shot, not a transient terminal session.

Examples:

- RU: «Собери ребристый сосуд по профилю. Сохрани толщину стенки и масштаб в метрах; подготовь GLB для Blender и покажи три ракурса без потери силуэта».
- EN: “Build a ribbed vessel from a radial profile; preserve wall thickness and metre scale, export a supported GLB and prove the silhouette from three views.”
- RU: «Раскрой материал светящейся сеткой за четыре секунды. Сохрани исходную геометрию, выбранный ракурс и финальную паузу; проверь блики и движение границы».
- EN: “Reveal a luminous surface over four seconds, preserving the source geometry, camera and final hold; inspect highlights and the moving boundary.”
- RU: «Создай 100 тысяч медных частиц в направленном потоке. Движение вычисляй на GPU из времени и seed; сравни кадр отдельно и внутри последовательности».
- EN: “Create 100,000 copper instances in a directed flow, GPU-placed from time and seed; compare random-access and sequential frames.”
- RU: «Проверь небольшой APIC-всплеск / закреплённый лоскут ткани. Сначала грубая сетка и закрытый затвор; отдельно измерь финальное движение с motion blur».
- EN: “Probe a bounded APIC parcel or pinned cloth patch; start coarse with a closed shutter, then measure the actual motion-blurred sequence separately.”
- RU: «Изогни свет вокруг скульптуры, сохрани читаемый силуэт; результат обозначь как художественную оптику, а не научное доказательство».
- EN: “Bend light around the sculpture while keeping the silhouette readable; label the optics artistic rather than a scientific measurement.”

Native std builders and authored triangle buffers can become reusable geometry. Computed instances, implicit fields and custom programmes may be render-only. Never promise their GLB extraction. Advanced fluid/cloth/fog support has bounded topology, memory and material contracts; read that topic before writing a scene. Do not lower acceptance thresholds after a failed run.
