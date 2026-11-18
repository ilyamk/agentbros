# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Light moods, view transforms and grades: pure data, no `bpy`, so tests read them directly.

A mood is a lighting ratio, a colour temperature and a world: each light is placed in polar coordinates round the subject
relative to the camera (azimuth 0 = from the camera, positive = camera right; elevation in degrees; distance and size in
subject sizes), with `share` its irradiance on the subject as a fraction of the key's. Key-to-fill ratio is 1 / fill share:
2:1 reads soft and commercial, 4:1 shaped, 8:1 and over dramatic.

Each mood names its view transform with a reason (VIEWS) and a grade (GRADES), so the look is chosen with the light.
"""

from typing import NotRequired, TypedDict


class LightSpec(TypedDict):
    """Polar placement and irradiance share for one light."""

    name: str
    az: float
    el: float
    dist: NotRequired[float]
    size: NotRequired[float]
    share: float
    kelvin: NotRequired[float]
    kind: NotRequired[str]
    angle: NotRequired[float]
    colour: NotRequired[str]
    ratio: NotRequired[float]


class MoodSpec(TypedDict):
    """World, lights and colour grade for a lighting mood."""

    about: str
    lights: list[LightSpec]
    hdri: str
    world: float
    view: str
    grade: str
    exposure: NotRequired[float]
    bloom: NotRequired[float]


# HDRIs in public/shared/hdri (studio_kit.HDRIS keys); strength is the world's, under the area lights.
MOODS: dict[str, MoodSpec] = {
    "soft-product": {
        "about": "Soft commercial product light: big key, gentle 2:1 fill, a clean rim for the edge. The default for products and characters.",
        "lights": [
            {"name": "key", "az": -55, "el": 35, "dist": 3.2, "size": 2.4, "share": 1.0, "kelvin": 5600},
            {"name": "fill", "az": 65, "el": 12, "dist": 3.6, "size": 3.2, "share": 0.45, "kelvin": 6300},
            {"name": "rim", "az": 155, "el": 32, "dist": 3.0, "size": 1.4, "ratio": 0.25, "share": 0.9, "kelvin": 6800},
            {"name": "top", "az": 0, "el": 82, "dist": 4.0, "size": 3.0, "share": 0.22, "kelvin": 6000},
        ],
        "hdri": "softbox",
        "world": 0.3,
        "view": "agx",
        "grade": "clean",
    },
    "high-key": {
        "about": "Bright, almost shadowless commercial: fill near the key (1.25:1), top light, light ground. Retail, apps, friendly.",
        "lights": [
            {"name": "key", "az": -35, "el": 30, "dist": 3.0, "size": 3.2, "share": 1.0, "kelvin": 6000},
            {"name": "fill", "az": 45, "el": 15, "dist": 3.2, "size": 3.6, "share": 0.8, "kelvin": 6300},
            {"name": "top", "az": 0, "el": 80, "dist": 3.6, "size": 4.0, "share": 0.6, "kelvin": 6200},
            {"name": "rim", "az": 180, "el": 25, "dist": 3.0, "size": 1.6, "ratio": 0.3, "share": 0.5, "kelvin": 6500},
        ],
        "hdri": "studio",
        "world": 0.8,
        "exposure": 0.3,
        "view": "agx-base",
        "grade": "clean",
    },
    "low-key": {
        "about": "Dramatic: a smaller key from the side, almost no fill (16:1), a cold rim to cut the silhouette from black.",
        "lights": [
            {"name": "key", "az": -78, "el": 38, "dist": 3.0, "size": 1.1, "share": 1.0, "kelvin": 4300},
            {"name": "fill", "az": 70, "el": 5, "dist": 3.5, "size": 2.0, "share": 0.06, "kelvin": 6500},
            {"name": "rim", "az": 150, "el": 24, "dist": 2.8, "size": 0.9, "ratio": 0.2, "share": 1.6, "kelvin": 7800},
        ],
        "hdri": "studio",
        "world": 0.05,
        "exposure": -0.2,
        "view": "agx-contrast",
        "grade": "filmic",
    },
    "rim-hero": {
        "about": "Silhouette first: two strip rims draw the edges, a low key reveals the face. Hero reveals on dark grounds.",
        "lights": [
            {"name": "rim-left", "az": -132, "el": 18, "dist": 2.8, "size": 1.6, "ratio": 0.12, "share": 1.5, "kelvin": 7200},
            {"name": "rim-right", "az": 132, "el": 18, "dist": 2.8, "size": 1.6, "ratio": 0.12, "share": 1.5, "kelvin": 5200},
            {"name": "key", "az": -28, "el": 42, "dist": 3.4, "size": 1.6, "share": 0.4, "kelvin": 5600},
            {"name": "top", "az": 0, "el": 85, "dist": 3.6, "size": 2.0, "share": 0.18, "kelvin": 6000},
        ],
        "hdri": "studio",
        "world": 0.12,
        "view": "agx-contrast",
        "grade": "filmic",
    },
    "golden-hour": {
        "about": "Late sun: a low warm sun (3000 K) raking from behind the subject's side, cool sky fill, long shadows.",
        "lights": [
            {"name": "sun", "kind": "SUN", "az": -118, "el": 9, "share": 1.0, "kelvin": 3000, "angle": 1.5},
            {"name": "sky", "az": 60, "el": 45, "dist": 4.0, "size": 6.0, "share": 0.28, "kelvin": 9500},
            {"name": "bounce", "az": -20, "el": -5, "dist": 3.0, "size": 3.0, "share": 0.12, "kelvin": 3600},
        ],
        "hdri": "warm",
        "world": 0.35,
        "view": "agx-punchy",
        "grade": "filmic",
    },
    "neon-night": {
        "about": "Night: two saturated practicals (magenta key, cyan rim) on a near-black world, a whisper of fill. Use bloom.",
        "lights": [
            {"name": "key", "az": -100, "el": 18, "dist": 2.6, "size": 1.4, "ratio": 0.18, "share": 1.0, "colour": "#ff2f8a"},
            {"name": "rim", "az": 125, "el": 15, "dist": 2.6, "size": 1.4, "ratio": 0.18, "share": 1.3, "colour": "#1ed2ff"},
            {"name": "fill", "az": 0, "el": 2, "dist": 3.5, "size": 3.0, "share": 0.04, "kelvin": 8000},
        ],
        "hdri": "loft",
        "world": 0.03,
        "exposure": -0.1,
        "view": "agx-punchy",
        "grade": "filmic",
        "bloom": 0.35,
    },
    "overcast": {
        "about": "Overcast daylight: one huge soft top source, broad front fill, no rim; low contrast and true colour. Natural, honest.",
        "lights": [
            {"name": "sky", "az": 0, "el": 72, "dist": 4.0, "size": 7.0, "share": 1.0, "kelvin": 6800},
            {"name": "fill", "az": 10, "el": 15, "dist": 4.0, "size": 6.0, "share": 0.55, "kelvin": 6500},
        ],
        "hdri": "loft",
        "world": 0.7,
        "view": "agx-base",
        "grade": "clean",
    },
}

# View transforms: why each is chosen. The measured screen table is in the blender-3d skill's look reference.
VIEWS = {
    "agx": {
        "view": "AgX",
        "look": "AgX - Medium High Contrast",
        "why": "Photoreal default: highlights roll off without clipping or hue skew; a medium-high contrast look restores the punch AgX's base curve removes.",
    },
    "agx-base": {
        "view": "AgX",
        "look": "None",
        "why": "Bright, low-contrast grounds and screens: base AgX with no look keeps whites white and is the exact inverse of the 'AgX Base sRGB' screen colourspace.",
    },
    "agx-contrast": {"view": "AgX", "look": "AgX - High Contrast", "why": "Low-key and rim light: deep blacks without crushing the rim's highlight."},
    "agx-punchy": {
        "view": "AgX",
        "look": "AgX - Punchy",
        "why": "Saturated light (sunset, neon): AgX desaturates bright colour on purpose; Punchy gives back saturation for colour that is the subject.",
    },
    "filmic": {"view": "Filmic", "look": "Medium High Contrast", "why": "Matching older Filmic renders only. AgX handles saturated highlights better; prefer it."},
    "standard": {"view": "Standard", "look": "None", "why": "Exact colours: a brand hex or a flat emissive ground must equal the same hex in Remotion. Clips highlights, so light gently."},
}

# Compositor grades named like the library's finish presets (src/motion/library/finish/presets.ts). Grain is left to
# Remotion's FilmFinish over the plate, so it is never doubled.
GRADES = {
    "clean": {"bloom": 0.04, "threshold": 1.4, "vignette": 0.08, "saturation": 1.0, "lift": 0.0, "warmth": 0.0, "dispersion": 0.0},
    "filmic": {"bloom": 0.12, "threshold": 1.0, "vignette": 0.18, "saturation": 0.97, "lift": 0.008, "warmth": 0.04, "dispersion": 0.006},
    "tactile": {"bloom": 0.03, "threshold": 1.6, "vignette": 0.12, "saturation": 0.92, "lift": 0.015, "warmth": 0.07, "dispersion": 0.0},
}

# Colourspace that inverts each view for an emissive image at strength 1: the screen shows its own sRGB colours.
SCREEN_COLOURSPACE = {"AgX": "AgX Base sRGB", "Filmic": "Filmic sRGB", "Standard": "sRGB"}


def ratio(mood: str) -> float | None:
    """Key-to-fill ratio of a mood (None when it has no fill light)."""
    lights = MOODS[mood]["lights"]
    key = next((entry for entry in lights if entry["name"] in ("key", "sun", "sky")), lights[0])
    fill = next((entry for entry in lights if entry["name"] in ("fill", "sky", "bounce") and entry is not key), None)
    return key["share"] / fill["share"] if fill else None
