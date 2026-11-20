"""Colour science for the colour worker: Y'CbCr, CIE Lab, CIEDE2000, the grade model and .cube LUTs.

Every function is a pure function of its arrays, so a grade, a LUT bake and a measurement are deterministic.
Encoded values are display-referred Rec.709 code values normalised to 0..1 (black 0, nominal white 1); values
outside that range are kept until the grade's final clamp so scopes can show excursions.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import numpy as np

# Luma coefficients (Kr, Kb) per matrix.
MATRICES: dict[str, tuple[float, float]] = {
    "bt709": (0.2126, 0.0722),
    "bt601": (0.299, 0.114),
    "bt2020": (0.2627, 0.0593),
}
# Display EOTF used to linearise Rec.709 code values for colourimetry (BT.1886 with a zero black level).
DISPLAY_GAMMA = 2.4
RGB709_TO_XYZ = np.array(
    [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ],
)
D65_WHITE = np.array([0.95047, 1.0, 1.08883])
D65_XY = (0.3127, 0.3290)
REC709_PRIMARIES_XY = ((0.64, 0.33), (0.30, 0.60), (0.15, 0.06))
P3_PRIMARIES_XY = ((0.680, 0.320), (0.265, 0.690), (0.150, 0.060))
REC2020_PRIMARIES_XY = ((0.708, 0.292), (0.170, 0.797), (0.131, 0.046))
# The conventional skin-tone (I) line on a vectorscope, in degrees counter-clockwise from +Cb.
SKIN_LINE_DEG = 123.0
LAB_EPSILON = 216 / 24389
LAB_KAPPA = 24389 / 27


def ycbcr_to_rgb(y: np.ndarray, cb: np.ndarray, cr: np.ndarray, matrix: str) -> np.ndarray:
    """Normalised Y' (0..1) and Cb/Cr (-0.5..0.5) to unclipped R'G'B'."""
    kr, kb = MATRICES[matrix]
    kg = 1 - kr - kb
    r = y + 2 * (1 - kr) * cr
    b = y + 2 * (1 - kb) * cb
    g = (y - kr * r - kb * b) / kg
    return np.stack([r, g, b], axis=-1)


def rgb_to_ycbcr(rgb: np.ndarray, matrix: str = "bt709") -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """R'G'B' to normalised Y', Cb, Cr."""
    kr, kb = MATRICES[matrix]
    kg = 1 - kr - kb
    y = kr * rgb[..., 0] + kg * rgb[..., 1] + kb * rgb[..., 2]
    cb = (rgb[..., 2] - y) / (2 * (1 - kb))
    cr = (rgb[..., 0] - y) / (2 * (1 - kr))
    return y, cb, cr


def luma(rgb: np.ndarray, matrix: str = "bt709") -> np.ndarray:
    """Rec.709 (or other) luma of encoded R'G'B'."""
    return rgb_to_ycbcr(rgb, matrix)[0]


def to_linear(rgb: np.ndarray) -> np.ndarray:
    """Display-referred code values to linear light (sign-preserving, so excursions survive)."""
    return np.sign(rgb) * np.abs(rgb) ** DISPLAY_GAMMA


def from_linear(lin: np.ndarray) -> np.ndarray:
    """Linear light back to display code values."""
    return np.sign(lin) * np.abs(lin) ** (1 / DISPLAY_GAMMA)


def rgb_to_xyz(rgb: np.ndarray) -> np.ndarray:
    """Encoded Rec.709 R'G'B' to CIE XYZ (D65, Y of white = 1)."""
    return to_linear(rgb) @ RGB709_TO_XYZ.T


def xyz_to_lab(xyz: np.ndarray) -> np.ndarray:
    """CIE XYZ to CIE L*a*b* (D65)."""
    t = xyz / D65_WHITE
    f = np.where(t > LAB_EPSILON, np.cbrt(np.maximum(t, 0)), (LAB_KAPPA * t + 16) / 116)
    lightness = 116 * f[..., 1] - 16
    a = 500 * (f[..., 0] - f[..., 1])
    b = 200 * (f[..., 1] - f[..., 2])
    return np.stack([lightness, a, b], axis=-1)


def rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """Encoded Rec.709 R'G'B' to CIE L*a*b*."""
    return xyz_to_lab(rgb_to_xyz(rgb))


def xyz_to_xy(xyz: np.ndarray) -> np.ndarray:
    """CIE XYZ to xy chromaticity (NaN where X+Y+Z is not positive)."""
    total = xyz.sum(axis=-1, keepdims=True)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(total > 1e-9, xyz[..., :2] / total, np.nan)


def delta_e_2000(lab1: np.ndarray, lab2: np.ndarray) -> np.ndarray:
    """CIEDE2000 colour difference (Sharma, Wu and Dalal 2005), vectorised."""
    l1, a1, b1 = lab1[..., 0], lab1[..., 1], lab1[..., 2]
    l2, a2, b2 = lab2[..., 0], lab2[..., 1], lab2[..., 2]
    c1 = np.hypot(a1, b1)
    c2 = np.hypot(a2, b2)
    c_bar7 = ((c1 + c2) / 2) ** 7
    g = 0.5 * (1 - np.sqrt(c_bar7 / (c_bar7 + 25.0**7)))
    a1p = (1 + g) * a1
    a2p = (1 + g) * a2
    c1p = np.hypot(a1p, b1)
    c2p = np.hypot(a2p, b2)
    h1p = np.degrees(np.arctan2(b1, a1p)) % 360
    h2p = np.degrees(np.arctan2(b2, a2p)) % 360
    h1p = np.where((a1p == 0) & (b1 == 0), 0, h1p)
    h2p = np.where((a2p == 0) & (b2 == 0), 0, h2p)
    dl = l2 - l1
    dc = c2p - c1p
    dh = h2p - h1p
    dh = np.where(dh > 180, dh - 360, dh)
    dh = np.where(dh < -180, dh + 360, dh)
    dh = np.where(c1p * c2p == 0, 0, dh)
    d_hue = 2 * np.sqrt(c1p * c2p) * np.sin(np.radians(dh / 2))
    l_bar = (l1 + l2) / 2
    cp_bar = (c1p + c2p) / 2
    h_sum = h1p + h2p
    h_bar = np.where(np.abs(h1p - h2p) > 180, np.where(h_sum < 360, (h_sum + 360) / 2, (h_sum - 360) / 2), h_sum / 2)
    h_bar = np.where(c1p * c2p == 0, h_sum, h_bar)
    t = 1 - 0.17 * np.cos(np.radians(h_bar - 30)) + 0.24 * np.cos(np.radians(2 * h_bar)) + 0.32 * np.cos(np.radians(3 * h_bar + 6)) - 0.20 * np.cos(np.radians(4 * h_bar - 63))
    d_theta = 30 * np.exp(-(((h_bar - 275) / 25) ** 2))
    cp_bar7 = cp_bar**7
    r_c = 2 * np.sqrt(cp_bar7 / (cp_bar7 + 25.0**7))
    s_l = 1 + 0.015 * (l_bar - 50) ** 2 / np.sqrt(20 + (l_bar - 50) ** 2)
    s_c = 1 + 0.045 * cp_bar
    s_h = 1 + 0.015 * cp_bar * t
    r_t = -np.sin(np.radians(2 * d_theta)) * r_c
    return np.sqrt((dl / s_l) ** 2 + (dc / s_c) ** 2 + (d_hue / s_h) ** 2 + r_t * (dc / s_c) * (d_hue / s_h))


def vectorscope_angle(cb: np.ndarray, cr: np.ndarray) -> np.ndarray:
    """Hue as a vectorscope angle in degrees, counter-clockwise from +Cb (red is about 103 degrees)."""
    return np.degrees(np.arctan2(cr, cb)) % 360


def circular_mean_deg(angles: np.ndarray, weights: np.ndarray | None = None) -> float | None:
    """Weighted circular mean of angles in degrees."""
    if angles.size == 0:
        return None
    w = np.ones_like(angles) if weights is None else weights
    s = float(np.sum(w * np.sin(np.radians(angles))))
    c = float(np.sum(w * np.cos(np.radians(angles))))
    if math.hypot(s, c) < 1e-9:
        return None
    return math.degrees(math.atan2(s, c)) % 360


def angle_difference(a: float, b: float) -> float:
    """Signed smallest difference a - b in degrees."""
    return (a - b + 180) % 360 - 180


# ---------------------------------------------------------------------------------------------------------------
# Curves


def monotone_curve(points: list[list[float]], x: np.ndarray) -> np.ndarray:
    """Monotone cubic Hermite interpolation (Fritsch-Carlson) through sorted control points, linear outside."""
    pts = sorted((float(p[0]), float(p[1])) for p in points)
    xs = np.array([p[0] for p in pts])
    ys = np.array([p[1] for p in pts])
    if len(xs) < 2:  # noqa: PLR2004 -- a curve needs two points to define a segment.
        return x + (ys[0] - xs[0] if len(xs) else 0)
    h = np.diff(xs)
    delta = np.diff(ys) / h
    m = np.empty_like(xs)
    m[0], m[-1] = delta[0], delta[-1]
    m[1:-1] = np.where(delta[:-1] * delta[1:] > 0, (delta[:-1] + delta[1:]) / 2, 0)
    for k, d in enumerate(delta):
        if d == 0:
            m[k] = m[k + 1] = 0
            continue
        alpha, beta = m[k] / d, m[k + 1] / d
        radius = alpha * alpha + beta * beta
        if radius > 9:  # noqa: PLR2004 -- Fritsch-Carlson monotonicity bound.
            tau = 3 / math.sqrt(radius)
            m[k], m[k + 1] = tau * alpha * d, tau * beta * d
    idx = np.clip(np.searchsorted(xs, x, side="right") - 1, 0, len(xs) - 2)
    x0, x1 = xs[idx], xs[idx + 1]
    t = (x - x0) / (x1 - x0)
    h00 = (1 + 2 * t) * (1 - t) ** 2
    h10 = t * (1 - t) ** 2
    h01 = t * t * (3 - 2 * t)
    h11 = t * t * (t - 1)
    inside = h00 * ys[idx] + h10 * (x1 - x0) * m[idx] + h01 * ys[idx + 1] + h11 * (x1 - x0) * m[idx + 1]
    below = ys[0] + (x - xs[0]) * m[0]
    above = ys[-1] + (x - xs[-1]) * m[-1]
    return np.where(x < xs[0], below, np.where(x > xs[-1], above, inside))


# ---------------------------------------------------------------------------------------------------------------
# .cube LUTs


def read_cube(path: Path) -> dict[str, Any]:
    """Parse a 3D .cube LUT (Resolve/Adobe): size, domain and an (N, N, N, 3) table indexed [b, g, r]."""
    size = 0
    lo = np.zeros(3)
    hi = np.ones(3)
    rows: list[list[float]] = []
    for raw in path.read_text(encoding="utf8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key = line.split()[0].upper()
        if key == "LUT_3D_SIZE":
            size = int(line.split()[1])
        elif key == "LUT_1D_SIZE":
            message = f"{path.name}: 1D LUTs are not supported; convert it to a 3D .cube"
            raise ValueError(message)
        elif key == "DOMAIN_MIN":
            lo = np.array([float(v) for v in line.split()[1:4]])
        elif key == "DOMAIN_MAX":
            hi = np.array([float(v) for v in line.split()[1:4]])
        elif key in {"TITLE", "LUT_IN_VIDEO_RANGE", "LUT_OUT_VIDEO_RANGE"}:
            continue
        else:
            rows.append([float(v) for v in line.split()[:3]])
    if size < 2 or len(rows) != size**3:  # noqa: PLR2004 -- the smallest usable lattice.
        message = f"{path.name}: expected LUT_3D_SIZE and {size}^3 rows, found {len(rows)}"
        raise ValueError(message)
    table = np.array(rows).reshape(size, size, size, 3)
    return {"size": size, "min": lo, "max": hi, "table": table}


def apply_cube(lut: dict[str, Any], rgb: np.ndarray) -> np.ndarray:
    """Apply a 3D LUT with trilinear interpolation (inputs clamped to the LUT's domain)."""
    size = lut["size"]
    coords = (np.clip(rgb, lut["min"], lut["max"]) - lut["min"]) / (lut["max"] - lut["min"]) * (size - 1)
    i0 = np.clip(np.floor(coords).astype(np.int64), 0, size - 2)
    f = coords - i0
    table = lut["table"]
    r0, g0, b0 = i0[..., 0], i0[..., 1], i0[..., 2]
    fr, fg, fb = f[..., 0:1], f[..., 1:2], f[..., 2:3]
    out = np.zeros_like(rgb, dtype=np.float64)
    for db, wb in ((0, 1 - fb), (1, fb)):
        for dg, wg in ((0, 1 - fg), (1, fg)):
            for dr, wr in ((0, 1 - fr), (1, fr)):
                out += table[b0 + db, g0 + dg, r0 + dr] * (wb * wg * wr)
    return out


def lattice(size: int) -> np.ndarray:
    """The .cube input lattice in file order (red fastest), shape (size^3, 3)."""
    axis = np.linspace(0.0, 1.0, size)
    b, g, r = np.meshgrid(axis, axis, axis, indexing="ij")
    return np.stack([r.ravel(), g.ravel(), b.ravel()], axis=-1)


def write_cube(path: Path, values: np.ndarray, size: int, title: str, comments: list[str]) -> None:
    """Write an (size^3, 3) table in file order as a Resolve-compatible .cube."""
    lines = [f"# {c}" for c in comments]
    lines += [f'TITLE "{title}"', f"LUT_3D_SIZE {size}", "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0"]
    lines += [f"{r:.6f} {g:.6f} {b:.6f}" for r, g, b in np.clip(values, 0, 1)]
    path.write_text("\n".join(lines) + "\n", encoding="utf8")


# ---------------------------------------------------------------------------------------------------------------
# The grade model. Operation order is fixed and documented in docs/colour-grading.md.


def _soft(x: np.ndarray, lo: float, hi: float, softness: float) -> np.ndarray:
    """1 inside [lo, hi], a smoothstep fall-off of width `softness` outside."""
    if softness <= 0:
        return ((x >= lo) & (x <= hi)).astype(np.float64)
    below = np.clip((x - (lo - softness)) / softness, 0, 1)
    above = np.clip(((hi + softness) - x) / softness, 0, 1)
    w = np.minimum(below, above)
    return w * w * (3 - 2 * w)


def qualifier_mask(rgb: np.ndarray, qualifier: dict[str, Any]) -> np.ndarray:
    """HSL qualifier key in vectorscope terms: hue angle, chroma (0..1 of a 100% saturated colour) and luma."""
    y, cb, cr = rgb_to_ycbcr(rgb)
    mask = np.ones(y.shape)
    hue = qualifier.get("hue")
    if hue:
        angle = vectorscope_angle(cb, cr)
        dist = np.abs((angle - hue["center"] + 180) % 360 - 180)
        mask *= _soft(dist, -1.0, hue["width"] / 2, hue.get("softness", 0))
    sat = qualifier.get("saturation")
    if sat:
        chroma = np.hypot(cb, cr) / 0.5
        mask *= _soft(chroma, sat["min"], sat["max"], sat.get("softness", 0))
    lum = qualifier.get("luma")
    if lum:
        mask *= _soft(y, lum["min"], lum["max"], lum.get("softness", 0))
    return mask


def apply_secondary(rgb: np.ndarray, secondary: dict[str, Any]) -> np.ndarray:
    """One qualified correction: hue rotation, hue pull toward an angle, chroma gain and luma offset."""
    mask = qualifier_mask(rgb, secondary.get("qualifier", {})) * secondary.get("strength", 1.0)
    if not np.any(mask):
        return rgb
    y, cb, cr = rgb_to_ycbcr(rgb)
    radius = np.hypot(cb, cr)
    angle = vectorscope_angle(cb, cr)
    shift = secondary.get("hueShift", 0.0)
    toward = secondary.get("hueToward")
    if toward:
        shift = shift + ((toward["angle"] - angle + 180) % 360 - 180) * toward["amount"]
    angle = angle + shift * mask
    radius = radius * (1 + (secondary.get("saturation", 1.0) - 1) * mask)
    y = y + secondary.get("luma", 0.0) * mask
    cb = radius * np.cos(np.radians(angle))
    cr = radius * np.sin(np.radians(angle))
    return ycbcr_to_rgb(y, cb, cr, "bt709")


def white_balance_gains(temperature: float, tint: float) -> np.ndarray:
    """Linear-light channel gains for temperature (+ warmer) and tint (+ magenta), luminance-normalised.

    One unit of temperature is half a stop between red and blue; one unit of tint is a quarter stop of green.
    """
    gains = np.array([2 ** (temperature / 4), 2 ** (-tint / 4), 2 ** (-temperature / 4)])
    return gains / float(RGB709_TO_XYZ[1] @ gains)


def apply_grade(rgb: np.ndarray, grade: dict[str, Any], luts: dict[str, dict[str, Any]] | None = None) -> np.ndarray:  # noqa: C901, PLR0912 -- one branch per documented grade stage, in order.
    """Apply a normalised grade (see src/types/colour.ts) to encoded R'G'B'."""
    out = np.asarray(rgb, dtype=np.float64)
    luts = luts or {}

    def lut_stage(position: str) -> None:
        nonlocal out
        for entry in grade.get("luts", []):
            if entry.get("position", "look") == position:
                graded = apply_cube(luts[entry["path"]], out)
                out = out + (graded - out) * entry.get("strength", 1.0)

    lut_stage("input")
    wb = grade.get("whiteBalance")
    exposure = grade.get("exposure", 0.0)
    if wb or exposure:
        gains = white_balance_gains(wb.get("temperature", 0.0), wb.get("tint", 0.0)) if wb else np.ones(3)
        out = from_linear(to_linear(out) * gains * 2.0**exposure)
    if "offset" in grade:
        out = out + np.asarray(grade["offset"])
    if any(k in grade for k in ("lift", "gamma", "gain")):
        lift = np.asarray(grade.get("lift", [0, 0, 0]))
        gain = np.asarray(grade.get("gain", [1, 1, 1]))
        gamma = np.asarray(grade.get("gamma", [1, 1, 1]))
        out = gain * (out + lift * (1 - out))
        out = np.sign(out) * np.abs(out) ** (1 / gamma)
    contrast = grade.get("contrast")
    if contrast:
        pivot = contrast.get("pivot", 0.435)
        out = (out - pivot) * contrast["amount"] + pivot
    curves = grade.get("curves") or {}
    if curves.get("master"):
        out = monotone_curve(curves["master"], out)
    for channel, key in enumerate(("r", "g", "b")):
        if curves.get(key):
            out[..., channel] = monotone_curve(curves[key], out[..., channel])
    saturation = grade.get("saturation")
    if saturation is not None and saturation != 1:
        y = luma(out)[..., None]
        out = y + (out - y) * saturation
    for secondary in grade.get("secondaries", []):
        out = apply_secondary(out, secondary)
    lut_stage("look")
    soft = grade.get("softClip")
    if soft:
        high = soft.get("high")
        if high is not None and high < 1:
            span = 1 - high
            out = np.where(out > high, high + span * np.tanh((out - high) / span), out)
        low = soft.get("low")
        if low is not None and low > 0:
            out = np.where(out < low, low - low * np.tanh((low - out) / low), out)
    lut_stage("output")
    return np.clip(out, 0.0, 1.0)


def load_luts(grade: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Read every LUT a grade names (paths are absolute by the time the worker sees them)."""
    return {entry["path"]: read_cube(Path(entry["path"])) for entry in grade.get("luts", [])}


# ---------------------------------------------------------------------------------------------------------------
# Measurement helpers shared by scopes, compare and match.


def rank_zones(lightness: np.ndarray) -> dict[str, np.ndarray]:
    """Shadows, mids and highlights by each image's own L* rank (bottom 25%, middle 50%, top 25%)."""
    lo, hi = np.percentile(lightness, [25, 75])
    return {"shadows": lightness <= lo, "mids": (lightness > lo) & (lightness < hi), "highlights": lightness >= hi}


def zone_summary(lab: np.ndarray) -> dict[str, dict[str, float]]:
    """Mean L*, a*, b* and chroma per rank zone."""
    out: dict[str, dict[str, float]] = {}
    for name, mask in rank_zones(lab[:, 0]).items():
        sel = lab[mask] if mask.any() else lab
        out[name] = {
            "L": float(sel[:, 0].mean()),
            "a": float(sel[:, 1].mean()),
            "b": float(sel[:, 2].mean()),
            "C": float(np.hypot(sel[:, 1], sel[:, 2]).mean()),
        }
    return out


def neutral_cast(lab: np.ndarray) -> dict[str, float]:
    """Mean a*/b* of near-neutral pixels (C* below 12, L* 15..95): the white-balance cast."""
    chroma = np.hypot(lab[:, 1], lab[:, 2])
    mask = (chroma < 12) & (lab[:, 0] > 15) & (lab[:, 0] < 95)  # noqa: PLR2004 -- neutral-pixel window.
    sel = lab[mask] if mask.sum() > 50 else lab  # noqa: PLR2004 -- too few neutrals: fall back to all pixels.
    return {"a": float(sel[:, 1].mean()), "b": float(sel[:, 2].mean()), "pixelsPct": float(100 * mask.mean())}


def match_features(lab: np.ndarray) -> np.ndarray:
    """The statistics a reference match fits: L* quantiles, per-zone a*/b*, chroma quantiles and zone chroma."""
    quantiles = np.percentile(lab[:, 0], [1, 5, 10, 25, 50, 75, 90, 95, 99])
    zones = zone_summary(lab)
    chroma = np.hypot(lab[:, 1], lab[:, 2])
    cq = np.percentile(chroma, [25, 50, 75, 90])
    zone_ab = [zones[z][k] for z in ("shadows", "mids", "highlights") for k in ("a", "b")]
    zone_c = [zones[z]["C"] for z in ("shadows", "mids", "highlights")]
    return np.concatenate([quantiles, np.array(zone_ab) * 1.5, cq * 0.8, np.array(zone_c) * 0.6])
