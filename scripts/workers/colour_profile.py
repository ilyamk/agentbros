"""Colour profile of a shot: the measurable target a grade is brought to and checked against.

Pure NumPy, no decoding. `measure` turns pixels into levels, white-balance cast, saturation, hue distribution,
palette scheme, a five-colour palette, skin and a mood estimate. `compare` grades a measured profile against a
target with tolerances. `mood_grade` turns a mood offset into a bounded grade adjustment. The mood estimate is a
convention built on colour-emotion studies of colour patches (brightness drives pleasure, saturation drives arousal;
Valdez and Mehrabian 1994, Wilms and Oberfeld 2018), not a measurement of how a film feels.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

import colour_craft as cc
import colour_maths as cm

PALETTE_SIZE = 5
PALETTE_PIXELS = 20_000
HUE_BINS = 24

# Vectorscope angles of the named hues (this tool's convention: atan2(Cr, Cb)).
HUE_NAMES = ((50, "magenta"), (103, "red"), (123, "skin/orange"), (175, "yellow"), (230, "green"), (260, "teal"), (283, "cyan"), (308, "cyan-blue"), (330, "blue"), (355, "blue"))

# warn, fail: absolute differences unless the id says ratio or one-sided increase.
TOLERANCES: dict[str, tuple[float, float]] = {
    "levels.black": (3.0, 6.0),
    "levels.white": (5.0, 10.0),
    "levels.mid": (5.0, 10.0),
    "levels.contrast": (6.0, 12.0),
    "levels.crush": (1.0, 4.0),
    "levels.clip": (0.3, 1.5),
    "colour.cast": (3.0, 6.0),  # neutrals differ with content: a reference is rarely the same set.
    "colour.chromaP50": (1.2, 1.45),
    "colour.chromaP90": (1.2, 1.45),
    "colour.hue": (12.0, 25.0),
    "colour.palette": (8.0, 14.0),
    "skin.deltaE": (6.0, 10.0),
    "skin.hue": (8.0, 15.0),
}

# Bounded grade moves per unit of mood offset (valence, arousal run -1..1).
MOOD_LIMITS = {"gamma": 0.15, "warmth": 0.035, "saturation": 0.25, "contrast": 0.12}


def hue_name(angle: float | None) -> str:
    """The nearest named hue to a vectorscope angle."""
    if angle is None:
        return "neutral"
    return min(HUE_NAMES, key=lambda item: abs(cm.angle_difference(angle, item[0])))[1]


def _clip1(x: float) -> float:
    return float(max(-1.0, min(1.0, x)))


def palette(px: np.ndarray, k: int = PALETTE_SIZE, iterations: int = 12) -> list[dict[str, Any]]:
    """K key colours by k-means in CIELAB with deterministic seeds (lightness quantiles), sorted dark to light."""
    sample = px[:: max(1, math.ceil(len(px) / PALETTE_PIXELS))]
    lab = cm.rgb_to_lab(np.clip(sample, 0, 1))
    order = np.argsort(lab[:, 0], kind="stable")
    centres = np.array([lab[chunk].mean(axis=0) for chunk in np.array_split(order, k)])
    labels = np.zeros(len(lab), dtype=int)
    for _ in range(iterations):
        labels = np.argmin(((lab[:, None, :] - centres[None]) ** 2).sum(axis=2), axis=1)
        moved = np.array([lab[labels == i].mean(axis=0) if (labels == i).any() else centres[i] for i in range(k)])
        if np.allclose(moved, centres, atol=1e-4):
            break
        centres = moved
    out = []
    for i in np.argsort(centres[:, 0], kind="stable"):
        members = sample[labels == i]
        rgb = members.mean(axis=0) if len(members) else np.zeros(3)
        out.append({"lab": [round(float(v), 2) for v in centres[i]], "rgb": [round(float(v), 4) for v in np.clip(rgb, 0, 1)], "share": round(float((labels == i).mean()), 4)})
    return out


def scheme(hist: np.ndarray, chroma_p50: float) -> dict[str, Any]:
    """Palette scheme from the chroma-weighted hue histogram: neutral, monochrome, analogous, complementary, split."""
    if chroma_p50 < 4 or not hist.any():  # noqa: PLR2004 -- C* below 4 reads as grey.
        return {"scheme": "neutral", "keyHues": []}
    width = 360 / len(hist)
    smooth = (np.roll(hist, 1) + 2 * hist + np.roll(hist, -1)) / 4
    peaks = [i for i in range(len(hist)) if smooth[i] >= smooth[i - 1] and smooth[i] > smooth[(i + 1) % len(hist)] and smooth[i] >= 0.08]  # noqa: PLR2004 -- 8% of the colour weight.
    peaks = sorted(peaks, key=lambda i: -smooth[i])[:3]
    angles = [round((i + 0.5) * width, 1) for i in peaks]
    key = [{"angleDeg": a, "name": hue_name(a), "weight": round(float(smooth[i]), 3)} for a, i in zip(angles, peaks, strict=True)]
    if len(angles) <= 1:
        spread = float(np.sum(hist > 0.04)) * width  # noqa: PLR2004 -- bins carrying real weight.
        return {"scheme": "monochrome" if spread <= 60 else "analogous", "keyHues": key}  # noqa: PLR2004 -- one hue family.
    gap = abs(cm.angle_difference(angles[0], angles[1]))
    if gap >= 140:  # noqa: PLR2004 -- roughly opposite on the wheel.
        name = "complementary" if len(angles) == 2 or smooth[peaks[2]] < 0.5 * smooth[peaks[1]] else "split-complementary"  # noqa: PLR2004 -- a weak third peak.
    elif gap <= 75:  # noqa: PLR2004 -- neighbours on the wheel.
        name = "analogous"
    else:
        name = "triadic" if len(angles) == 3 else "contrasting"  # noqa: PLR2004 -- three separated peaks.
    return {"scheme": name, "keyHues": key}


def mood(lightness_p50: float, chroma_p50: float, contrast_lstar: float, warmth: float) -> dict[str, float]:
    """Valence and arousal (-1..1) by convention: brightness and warmth lift valence; saturation and contrast arousal."""
    b = _clip1((lightness_p50 - 45) / 35)
    s = _clip1((chroma_p50 - 12) / 12)
    k = _clip1((contrast_lstar - 55) / 25)
    w = _clip1(warmth / 12)
    return {"valence": round(_clip1(0.6 * b + 0.25 * w + 0.15 * s), 3), "arousal": round(_clip1(0.6 * s + 0.3 * k - 0.1 * b), 3)}


def measure(px: np.ndarray, skin: np.ndarray | None = None, keyed: str = "chroma-rule") -> dict[str, Any]:
    """The profile of one shot's pixels (N, 3); `skin` is a boolean mask, `keyed` how it was found (region or chroma-rule)."""
    clipped = np.clip(px, 0, 1)
    y = cm.luma(clipped)
    lab = cm.rgb_to_lab(clipped)
    chroma = np.hypot(lab[:, 1], lab[:, 2])
    q = np.percentile(y, [2, 10, 50, 90, 98])
    lq = np.percentile(lab[:, 0], [10, 50, 90])
    cast = cm.neutral_cast(lab)
    hist = cc.hue_histogram(px, HUE_BINS)
    c50, c90 = float(np.percentile(chroma, 50)), float(np.percentile(chroma, 90))
    warmth = float(np.average(lab[:, 2], weights=np.clip(chroma, 1e-3, None)))
    profile: dict[str, Any] = {
        "levels": {
            "blackIre": round(float(q[0]) * 100, 2),
            "midIre": round(float(q[2]) * 100, 2),
            "whiteIre": round(float(q[4]) * 100, 2),
            "contrastIre": round(float(q[3] - q[1]) * 100, 2),
            "crushPct": round(float(100 * (y < 0.02).mean()), 3),  # noqa: PLR2004 -- about 2 IRE, as the gate.
            "clipPct": round(float(100 * (clipped >= 0.998).any(axis=1).mean()), 3),  # noqa: PLR2004 -- as the gate.
        },
        "colour": {
            "castA": round(cast["a"], 2),
            "castB": round(cast["b"], 2),
            "chromaP50": round(c50, 2),
            "chromaP90": round(c90, 2),
            "warmth": round(warmth, 2),
            "hueHistogram": [round(float(v), 4) for v in hist],
            **scheme(hist, c50),
        },
        "palette": palette(px),
        "mood": mood(float(lq[1]), c50, float(lq[2] - lq[0]), warmth),
    }
    if skin is not None and skin.sum() >= cc.MIN_SKIN_PIXELS:
        s = cc.lab_summary(px[skin])
        profile["skin"] = {k: round(v, 2) for k, v in s.items()} | {"pixelsPct": round(float(100 * skin.mean()), 3), "keyed": keyed}
    return profile


def _status(value: float, limits: tuple[float, float]) -> str:
    warn, fail = limits
    return "fail" if value > fail else "warn" if value > warn else "pass"


def _check(check_id: str, value: float, text: str, limits: tuple[float, float] | None = None) -> dict[str, Any]:
    limits = limits or TOLERANCES[check_id]
    return {"id": check_id, "status": _status(value, limits), "value": round(value, 3), "limit": f"warn {limits[0]:g}, fail {limits[1]:g}", "text": text}


def palette_distance(a: list[dict[str, Any]], b: list[dict[str, Any]]) -> float:
    """Share-weighted mean CIEDE2000 from each colour of `a` to its nearest colour in `b`, both ways."""

    def one_way(x: list[dict[str, Any]], z: list[dict[str, Any]]) -> float:
        lz = np.array([c["lab"] for c in z])
        total = 0.0
        for c in x:
            total += c["share"] * float(cm.delta_e_2000(np.repeat(np.array([c["lab"]]), len(lz), axis=0), lz).min())
        return total / max(sum(c["share"] for c in x), 1e-9)

    return 0.5 * (one_way(a, b) + one_way(b, a))


def compare(target: dict[str, Any], got: dict[str, Any]) -> list[dict[str, Any]]:
    """Every tolerance check of a measured profile against a target profile."""
    tl, gl = target["levels"], got["levels"]
    tc, gc = target["colour"], got["colour"]
    out = [
        _check("levels.black", abs(gl["blackIre"] - tl["blackIre"]), f"black {gl['blackIre']:.1f} IRE (target {tl['blackIre']:.1f})"),
        _check("levels.mid", abs(gl["midIre"] - tl["midIre"]), f"mid-grey {gl['midIre']:.1f} IRE (target {tl['midIre']:.1f})"),
        _check("levels.white", abs(gl["whiteIre"] - tl["whiteIre"]), f"white {gl['whiteIre']:.1f} IRE (target {tl['whiteIre']:.1f})"),
        _check("levels.contrast", abs(gl["contrastIre"] - tl["contrastIre"]), f"contrast {gl['contrastIre']:.1f} IRE (target {tl['contrastIre']:.1f})"),
        _check("levels.crush", max(0.0, gl["crushPct"] - tl["crushPct"]), f"crushed {gl['crushPct']:.2f}% (target {tl['crushPct']:.2f}%)"),
        _check("levels.clip", max(0.0, gl["clipPct"] - tl["clipPct"]), f"clipped {gl['clipPct']:.2f}% (target {tl['clipPct']:.2f}%)"),
        _check(
            "colour.cast", math.hypot(gc["castA"] - tc["castA"], gc["castB"] - tc["castB"]), f"neutral cast a*/b* {gc['castA']:+.1f}/{gc['castB']:+.1f} (target {tc['castA']:+.1f}/{tc['castB']:+.1f})"
        ),
    ]
    for key in ("chromaP50", "chromaP90"):
        ratio = (gc[key] + 0.5) / (tc[key] + 0.5)
        out.append(_check(f"colour.{key}", max(ratio, 1 / ratio), f"{key} C* {gc[key]:.1f} (target {tc[key]:.1f}, x{ratio:.2f})"))
    th, gh = np.array(tc["hueHistogram"]), np.array(gc["hueHistogram"])
    if th.any() and gh.any():
        out.append(_check("colour.hue", cc.hue_distance(gh, th), f"hue distribution {cc.hue_distance(gh, th):.1f} deg from target ({gc['scheme']} vs {tc['scheme']})"))
    out.append(_check("colour.palette", palette_distance(got["palette"], target["palette"]), f"palette dE2000 {palette_distance(got['palette'], target['palette']):.1f} from target"))
    if "skin" in target and "skin" in got:
        ts, gs = target["skin"], got["skin"]
        de = float(cm.delta_e_2000(np.array([gs["L"], gs["a"], gs["b"]]), np.array([ts["L"], ts["a"], ts["b"]])))
        dh = abs(cm.angle_difference(gs["h"], ts["h"])) if min(gs["C"], ts["C"]) > 3 else 0.0  # noqa: PLR2004 -- hue is noise near grey.
        skin_checks = [
            _check("skin.deltaE", de, f"skin dE2000 {de:.1f} (L* {gs['L']:.0f}/{ts['L']:.0f}, C* {gs['C']:.0f}/{ts['C']:.0f})"),
            _check("skin.hue", dh, f"skin hue {gs['h']:.0f} deg (target {ts['h']:.0f})"),
        ]
        if ts.get("keyed") != "region" or gs.get("keyed") != "region":
            # The chroma rule also keys walls and wood, and a graded frame re-keys what the grade turned skin-coloured:
            # judged only on face regions given on both sides.
            skin_checks = [{**c, "status": "info", "text": c["text"] + " (chroma-rule key: not judged; pass face regions)"} for c in skin_checks]
        out += skin_checks
    tm, gm = target["mood"], got["mood"]
    out.append(
        {
            "id": "mood",
            "status": "info",
            "value": round(math.hypot(gm["valence"] - tm["valence"], gm["arousal"] - tm["arousal"]), 3),
            "limit": "convention, not judged",
            "text": f"mood v/a {gm['valence']:+.2f}/{gm['arousal']:+.2f} (target {tm['valence']:+.2f}/{tm['arousal']:+.2f})",
        }
    )
    return out


def verdict(checks: list[dict[str, Any]]) -> dict[str, Any]:
    """Worst status of a check list, with the failed and warning texts."""
    judged = [c for c in checks if c["status"] in cc.RANK]
    status = max((c["status"] for c in judged), key=lambda v: cc.RANK[v], default="pass")
    status = "pass" if status == "info" else status
    return {"status": status, "failed": [c["text"] for c in judged if c["status"] == "fail"], "warnings": [c["text"] for c in judged if c["status"] == "warn"]}


def mood_grade(current: dict[str, float], wanted: dict[str, float], strength: float = 1.0) -> dict[str, Any]:
    """A bounded grade that moves a shot's mood toward `wanted`.

    Valence moves by brightness and warmth, arousal by saturation and contrast. Each move is capped by MOOD_LIMITS;
    the gate still judges the result.
    """
    dv = _clip1(wanted["valence"] - current["valence"]) * strength
    da = _clip1(wanted["arousal"] - current["arousal"]) * strength
    gamma = 1 + MOOD_LIMITS["gamma"] * dv  # out ** (1 / gamma): above 1 brightens.
    warm = MOOD_LIMITS["warmth"] * dv
    return {
        "gamma": [round(gamma, 4)] * 3,
        "gain": [round(1 + warm, 4), 1.0, round(1 - warm, 4)],
        "contrast": {"amount": round(1 + MOOD_LIMITS["contrast"] * da, 4), "pivot": 0.435},
        "saturation": round(1 + MOOD_LIMITS["saturation"] * da, 4),
        "softClip": {"high": 0.95},
    }


def synthetic_card(width: int = 960, height: int = 540) -> np.ndarray:
    """A synthetic card for comparing looks without anyone's face.

    A grey ramp, hue sweeps at two saturations, a range of skin tones (CIELAB hue 50-60 deg, the skin line) and a
    few memory colours (sky, foliage, brand red, white).
    """
    img = np.zeros((height, width, 3))
    band = height // 5
    ramp = np.linspace(0, 1, width)
    img[:band] = ramp[None, :, None]
    hue = np.linspace(0, 2 * np.pi, width, endpoint=False)
    for row, (lightness, chroma) in enumerate(((60.0, 45.0), (55.0, 20.0)), start=1):
        lab = np.stack([np.full(width, lightness), chroma * np.cos(hue), chroma * np.sin(hue)], axis=-1)
        img[row * band : (row + 1) * band] = np.clip(lab_to_rgb(lab), 0, 1)[None]
    skins = [(lightness, chroma, angle) for lightness, chroma, angle in ((30, 14, 52), (42, 18, 55), (55, 20, 57), (66, 18, 58), (76, 14, 60), (86, 10, 62))]
    memory = [(62, 30, 250), (48, 40, 130), (45, 65, 35), (92, 2, 90)]
    patches = skins + memory
    pw = width // len(patches)
    for index, (lightness, chroma, angle) in enumerate(patches):
        a, b = chroma * math.cos(math.radians(angle)), chroma * math.sin(math.radians(angle))
        img[3 * band : 5 * band, index * pw : (index + 1) * pw] = np.clip(lab_to_rgb(np.array([[lightness, a, b]])), 0, 1)[0]
    return img


def lab_to_rgb(lab: np.ndarray) -> np.ndarray:
    """CIELAB (D65) to encoded Rec.709 R'G'B', the inverse of colour_maths.rgb_to_lab."""
    fy = (lab[..., 0] + 16) / 116
    fx = fy + lab[..., 1] / 500
    fz = fy - lab[..., 2] / 200

    def finv(f: np.ndarray) -> np.ndarray:
        return np.where(f**3 > cm.LAB_EPSILON, f**3, (116 * f - 16) / cm.LAB_KAPPA)

    xyz = np.stack([finv(fx), finv(fy), finv(fz)], axis=-1) * cm.D65_WHITE
    return cm.from_linear(np.clip(xyz @ np.linalg.inv(cm.RGB709_TO_XYZ).T, 0, None))
