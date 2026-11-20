"""Scope renderers for the colour worker: waveform, RGB parade, vectorscope, histogram, CIE 1931 xy and false colour.

Images are RGB uint8 arrays drawn with NumPy and OpenCV's Hershey fonts only, so a scope is a pure function of its
input pixels. The look follows a grading suite's scopes: black ground, amber graticule, 10-bit code labels.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

import cv2
import numpy as np

import colour_maths as cm

if TYPE_CHECKING:
    from collections.abc import Sequence

GROUND = (11, 11, 12)
GRATICULE = (150, 118, 40)
GRATICULE_DIM = (70, 56, 22)
LABEL = (205, 170, 80)
TEXT = (225, 225, 225)
MUTED = (140, 140, 140)
FONT = cv2.FONT_HERSHEY_SIMPLEX
# Scope value range: limited-range code 0..255 mapped to the normalised scale, so super-whites and sub-blacks show.
V_MIN = -16 / 219
V_MAX = 239 / 219
CHANNEL_COLOURS = ((235, 60, 60), (60, 220, 80), (70, 110, 255))

# CIE 1931 2-degree spectral locus, xy at selected wavelengths (380-700 nm).
SPECTRAL_LOCUS = (
    (0.1741, 0.0050), (0.1738, 0.0049), (0.1733, 0.0048), (0.1726, 0.0048), (0.1714, 0.0051), (0.1689, 0.0069),
    (0.1644, 0.0109), (0.1566, 0.0177), (0.1440, 0.0297), (0.1241, 0.0578), (0.1096, 0.0868), (0.0913, 0.1327),
    (0.0687, 0.2007), (0.0454, 0.2950), (0.0235, 0.4127), (0.0082, 0.5384), (0.0039, 0.6548), (0.0139, 0.7502),
    (0.0389, 0.8120), (0.0743, 0.8338), (0.1142, 0.8262), (0.1547, 0.8059), (0.1929, 0.7816), (0.2296, 0.7543),
    (0.2658, 0.7243), (0.3016, 0.6923), (0.3373, 0.6589), (0.3731, 0.6245), (0.4087, 0.5896), (0.4441, 0.5547),
    (0.4788, 0.5202), (0.5125, 0.4866), (0.5448, 0.4544), (0.5752, 0.4242), (0.6029, 0.3965), (0.6270, 0.3725),
    (0.6658, 0.3340), (0.6915, 0.3083), (0.7079, 0.2920), (0.7190, 0.2809), (0.7260, 0.2740), (0.7300, 0.2700),
    (0.7334, 0.2666), (0.7347, 0.2653),
)  # fmt: skip

# ARRI-style false colour: (low %, high %, colour, label). Everything else shows as greyscale luma.
FALSE_COLOUR_ZONES = (
    (-100.0, 2.5, (150, 40, 190), "crushed <2.5"),
    (2.5, 4.0, (40, 70, 230), "black 2.5-4"),
    (38.0, 42.0, (40, 200, 60), "18% grey 38-42"),
    (52.0, 56.0, (240, 120, 180), "skin +1 stop 52-56"),
    (97.0, 99.0, (240, 220, 40), "near clip 97-99"),
    (99.0, 1000.0, (230, 40, 40), "clipped >99"),
)


def canvas(width: int, height: int) -> np.ndarray:
    """A blank scope ground."""
    img = np.empty((height, width, 3), dtype=np.uint8)
    img[:] = GROUND
    return img


def text(img: np.ndarray, value: str, org: tuple[int, int], scale: float = 0.45, colour: Sequence[int] = TEXT, thickness: int = 1) -> None:
    """Draw anti-aliased Hershey text."""
    cv2.putText(img, value, org, FONT, scale, tuple(int(c) for c in colour), thickness, cv2.LINE_AA)


def _intensity(counts: np.ndarray, gamma: float = 0.9, ceiling: float = 0.85) -> np.ndarray:
    """Log-scaled trace brightness, normalised by a high percentile so a few hot bins do not dim the rest."""
    nonzero = counts[counts > 0]
    if nonzero.size == 0:
        return np.zeros(counts.shape)
    top = max(float(np.percentile(nonzero, 99.9)), 1.0)
    return ceiling * np.clip(np.log1p(counts) / math.log1p(top), 0, 1) ** gamma


def _dither(shape: tuple[int, ...], amount: float) -> np.ndarray:
    """Seeded sub-code dither: 8-bit sources otherwise draw as horizontal stripes on a 400-row scope."""
    return (np.random.default_rng(1709).random(shape) - 0.5) * amount


def _value_row(values: np.ndarray, top: int, height: int) -> np.ndarray:
    return top + np.clip(((V_MAX - values) / (V_MAX - V_MIN) * (height - 1)).round().astype(np.int64), 0, height - 1)


def _wave_graticule(img: np.ndarray, rect: tuple[int, int, int, int], *, labels: bool) -> None:
    x, y, w, h = rect
    for code in range(0, 1024, 128):
        row = int(_value_row(np.array([code / 1023]), y, h)[0])
        cv2.line(img, (x, row), (x + w - 1, row), GRATICULE_DIM, 1)
        if labels:
            text(img, str(code), (4, row + 4), 0.4, LABEL)
    for value in (0.0, 1.0):
        row = int(_value_row(np.array([value]), y, h)[0])
        cv2.line(img, (x, row), (x + w - 1, row), GRATICULE, 1)
    if labels:
        row = int(_value_row(np.array([1023 / 1023]), y, h)[0])
        text(img, "1023", (4, row + 4), 0.4, LABEL)


def _trace(img: np.ndarray, rect: tuple[int, int, int, int], frames: Sequence[np.ndarray], colour: Sequence[int]) -> None:
    """Accumulate one channel's waveform across frames into a rectangle, additively."""
    x, y, w, h = rect
    counts = np.zeros(h * w)
    for values in frames:
        rows, cols = values.shape
        col = (np.arange(cols) * w // cols).astype(np.int64)
        row = _value_row(values + _dither(values.shape, 1 / 219), 0, h)
        counts += np.bincount((row * w + col[None, :]).ravel(), minlength=h * w)
    glow = _intensity(counts.reshape(h, w))[..., None] * np.asarray(colour, dtype=np.float64)
    region = img[y : y + h, x : x + w].astype(np.float64)
    img[y : y + h, x : x + w] = np.clip(region + glow, 0, 255).astype(np.uint8)


def waveform(channels: Sequence[tuple[Sequence[np.ndarray], Sequence[int]]], title: str, size: tuple[int, int] = (1024, 512)) -> np.ndarray:
    """Waveform: one or several channels overlaid, 10-bit labels, legal-range lines at 0 and 1023."""
    width, height = size
    img = canvas(width, height)
    rect = (52, 30, width - 62, height - 42)
    _wave_graticule(img, rect, labels=True)
    for frames, colour in channels:
        _trace(img, rect, frames, colour)
    text(img, title, (52, 20), 0.55, TEXT)
    return img


def parade(rgb_frames: Sequence[np.ndarray], size: tuple[int, int] = (1024, 512)) -> np.ndarray:
    """RGB parade: red, green and blue waveforms side by side."""
    width, height = size
    img = canvas(width, height)
    left, top, gap = 52, 30, 10
    panel = (width - left - 10 - 2 * gap) // 3
    for index, colour in enumerate(CHANNEL_COLOURS):
        rect = (left + index * (panel + gap), top, panel, height - 42)
        _wave_graticule(img, rect, labels=index == 0)
        _trace(img, rect, [f[..., index] for f in rgb_frames], colour)
    text(img, "RGB parade", (52, 20), 0.55, TEXT)
    return img


def _bar_targets() -> list[tuple[str, float, float]]:
    """75% colour-bar targets (label, Cb, Cr) computed from the Rec.709 matrix."""
    bars = {"R": (1, 0, 0), "Yl": (1, 1, 0), "G": (0, 1, 0), "Cy": (0, 1, 1), "B": (0, 0, 1), "Mg": (1, 0, 1)}
    out = []
    for label, rgb in bars.items():
        _, cb, cr = cm.rgb_to_ycbcr(np.array(rgb, dtype=np.float64) * 0.75)
        out.append((label, float(cb), float(cr)))
    return out


def vectorscope(cb_frames: Sequence[np.ndarray], cr_frames: Sequence[np.ndarray], rgb_frames: Sequence[np.ndarray], *, zoom: float = 1.0, size: int = 640, overlay: Sequence[tuple[Sequence[np.ndarray], Sequence[np.ndarray], Sequence[int]]] = ()) -> np.ndarray:
    """Vectorscope with 75% targets and the skin-tone line; trace coloured by the pixels' own colour.

    With `overlay`, each (cb, cr, colour) set is drawn in a flat colour instead (input against reference).
    """
    img = canvas(size, size + 30)
    cx, cy = size // 2, size // 2 + 30
    radius = size * 0.44
    scale = radius / 0.55 * zoom
    cv2.circle(img, (cx, cy), int(radius), GRATICULE, 1, cv2.LINE_AA)
    cv2.line(img, (cx - int(radius), cy), (cx + int(radius), cy), GRATICULE_DIM, 1)
    cv2.line(img, (cx, cy - int(radius)), (cx, cy + int(radius)), GRATICULE_DIM, 1)
    for deg in range(0, 360, 10):
        a = math.radians(deg)
        inner = radius * (0.95 if deg % 30 else 0.9)
        p0 = (int(cx + inner * math.cos(a)), int(cy - inner * math.sin(a)))
        p1 = (int(cx + radius * math.cos(a)), int(cy - radius * math.sin(a)))
        cv2.line(img, p0, p1, GRATICULE, 1, cv2.LINE_AA)
    skin = math.radians(cm.SKIN_LINE_DEG)
    cv2.line(img, (cx, cy), (int(cx + radius * math.cos(skin)), int(cy - radius * math.sin(skin))), LABEL, 1, cv2.LINE_AA)
    text(img, "skin", (int(cx + (radius + 6) * math.cos(skin)) - 18, int(cy - (radius + 6) * math.sin(skin))), 0.42, LABEL)
    for label, cb, cr in _bar_targets():
        px, py = int(cx + cb * scale), int(cy - cr * scale)
        if abs(px - cx) < radius and abs(py - cy) < radius:
            cv2.rectangle(img, (px - 7, py - 7), (px + 7, py + 7), GRATICULE, 1)
            text(img, label, (px + 10, py + 4), 0.42, LABEL)
    ground = img.astype(np.float64)
    sets = [(cb_frames, cr_frames, None)] if not overlay else [(o[0], o[1], o[2]) for o in overlay]
    for cbs, crs, flat in sets:
        counts = np.zeros(size * size)
        colour_sum = np.zeros((size * size, 3))
        for index, (cb_raw, cr_raw) in enumerate(zip(cbs, crs, strict=True)):
            cb = (cb_raw + _dither(cb_raw.shape, 1 / 224)).ravel() * scale
            cr = (cr_raw + _dither(cr_raw.shape, 1 / 224)[::-1]).ravel() * scale
            inside = np.hypot(cb, cr) <= radius
            col = np.clip((cx + cb[inside]).round().astype(np.int64), 0, size - 1)
            row = np.clip((size // 2 - cr[inside]).round().astype(np.int64), 0, size - 1)
            key = row * size + col
            counts += np.bincount(key, minlength=size * size)
            if flat is None:
                rgb = np.clip(rgb_frames[index].reshape(-1, 3), 0, 1)[inside]
                for ch in range(3):
                    colour_sum[:, ch] += np.bincount(key, weights=rgb[:, ch], minlength=size * size)
        glow = _intensity(counts.reshape(size, size), gamma=0.45, ceiling=1.0)
        if flat is None:
            mean = colour_sum / np.maximum(counts, 1)[:, None]
            tint = mean / np.maximum(mean.max(axis=1, keepdims=True), 1e-6)
            tint = 0.35 + 0.65 * tint
            layer = glow[..., None] * tint.reshape(size, size, 3) * 255
        else:
            layer = glow[..., None] * np.asarray(flat, dtype=np.float64)
        ground[30 : 30 + size] += layer
    img = np.clip(ground, 0, 255).astype(np.uint8)
    text(img, f"Vectorscope {zoom:g}x  (75% targets, skin line {cm.SKIN_LINE_DEG:g} deg)", (10, 20), 0.5, TEXT)
    return img


def histogram(rgb_frames: Sequence[np.ndarray], luma_frames: Sequence[np.ndarray], size: tuple[int, int] = (1024, 512)) -> np.ndarray:
    """Stacked R, G, B and luma histograms over 0..1023 with clipping spikes at the edges."""
    width, height = size
    img = canvas(width, height)
    left, top = 40, 30
    w = width - left - 10
    rows = 4
    row_h = (height - top - 24) // rows
    bins = w
    series = [([f[..., i] for f in rgb_frames], CHANNEL_COLOURS[i], "RGB"[i]) for i in range(3)]
    series.append((list(luma_frames), (220, 220, 220), "Y"))
    for index, (frames, colour, label) in enumerate(series):
        values = np.concatenate([np.clip(f.ravel(), 0, 1) for f in frames])
        counts = np.bincount(np.clip((values * (bins - 1)).round().astype(np.int64), 0, bins - 1), minlength=bins).astype(np.float64)
        inner = counts[2:-2]
        peak = max(float(np.percentile(inner[inner > 0], 99)) if np.any(inner > 0) else 1.0, 1.0)
        heights = np.clip(counts / peak, 0, 1) * (row_h - 6)
        y0 = top + (index + 1) * row_h
        for code in range(0, 1024, 128):
            xpix = left + int(code / 1023 * (bins - 1))
            cv2.line(img, (xpix, y0 - row_h + 2), (xpix, y0), GRATICULE_DIM, 1)
        cv2.line(img, (left, y0), (left + w - 1, y0), GRATICULE, 1)
        fill = np.asarray(colour, dtype=np.float64) * 0.45
        for xi in range(bins):
            hgt = int(heights[xi])
            if hgt > 0:
                img[y0 - hgt : y0, left + xi] = fill.astype(np.uint8)
        pts = np.stack([left + np.arange(bins), y0 - heights.astype(np.int64)], axis=1).astype(np.int32)
        cv2.polylines(img, [pts], isClosed=False, color=tuple(int(c) for c in colour), thickness=1, lineType=cv2.LINE_AA)
        text(img, label, (12, y0 - row_h // 2 + 5), 0.5, colour)
    for code in range(0, 1024, 128):
        xpix = left + int(code / 1023 * (bins - 1))
        text(img, str(code), (xpix - 10, height - 6), 0.38, LABEL)
    text(img, "Histogram", (left, 20), 0.55, TEXT)
    return img


def cie_chromaticity(rgb_frames: Sequence[np.ndarray], size: int = 640) -> np.ndarray:
    """CIE 1931 xy chromaticity of the pixels with the spectral locus and Rec.709, P3 and Rec.2020 triangles."""
    img = canvas(size, size + 30)
    left, top = 44, 40
    plot = size - left - 16
    x_max, y_max = 0.8, 0.9

    def to_px(x: np.ndarray | float, y: np.ndarray | float) -> tuple[np.ndarray, np.ndarray]:
        px = left + np.asarray(x) / x_max * plot
        py = top + plot - np.asarray(y) / y_max * plot
        return px, py

    for tick in range(9):
        value = tick / 10
        px, _ = to_px(value, 0)
        _, py = to_px(0, value)
        cv2.line(img, (int(px), top), (int(px), top + plot), GRATICULE_DIM, 1)
        cv2.line(img, (left, int(py)), (left + plot, int(py)), GRATICULE_DIM, 1)
        text(img, f"{value:.1f}", (int(px) - 10, top + plot + 16), 0.36, LABEL)
        text(img, f"{value:.1f}", (6, int(py) + 4), 0.36, LABEL)
    locus = np.array(SPECTRAL_LOCUS)
    lx, ly = to_px(locus[:, 0], locus[:, 1])
    pts = np.stack([lx, ly], axis=1).round().astype(np.int32)
    cv2.polylines(img, [pts], isClosed=True, color=(200, 200, 200), thickness=1, lineType=cv2.LINE_AA)
    ground = img.astype(np.float64)
    counts = np.zeros(size * size)
    colour_sum = np.zeros((size * size, 3))
    for frame in rgb_frames:
        rgb = frame.reshape(-1, 3)
        xyz = cm.rgb_to_xyz(rgb)
        keep = xyz[:, 1] > 0.002  # noqa: PLR2004 -- below this luminance chromaticity is noise.
        xy = cm.xyz_to_xy(xyz[keep])
        ok = np.isfinite(xy).all(axis=1)
        px, py = to_px(xy[ok, 0], xy[ok, 1])
        col = np.clip(px.round().astype(np.int64), 0, size - 1)
        row = np.clip(py.round().astype(np.int64), 0, size - 1)
        key = row * size + col
        counts += np.bincount(key, minlength=size * size)
        src = np.clip(rgb[keep][ok], 0, 1)
        for ch in range(3):
            colour_sum[:, ch] += np.bincount(key, weights=src[:, ch], minlength=size * size)
    glow = _intensity(counts.reshape(size, size), gamma=0.45, ceiling=1.0)
    mean = colour_sum / np.maximum(counts, 1)[:, None]
    tint = 0.35 + 0.65 * mean / np.maximum(mean.max(axis=1, keepdims=True), 1e-6)
    layer = glow[..., None] * tint.reshape(size, size, 3) * 255
    ground[: size] += layer[: size]
    img = np.clip(ground, 0, 255).astype(np.uint8)
    for primaries, colour, label in (
        (cm.REC2020_PRIMARIES_XY, (90, 90, 90), "Rec.2020"),
        (cm.P3_PRIMARIES_XY, (110, 110, 150), "P3"),
        (cm.REC709_PRIMARIES_XY, GRATICULE, "Rec.709"),
    ):
        tri = np.array(primaries)
        tx, ty = to_px(tri[:, 0], tri[:, 1])
        cv2.polylines(img, [np.stack([tx, ty], axis=1).round().astype(np.int32)], isClosed=True, color=colour, thickness=1, lineType=cv2.LINE_AA)
        text(img, label, (int(tx[0]) + 6, int(ty[0]) + (14 if label == "Rec.709" else -4)), 0.38, colour)
    wx, wy = to_px(cm.D65_XY[0], cm.D65_XY[1])
    cv2.drawMarker(img, (int(wx), int(wy)), (255, 255, 255), cv2.MARKER_CROSS, 10, 1)
    text(img, "D65", (int(wx) + 6, int(wy) - 6), 0.38, (255, 255, 255))
    text(img, "CIE 1931 xy chromaticity", (10, 20), 0.5, TEXT)
    return img


def false_colour(rgb: np.ndarray, luma_values: np.ndarray) -> tuple[np.ndarray, dict[str, float]]:
    """ARRI-style false colour image plus a legend, and the percentage of pixels in each zone."""
    ire = luma_values * 100
    grey = np.clip(luma_values, 0, 1)[..., None] * np.array([1.0, 1.0, 1.0]) * 255 * 0.85
    out = grey.copy()
    share: dict[str, float] = {}
    for low, high, colour, label in FALSE_COLOUR_ZONES:
        mask = (ire >= low) & (ire < high)
        out[mask] = colour
        share[label] = round(float(100 * mask.mean()), 3)
    height, width = luma_values.shape
    legend_h = 34
    img = canvas(width, height + legend_h)
    img[:height] = np.clip(out, 0, 255).astype(np.uint8)
    cell = width // len(FALSE_COLOUR_ZONES)
    for index, (_, _, colour, label) in enumerate(FALSE_COLOUR_ZONES):
        x0 = index * cell
        cv2.rectangle(img, (x0 + 4, height + 8), (x0 + 18, height + 22), colour, -1)
        text(img, label, (x0 + 22, height + 20), 0.36 if width < 1200 else 0.42, TEXT)  # noqa: PLR2004 -- legend fits narrow frames.
    _ = rgb
    return img, share


def frame_tile(rgb: np.ndarray, label: str, crop: tuple[int, int, int, int] | None = None) -> np.ndarray:
    """The analysed frame (display-clipped) with the active-picture rectangle and a label."""
    img = (np.clip(rgb, 0, 1) * 255).round().astype(np.uint8).copy()
    if crop is not None:
        x, y, w, h = crop
        if (w, h) != (img.shape[1], img.shape[0]):
            cv2.rectangle(img, (x, y), (x + w - 1, y + h - 1), GRATICULE, 1)
    banner = canvas(img.shape[1], 26)
    text(banner, label, (8, 18), 0.5, TEXT)
    return np.vstack([banner, img])


def fit(img: np.ndarray, width: int, height: int) -> np.ndarray:
    """Letterbox an image into a cell without distortion."""
    h, w = img.shape[:2]
    scale = min(width / w, height / h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
    cell = canvas(width, height)
    y0, x0 = (height - nh) // 2, (width - nw) // 2
    cell[y0 : y0 + nh, x0 : x0 + nw] = resized
    return cell


def text_panel(lines: Sequence[str], width: int, height: int, title: str = "Measurements") -> np.ndarray:
    """A block of measurement lines."""
    img = canvas(width, height)
    text(img, title, (12, 24), 0.55, TEXT)
    y = 50
    for line in lines:
        if y > height - 8:
            break
        colour = LABEL if line.startswith("#") else TEXT
        text(img, line.lstrip("# "), (12, y), 0.44, colour)
        y += 20
    return img


def grid(cells: Sequence[Sequence[np.ndarray]], cell: tuple[int, int], title: str, gap: int = 6) -> np.ndarray:
    """Compose rows of images into one contact sheet with a title bar."""
    cw, ch = cell
    columns = max(len(row) for row in cells)
    width = columns * cw + (columns + 1) * gap
    rows_img = [canvas(width, 40)]
    text(rows_img[0], title, (gap + 4, 27), 0.65, TEXT, 1)
    for row in cells:
        line = canvas(width, ch + gap)
        for index, img in enumerate(row):
            x0 = gap + index * (cw + gap)
            line[gap:, x0 : x0 + cw] = fit(img, cw, ch)
        rows_img.append(line)
    rows_img.append(canvas(width, gap))
    return np.vstack(rows_img)


def write_png(path: str, img: np.ndarray) -> None:
    """Write an RGB image as PNG (OpenCV stores BGR)."""
    if not cv2.imwrite(path, cv2.cvtColor(img, cv2.COLOR_RGB2BGR)):
        message = f"could not write {path}"
        raise OSError(message)
