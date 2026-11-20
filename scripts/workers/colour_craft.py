"""Colourist craft on sampled pixels: skin and environment secondaries, and the validation gate.

Pure NumPy/SciPy, no IO. A grade here is the normalised dict of src/types/colour.ts. Skin is keyed on the
*source* pixels (a region or the chroma rule) and the same pixel indices are read after grading, so a grade
can never move other pixels into the skin key and hide what it did to the face.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

import colour_maths as cm

MIN_SKIN_PIXELS = 200
CHROMATIC = 0.04  # Y'CbCr radius below which hue is undefined (about 8% of full chroma).


def skin_box(rgb: np.ndarray) -> np.ndarray:
    """Chai and Ngan Y'CbCr skin chroma box on (N, 3) pixels; it also catches wood, sand and beige walls."""
    y, cb, cr = cm.rgb_to_ycbcr(rgb)
    return (cb >= -0.2277) & (cb <= -0.0045) & (cr >= 0.0223) & (cr <= 0.2009) & (y >= 0.08) & (y <= 0.95)  # noqa: PLR2004 -- published box, darker floor for low-key faces.


def lab_summary(px: np.ndarray) -> dict[str, float]:
    """Mean L*, a*, b*, chroma and hue angle (degrees, CIELAB: 0 red, 90 yellow) of a pixel set."""
    lab = cm.rgb_to_lab(np.clip(px, 0, 1))
    mean = lab.mean(axis=0)
    return {
        "L": float(mean[0]),
        "a": float(mean[1]),
        "b": float(mean[2]),
        "C": float(np.hypot(mean[1], mean[2])),
        "h": float(math.degrees(math.atan2(mean[2], mean[1])) % 360),
    }


def hue_histogram(px: np.ndarray, bins: int = 24) -> np.ndarray:
    """Chroma-weighted vectorscope hue distribution of the chromatic pixels, summing to 1."""
    _, cb, cr = cm.rgb_to_ycbcr(np.clip(px, 0, 1))
    radius = np.hypot(cb, cr)
    keep = radius > CHROMATIC
    hist = np.histogram(cm.vectorscope_angle(cb[keep], cr[keep]), bins=bins, range=(0, 360), weights=radius[keep])[0]
    return hist / max(float(hist.sum()), 1e-9)


def hue_distance(a: np.ndarray, b: np.ndarray) -> float:
    """Circular earth mover's distance between two hue histograms, in degrees of hue."""
    diff = np.cumsum(a - b)
    diff = diff - np.median(diff)
    return float(np.abs(diff).sum() * 360 / len(a))


def _wrap(angle: float) -> float:
    return (angle + 180) % 360 - 180


def hue_words(delta_h: float) -> str:
    """CIELAB hue change on skin in words: + toward yellow, - toward red/magenta."""
    if abs(delta_h) < 1:
        return "unchanged"
    return f"{delta_h:+.0f} deg toward {'yellow' if delta_h > 0 else 'red/magenta'}"


def with_secondary(grade: dict[str, Any], secondary: dict[str, Any] | None) -> dict[str, Any]:
    """The grade with one more secondary appended (the original dict is not changed)."""
    if secondary is None:
        return grade
    return {**grade, "secondaries": [*grade.get("secondaries", []), secondary]}


def _qualifier_for(px: np.ndarray) -> dict[str, Any]:
    """A soft HSL key that holds most of `px` (vectorscope hue, chroma and luma ranges with margins)."""
    y, cb, cr = cm.rgb_to_ycbcr(np.clip(px, 0, 1))
    radius = np.hypot(cb, cr)
    angle = cm.vectorscope_angle(cb, cr)
    centre = cm.circular_mean_deg(angle, radius) or cm.SKIN_LINE_DEG
    spread = float(np.sqrt(np.average(((angle - centre + 180) % 360 - 180) ** 2, weights=np.maximum(radius, 1e-6))))
    chroma = radius / 0.5
    return {
        "hue": {"center": round(centre % 360, 2), "width": round(float(np.clip(2.5 * spread + 20, 40, 100)), 2), "softness": 12.0},
        "saturation": {"min": round(max(0.0, float(np.percentile(chroma, 5)) * 0.6), 4), "max": round(float(np.percentile(chroma, 95)) * 1.4 + 0.02, 4), "softness": 0.03},
        "luma": {"min": round(max(0.0, float(np.percentile(y, 2)) - 0.05), 4), "max": round(min(1.0, float(np.percentile(y, 98)) + 0.05), 4), "softness": 0.05},
    }


def skin_target(policy: dict[str, Any], source: dict[str, float], graded: dict[str, float]) -> dict[str, float]:
    """Where skin should land under a look's skin policy: hue held near the source, chroma scaled, L* follows the look."""
    allowance = float(policy.get("hueAllowance", 6))
    hue = source["h"] + float(np.clip(_wrap(graded["h"] - source["h"]), -allowance, allowance))
    chroma = source["C"] * float(policy.get("chroma", 1.0))
    lightness = graded["L"] + float(policy.get("lightness", 0.0))
    return {"L": lightness, "a": chroma * math.cos(math.radians(hue)), "b": chroma * math.sin(math.radians(hue))}


def solve_skin(grade: dict[str, Any], skin: np.ndarray, other: np.ndarray, target: dict[str, float], name: str = "skin hold") -> dict[str, Any] | None:
    """A skin secondary (hue shift, chroma, luma) that lands the graded skin on `target` with little spill elsewhere."""
    from scipy.optimize import least_squares

    if len(skin) < MIN_SKIN_PIXELS:
        return None
    skin = skin[:: max(1, len(skin) // 6000)]
    other = other[:: max(1, len(other) // 8000)]
    graded_skin = cm.apply_grade(skin, grade)
    base_other = cm.rgb_to_lab(cm.apply_grade(other, grade))
    qualifier = _qualifier_for(graded_skin)
    goal = np.array([target["L"], target["a"], target["b"]])

    def secondary(p: np.ndarray) -> dict[str, Any]:
        return {"name": name, "qualifier": qualifier, "hueShift": float(p[0]), "saturation": float(p[1]), "luma": float(p[2]), "strength": 1.0}

    def residual(p: np.ndarray) -> np.ndarray:
        g = with_secondary(grade, secondary(p))
        lab = cm.rgb_to_lab(cm.apply_grade(skin, g)).mean(axis=0)
        spill = np.abs(cm.rgb_to_lab(cm.apply_grade(other, g)) - base_other).mean()
        return np.concatenate([(lab - goal) * np.array([0.6, 1.0, 1.0]), [spill * 1.5], (p - np.array([0, 1, 0])) * np.array([0.02, 1.0, 4.0])])

    current = lab_summary(graded_skin)
    if math.dist((current["L"], current["a"], current["b"]), goal) < 1.0:
        return None
    solved = least_squares(residual, np.array([0.0, 1.0, 0.0]), bounds=([-35, 0.35, -0.15], [35, 1.8, 0.15]), max_nfev=200)
    p = solved.x
    out = secondary(p)
    out["hueShift"], out["saturation"], out["luma"] = round(out["hueShift"], 2), round(out["saturation"], 4), round(out["luma"], 4)
    return out


def solve_environment(grade: dict[str, Any], other: np.ndarray, reference_other: np.ndarray, skin_hue: float | None) -> dict[str, Any] | None:
    """Rotate and scale the dominant non-skin colour toward the reference's (blue toward teal, say).

    Lift/gamma/gain move every hue together; separation between skin and environment needs a qualified secondary.
    Skipped when the environment's dominant hue is within 50 degrees of skin, where it would recolour the face.
    """
    graded = cm.apply_grade(other[:: max(1, len(other) // 20000)], grade)
    reference_other = np.clip(reference_other[:: max(1, len(reference_other) // 20000)], 0, 1)
    _, cb, cr = cm.rgb_to_ycbcr(graded)
    _, rcb, rcr = cm.rgb_to_ycbcr(reference_other)
    radius, rradius = np.hypot(cb, cr), np.hypot(rcb, rcr)
    keep, rkeep = radius > CHROMATIC, rradius > CHROMATIC
    if keep.sum() < MIN_SKIN_PIXELS or rkeep.sum() < MIN_SKIN_PIXELS:
        return None
    here = cm.circular_mean_deg(cm.vectorscope_angle(cb[keep], cr[keep]), radius[keep])
    there = cm.circular_mean_deg(cm.vectorscope_angle(rcb[rkeep], rcr[rkeep]), rradius[rkeep])
    if here is None or there is None:
        return None
    if skin_hue is not None and abs(_wrap(here - skin_hue)) < 50:  # noqa: PLR2004 -- keep the key off the face.
        return None
    shift = float(np.clip(_wrap(there - here), -45, 45))
    gain = float(np.clip(np.median(rradius[rkeep]) / max(float(np.median(radius[keep])), 1e-6), 0.6, 1.6))
    if abs(shift) < 4 and abs(gain - 1) < 0.08:  # noqa: PLR2004 -- below a visible change.
        return None
    return {
        "name": "environment toward reference",
        "qualifier": {"hue": {"center": round(here % 360, 2), "width": 80.0, "softness": 20.0}, "saturation": {"min": 0.06, "max": 2.0, "softness": 0.04}},
        "hueShift": round(shift, 2),
        "saturation": round(gain, 4),
        "luma": 0.0,
        "strength": 1.0,
    }


# ---------------------------------------------------------------------------------------------------------------
# Validation gate

LIMITS = {
    "skinChromaRatio": (1.25, 1.5),  # graded / expected, upward
    "skinChromaFloor": (0.7, 0.5),  # graded / expected, downward
    "skinHueExtraDeg": (0.0, 10.0),  # degrees beyond the policy allowance: warn above 0, fail above 10
    "skinYellowDb": (5.0, 9.0),  # b* gain on skin beyond the policy
    "clipIncreasePct": (0.3, 1.5),
    "crushIncreasePct": (1.0, 4.0),
    "saturationP90Ratio": (1.4, 1.8),
    "referenceSkinDeltaE": (6.0, 10.0),
    "spillDeltaE": (2.0, 4.0),
}
RANK = {"pass": 0, "info": 0, "warn": 1, "fail": 2}


def _grade_level(value: float, limits: tuple[float, float]) -> str:
    warn, fail = limits
    return "fail" if value > fail else "warn" if value > warn else "pass"


def _entry(check_id: str, status: str, value: float | None, limit: str, text: str) -> dict[str, Any]:
    return {"id": check_id, "status": status, "value": None if value is None else round(value, 3), "limit": limit, "text": text}


def skin_checks(source_skin: np.ndarray, graded_skin: np.ndarray, policy: dict[str, Any]) -> list[dict[str, Any]]:
    """Skin under the grade: chroma, hue and yellow drift against what the look's skin policy allows."""
    s, g = lab_summary(source_skin), lab_summary(graded_skin)
    expected = float(policy.get("chroma", 1.0))
    allowance = float(policy.get("hueAllowance", 6))
    ratio = g["C"] / max(s["C"], 1e-6) / expected
    up = _grade_level(ratio, LIMITS["skinChromaRatio"])
    down = _grade_level(1 / max(ratio, 1e-6), (1 / LIMITS["skinChromaFloor"][0], 1 / LIMITS["skinChromaFloor"][1]))
    chroma_status = up if RANK[up] >= RANK[down] else down
    dh = _wrap(g["h"] - s["h"])
    extra = max(abs(dh) - allowance, 0.0)
    hue_status = "pass" if extra <= LIMITS["skinHueExtraDeg"][0] else "fail" if extra > LIMITS["skinHueExtraDeg"][1] else "warn"
    db = g["b"] - s["b"] - (expected - 1) * s["b"]
    yellow_status = _grade_level(db, LIMITS["skinYellowDb"]) if not policy.get("warm") else "info"
    return [
        _entry("skin.chroma", chroma_status, ratio, "0.7..1.25 of the policy (fail outside 0.5..1.5)", f"skin chroma x{g['C'] / max(s['C'], 1e-6):.2f} (policy x{expected:.2f})"),
        _entry("skin.hue", hue_status, dh, f"within {allowance:g} deg (fail beyond +10)", f"skin hue {hue_words(dh)}"),
        _entry("skin.yellow", yellow_status, db, "b* gain under 5 (fail above 9)", f"skin b* {s['b']:+.1f} -> {g['b']:+.1f}"),
        _entry("skin.lightness", "info", g["L"] - s["L"], "reported", f"skin L* {s['L']:.1f} -> {g['L']:.1f}"),
    ]


def level_checks(source: np.ndarray, graded: np.ndarray, reference: np.ndarray | None = None) -> list[dict[str, Any]]:
    """Highlights, blacks and overall saturation: what a grade must not destroy.

    With a reference, its own clipping and crushed share is the baseline: matching a low-key film may deepen
    blacks as far as the film has them, not further.
    """

    def clip(px: np.ndarray) -> float:
        return float(100 * (px >= 0.998).any(axis=1).mean())  # noqa: PLR2004 -- two 10-bit codes below white.

    def crush(px: np.ndarray) -> float:
        return float(100 * (cm.luma(np.clip(px, 0, 1)) < 0.02).mean())  # noqa: PLR2004 -- about 2 IRE.

    clip_s, clip_g = clip(source), clip(graded)
    crush_s, crush_g = crush(source), crush(graded)
    clip_base, crush_base = clip_s, crush_s
    note = ""
    if reference is not None:
        clip_base, crush_base = max(clip_s, clip(reference)), max(crush_s, crush(reference))
        note = f" (reference {crush(reference):.2f}%)"

    def p90(px: np.ndarray) -> float:
        return float(np.percentile(np.hypot(*cm.rgb_to_lab(np.clip(px, 0, 1))[:, 1:].T), 90))

    # A reference as rich as the grade is its baseline too: matching a saturated film is not oversaturation.
    sat = p90(graded) / max(p90(source), p90(reference) if reference is not None else 0.0, 1e-6)
    return [
        _entry("levels.clipping", _grade_level(clip_g - clip_base, LIMITS["clipIncreasePct"]), clip_g - clip_base, "+0.3 pp over the baseline (fail +1.5)", f"clipped {clip_s:.2f}% -> {clip_g:.2f}%"),
        _entry(
            "levels.crush",
            _grade_level(crush_g - crush_base, LIMITS["crushIncreasePct"]),
            crush_g - crush_base,
            "+1 pp over the baseline (fail +4)",
            f"crushed blacks {crush_s:.2f}% -> {crush_g:.2f}%{note}",
        ),
        _entry("saturation.p90", _grade_level(sat, LIMITS["saturationP90Ratio"]), sat, "x1.4 (fail x1.8)", f"P90 chroma x{sat:.2f}"),
    ]


def _skin_vs_reference(graded_skin: np.ndarray | None, reference_skin: np.ndarray | None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if graded_skin is not None and reference_skin is not None and len(reference_skin) >= MIN_SKIN_PIXELS:
        g, r = lab_summary(graded_skin), lab_summary(reference_skin)
        de = float(cm.delta_e_2000(np.array([g["L"], g["a"], g["b"]]), np.array([r["L"], r["a"], r["b"]])))
        out.append(
            _entry(
                "reference.skin",
                _grade_level(de, LIMITS["referenceSkinDeltaE"]),
                de,
                "dE2000 6 (fail 10)",
                f"skin vs reference dE2000 {de:.1f} (L* {g['L']:.0f}/{r['L']:.0f}, C* {g['C']:.0f}/{r['C']:.0f})",
            )
        )
    return out


def reference_checks(source_other: np.ndarray, graded_other: np.ndarray, reference_other: np.ndarray, graded_skin: np.ndarray | None, reference_skin: np.ndarray | None) -> list[dict[str, Any]]:
    """Did the grade move toward the reference: environment hue distribution and skin colour."""
    ref_hist = hue_histogram(reference_other)
    if not ref_hist.any() or not hue_histogram(source_other).any():
        out = [_entry("reference.environmentHue", "info", 0.0, "chromatic pixels in both", "environment hue: too few chromatic pixels to compare")]
        return out + _skin_vs_reference(graded_skin, reference_skin)
    before, after = hue_distance(hue_histogram(source_other), ref_hist), hue_distance(hue_histogram(graded_other), ref_hist)
    closer = after <= before * 0.9 or after < 10  # noqa: PLR2004 -- 10% closer, or within 10 deg of hue.
    return [
        _entry("reference.environmentHue", "pass" if closer else "warn", after, "10% closer than the source", f"environment hue distance to reference {before:.1f} -> {after:.1f} deg"),
        *_skin_vs_reference(graded_skin, reference_skin),
    ]


def spill_check(before_other: np.ndarray, after_other: np.ndarray) -> dict[str, Any]:
    """How much the secondaries changed pixels outside the skin (mean CIEDE2000)."""
    de = float(cm.delta_e_2000(cm.rgb_to_lab(np.clip(before_other, 0, 1)), cm.rgb_to_lab(np.clip(after_other, 0, 1))).mean())
    return _entry("secondaries.spill", _grade_level(de, LIMITS["spillDeltaE"]), de, "mean dE2000 2 off-skin (fail 4)", f"secondaries change off-skin pixels by dE2000 {de:.2f}")


def gate(source: np.ndarray, graded: np.ndarray, skin: np.ndarray, policy: dict[str, Any], reference: tuple[np.ndarray, np.ndarray] | None = None) -> dict[str, Any]:
    """Every check on pixel-aligned source/graded arrays; `skin` is a boolean mask keyed on the source."""
    checks = level_checks(source, graded, reference[0] if reference is not None else None)
    if skin.sum() >= MIN_SKIN_PIXELS:
        checks = skin_checks(source[skin], graded[skin], policy) + checks
    else:
        checks.insert(0, _entry("skin.found", "info", float(skin.sum()), f"{MIN_SKIN_PIXELS} pixels", "no skin found: skin checks skipped"))
    if reference is not None:
        ref_px, ref_skin = reference
        checks += reference_checks(source[~skin], graded[~skin], ref_px[~ref_skin], graded[skin] if skin.sum() >= MIN_SKIN_PIXELS else None, ref_px[ref_skin])
    status = max((c["status"] for c in checks), key=lambda s: RANK[s])
    status = "pass" if status == "info" else status
    return {"status": status, "checks": checks, "failed": [c["text"] for c in checks if c["status"] == "fail"], "warnings": [c["text"] for c in checks if c["status"] == "warn"]}
