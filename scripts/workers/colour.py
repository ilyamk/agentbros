"""Colour worker: scopes, comparisons, reference matches, shot consistency and LUT bakes.

Spawned by src/lib/colour/worker.ts as `colour.py <operation> <request.json>`; prints one JSON object on stdout.
Frames are decoded by ffmpeg to planar Y'CbCr at their native code values and converted here with the stated
matrix and range, so the numbers do not depend on ffmpeg's untagged-input defaults and excursions survive.
"""

from __future__ import annotations

import json
import math
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import colour_craft as cc
import colour_maths as cm
import colour_scopes as sc

FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"
CELL = (720, 405)
MAX_STAT_PIXELS = 300_000
YUV_PREFIXES = ("yuv", "nv", "p01", "p21", "y2", "uyvy", "yuyv", "v210")


def fail(message: str) -> None:
    """Report a request error as JSON and exit non-zero."""
    sys.stdout.write(json.dumps({"ok": False, "error": message}) + "\n")
    raise SystemExit(2)


def run(cmd: list[str]) -> bytes:
    """Run ffmpeg/ffprobe with a literal argument list."""
    result = subprocess.run(cmd, capture_output=True, check=False)  # noqa: S603 -- literal argument list, no shell.
    if result.returncode != 0:
        fail(f"{Path(cmd[0]).name} failed: {result.stderr.decode('utf8', 'replace')[-600:]}")
    return result.stdout


# ---------------------------------------------------------------------------------------------------------------
# Decoding


def probe(path: str) -> dict[str, Any]:
    """Stream facts that decide decoding: size, pixel format, colour tags, duration and frame rate."""
    raw = run(
        [
            FFPROBE,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,width,height,pix_fmt,color_space,color_range,color_transfer,color_primaries,r_frame_rate,duration:format=duration,format_name",
            "-of",
            "json",
            path,
        ]
    )
    data = json.loads(raw)
    if not data.get("streams"):
        fail(f"{path}: no video stream")
    stream = data["streams"][0]
    duration = stream.get("duration") or data.get("format", {}).get("duration")
    num, _, den = str(stream.get("r_frame_rate", "0/1")).partition("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 0.0
    still = stream.get("codec_name") in {"png", "mjpeg", "tiff", "bmp", "webp", "jpegxl", "dpx", "exr"} and (not duration or float(duration) < 0.05)  # noqa: PLR2004 -- one-frame stream.
    return {
        "codec": stream.get("codec_name"),
        "width": int(stream["width"]),
        "height": int(stream["height"]),
        "pixFmt": stream.get("pix_fmt", ""),
        "colorSpace": stream.get("color_space"),
        "colorRange": stream.get("color_range"),
        "colorTransfer": stream.get("color_transfer"),
        "colorPrimaries": stream.get("color_primaries"),
        "duration": float(duration) if duration and not still else 0.0,
        "fps": round(fps, 4),
        "still": still,
    }


def colour_tags(info: dict[str, Any], overrides: dict[str, Any]) -> dict[str, Any]:
    """Matrix, range and bit depth to decode with; untagged streams get the HD/SD convention and say so."""
    pix = info["pixFmt"]
    yuv = pix.startswith(YUV_PREFIXES)
    depth = re.search(r"p(\d+)(?:le|be)$", pix) or re.search(r"^p0(\d)\d", pix)
    bits = int(depth.group(1)) if depth else 8
    if pix.startswith("p01"):
        bits = 10
    assumed: list[str] = []
    space = info.get("colorSpace") or "unknown"
    mapping = {"bt709": "bt709", "smpte170m": "bt601", "bt470bg": "bt601", "bt2020nc": "bt2020", "bt2020c": "bt2020"}
    jpeg = pix.startswith("yuvj") or info.get("codec") == "mjpeg"
    if overrides.get("matrix"):
        matrix = overrides["matrix"]
    elif space in mapping:
        matrix = mapping[space]
    else:
        hd = info["width"] >= 1280 or info["height"] > 576  # noqa: PLR2004 -- the common HD/SD convention.
        matrix = "bt601" if jpeg else ("bt709" if hd else "bt601")
        if yuv:
            assumed.append(f"matrix {matrix} (stream untagged)")
    colour_range = info.get("colorRange") or "unknown"
    if overrides.get("range"):
        full = overrides["range"] == "full"
    elif colour_range in {"tv", "pc"}:
        full = colour_range == "pc"
    else:
        full = jpeg
        if yuv:
            assumed.append(f"range {'full' if full else 'limited'} (stream untagged)")
    transfer = info.get("colorTransfer") or "unknown"
    if transfer not in {"bt709", "unknown", "iec61966-2-1", "smpte170m", "bt470bg", "gamma22", "gamma28"}:
        assumed.append(f"transfer {transfer} treated as Rec.709 display gamma; scopes of log or HDR footage need a conversion LUT first")
    return {"kind": "yuv" if yuv else "rgb", "matrix": matrix, "range": "full" if full else "limited", "bits": bits, "assumed": assumed, "tagged": space in mapping}


def analysis_size(info: dict[str, Any], max_width: int) -> tuple[int, int]:
    """Analysis frame size: at most max_width wide, even dimensions."""
    width, height = info["width"], info["height"]
    if width > max_width:
        height = round(height * max_width / width)
        width = max_width
    return width - width % 2, height - height % 2


def read_frame(path: str, at: float | None, info: dict[str, Any], tags: dict[str, Any], size: tuple[int, int]) -> dict[str, Any]:
    """Decode one frame to unclipped R'G'B' plus its legal-range statistics."""
    width, height = size
    scale = [] if (width, height) == (info["width"], info["height"]) else ["-vf", f"scale={width}:{height}:flags=area"]
    seek = [] if at is None else ["-ss", f"{at:.4f}"]
    if tags["kind"] == "yuv":
        fmt = "yuv444p" if tags["bits"] <= 8 else ("yuv444p10le" if tags["bits"] <= 10 else "yuv444p12le")  # noqa: PLR2004 -- native bit depths.
        raw = run([FFMPEG, "-v", "error", "-nostdin", *seek, "-i", path, "-frames:v", "1", *scale, "-f", "rawvideo", "-pix_fmt", fmt, "-"])
        dtype = np.uint8 if fmt == "yuv444p" else np.dtype("<u2")
        planes = np.frombuffer(raw, dtype=dtype)
        if planes.size < 3 * width * height:
            fail(f"{path}: no frame decoded at {at}s")
        planes = planes[: 3 * width * height].reshape(3, height, width).astype(np.float64)
        bits = 8 if fmt == "yuv444p" else (10 if fmt == "yuv444p10le" else 12)
        step = 2 ** (bits - 8)
        codes = planes / step
        if tags["range"] == "limited":
            y = (codes[0] - 16) / 219
            cb = (codes[1] - 128) / 224
            cr = (codes[2] - 128) / 224
            legal = {
                "yBelowPct": float(100 * (codes[0] < 16).mean()),  # noqa: PLR2004 -- limited-range black.
                "yAbovePct": float(100 * (codes[0] > 235).mean()),  # noqa: PLR2004 -- limited-range white.
                "chromaOutPct": float(100 * ((codes[1:] < 16) | (codes[1:] > 240)).any(axis=0).mean()),  # noqa: PLR2004 -- limited chroma.
            }
        else:
            top = 2**bits - 1
            y = planes[0] / top
            cb = (planes[1] - 2 ** (bits - 1)) / top
            cr = (planes[2] - 2 ** (bits - 1)) / top
            legal = None
        rgb = cm.ycbcr_to_rgb(y, cb, cr, tags["matrix"])
    else:
        raw = run([FFMPEG, "-v", "error", "-nostdin", *seek, "-i", path, "-frames:v", "1", *scale, "-f", "rawvideo", "-pix_fmt", "rgb48le", "-"])
        data = np.frombuffer(raw, dtype=np.dtype("<u2"))
        if data.size < 3 * width * height:
            fail(f"{path}: no frame decoded")
        rgb = data[: 3 * width * height].reshape(height, width, 3).astype(np.float64) / 65535
        legal = None
    return {"rgb": rgb, "legal": legal, "t": at}


def sample_times(info: dict[str, Any], request: dict[str, Any], start: float = 0.0, end: float | None = None) -> list[float | None]:
    """Explicit --at time, or N frames evenly inside [start, end] avoiding the very edges."""
    if info["still"] or info["duration"] <= 0:
        return [None]
    if request.get("at") is not None:
        return [min(max(float(request["at"]), 0.0), max(info["duration"] - 0.05, 0.0))]
    stop = info["duration"] if end is None else min(end, info["duration"])
    span = max(stop - start, 0.05)
    count = max(int(request.get("frames", 6)), 1)
    return [round(start + span * (i + 0.5) / count, 4) for i in range(count)]


def detect_crop(frames: list[np.ndarray]) -> tuple[int, int, int, int]:
    """Active picture inside letterbox or pillarbox bars: rows/columns that stay near black in every frame."""
    height, width = frames[0].shape[:2]
    lum = np.stack([np.clip(cm.luma(f), 0, 1) for f in frames])
    rows = np.percentile(lum, 98, axis=2).max(axis=0)
    cols = np.percentile(lum, 98, axis=1).max(axis=0)

    def span(levels: np.ndarray) -> tuple[int, int]:
        bright = np.nonzero(levels > 0.035)[0]  # noqa: PLR2004 -- just above black-bar level, with grain.
        if bright.size == 0:
            return 0, len(levels)
        lo, hi = int(bright[0]), int(bright[-1]) + 1
        lo = lo + 1 if lo > 0 else 0
        hi = hi - 1 if hi < len(levels) else hi
        if hi - lo < 0.3 * len(levels):
            return 0, len(levels)
        return lo, hi

    y0, y1 = span(rows)
    x0, x1 = span(cols)
    if y0 < max(2, height * 0.01) and height - y1 < max(2, height * 0.01):
        y0, y1 = 0, height
    if x0 < max(2, width * 0.01) and width - x1 < max(2, width * 0.01):
        x0, x1 = 0, width
    return x0, y0, x1 - x0, y1 - y0


class Media:
    """Decoded, cropped analysis frames of one input."""

    def __init__(self, path: str, request: dict[str, Any], times: list[float | None] | None = None) -> None:
        """Decode the requested frames and find the active picture."""
        self.path = path
        self.info = probe(path)
        self.tags = colour_tags(self.info, request)
        self.size = analysis_size(self.info, int(request.get("maxWidth", 960)))
        self.times = times if times is not None else sample_times(self.info, request)
        decoded = [read_frame(path, t, self.info, self.tags, self.size) for t in self.times]
        self.full = [d["rgb"] for d in decoded]
        legal = [d["legal"] for d in decoded if d["legal"] is not None]
        self.legal = {k: round(float(np.mean([entry[k] for entry in legal])), 4) for k in legal[0]} if legal else None
        crop = request.get("crop", "auto")
        if crop == "none":
            self.crop = (0, 0, self.size[0], self.size[1])
        elif isinstance(crop, list):
            sx = self.size[0] / self.info["width"]
            sy = self.size[1] / self.info["height"]
            self.crop = (round(crop[0] * sx), round(crop[1] * sy), round(crop[2] * sx), round(crop[3] * sy))
        else:
            self.crop = detect_crop(self.full)
        x, y, w, h = self.crop
        self.frames = [f[y : y + h, x : x + w] for f in self.full]

    def describe(self) -> dict[str, Any]:
        """Decoding facts, the crop in source pixels and every assumption made."""
        x, y, w, h = self.crop
        sx = self.info["width"] / self.size[0]
        sy = self.info["height"] / self.size[1]
        return {
            "path": self.path,
            "probe": self.info,
            "decode": {k: self.tags[k] for k in ("kind", "matrix", "range", "bits", "tagged")},
            "assumptions": self.tags["assumed"],
            "analysisSize": list(self.size),
            "activePicture": {"x": round(x * sx), "y": round(y * sy), "width": round(w * sx), "height": round(h * sy), "cropped": (w, h) != self.size},
            "times": self.times,
        }

    def pixels(self, limit: int = MAX_STAT_PIXELS) -> np.ndarray:
        """All cropped pixels of every frame, deterministically strided to at most `limit`."""
        allpx = np.concatenate([f.reshape(-1, 3) for f in self.frames])
        stride = max(1, math.ceil(len(allpx) / limit))
        return allpx[::stride]


# ---------------------------------------------------------------------------------------------------------------
# Statistics


def cast_words(a: float, b: float, threshold: float = 1.5) -> str:
    """Name an a*/b* offset the way a colourist would."""
    words = []
    if b < -threshold:
        words.append(f"cool/blue (b* {b:+.1f})")
    elif b > threshold:
        words.append(f"warm/yellow (b* {b:+.1f})")
    if a < -threshold:
        words.append(f"green (a* {a:+.1f})")
    elif a > threshold:
        words.append(f"magenta (a* {a:+.1f})")
    return ", ".join(words) if words else "neutral"


def skin_stats(rgb: np.ndarray, region_mask: np.ndarray | None = None) -> dict[str, Any]:
    """Skin-candidate pixels by a Y'CbCr chroma rule (no face detector): their hue against the skin line."""
    y, cb, cr = cm.rgb_to_ycbcr(rgb)
    mask = (cb >= -0.2277) & (cb <= -0.0045) & (cr >= 0.0223) & (cr <= 0.2009) & (y >= 0.2) & (y <= 0.95)  # noqa: PLR2004 -- Chai and Ngan skin chroma box.
    method = "skin-chroma-mask"
    if region_mask is not None:
        mask = region_mask & ((np.hypot(cb, cr) > 0.01) | mask)  # noqa: PLR2004 -- ignore achromatic pixels in a region.
        method = "region"
    share = float(100 * mask.mean())
    out: dict[str, Any] = {"method": method, "pixelsPct": round(share, 3), "skinLineDeg": cm.SKIN_LINE_DEG}
    if mask.sum() < 200:  # noqa: PLR2004 -- too few pixels for a hue estimate.
        out["found"] = False
        return out
    chroma = np.hypot(cb[mask], cr[mask])
    hue = cm.circular_mean_deg(cm.vectorscope_angle(cb[mask], cr[mask]), chroma)
    lab = cm.rgb_to_lab(np.clip(rgb[mask], 0, 1))
    out.update(
        {
            "found": True,
            "hueDeg": round(hue, 2) if hue is not None else None,
            "offsetFromSkinLineDeg": round(cm.angle_difference(hue, cm.SKIN_LINE_DEG), 2) if hue is not None else None,
            "lab": [round(float(v), 2) for v in lab.mean(axis=0)],
            "chromaPctOfFullScale": round(float(np.median(chroma) / 0.5 * 100), 2),
            "lumaIre": round(float(np.median(y[mask]) * 100), 2),
        },
    )
    return out


def region_pixels(media: Media, region: list[float]) -> np.ndarray:
    """A source-pixel box (x, y, w, h) as a flat mask over every cropped analysis frame of `media`."""
    rx, ry, rw, rh = region
    sx = media.size[0] / media.info["width"]
    sy = media.size[1] / media.info["height"]
    x0, y0 = round(rx * sx) - media.crop[0], round(ry * sy) - media.crop[1]
    masks = []
    for frame in media.frames:
        m = np.zeros(frame.shape[:2], dtype=bool)
        m[max(y0, 0) : max(y0 + round(rh * sy), 0), max(x0, 0) : max(x0 + round(rw * sx), 0)] = True
        masks.append(m.ravel())
    return np.concatenate(masks)


def keyed_pixels(media: Media, region: list[float] | None, limit: int) -> tuple[np.ndarray, np.ndarray]:
    """Strided pixels and their skin mask, keyed on these pixels (a region box, else the skin chroma rule)."""
    allpx = np.concatenate([f.reshape(-1, 3) for f in media.frames])
    stride = max(1, math.ceil(len(allpx) / limit))
    px = allpx[::stride]
    if region:
        return px, region_pixels(media, region)[::stride]
    return px, cc.skin_box(px)


def statistics(media: Media, request: dict[str, Any]) -> dict[str, Any]:
    """The numbers a colourist reads off the scopes."""
    px = media.pixels()
    y = cm.luma(px)
    clipped = np.clip(px, 0, 1)
    lab = cm.rgb_to_lab(clipped)
    _, cb, cr = cm.rgb_to_ycbcr(px)
    chroma_ab = np.hypot(lab[:, 1], lab[:, 2])
    radius = np.hypot(cb, cr)
    q = np.percentile(y, [0.5, 1, 5, 50, 95, 99, 99.5])

    def code(v: float) -> dict[str, float]:
        return {"ire": round(float(v) * 100, 2), "code10": round(float(v) * 1023, 1)}

    coloured = radius > 0.02  # noqa: PLR2004 -- hue is undefined near neutral.
    hue_hist = np.histogram(cm.vectorscope_angle(cb[coloured], cr[coloured]), bins=12, range=(0, 360), weights=radius[coloured])[0]
    hue_hist = hue_hist / max(float(hue_hist.sum()), 1e-9) * 100
    zones = cm.zone_summary(lab)
    neutral = cm.neutral_cast(lab)
    region_mask = None
    if request.get("skinRegion"):
        region_mask = region_pixels(media, request["skinRegion"])[:: max(1, math.ceil(sum(f.shape[0] * f.shape[1] for f in media.frames) / MAX_STAT_PIXELS))]
    tonal = {"shadowsPct": float(100 * (y < 0.2).mean()), "midsPct": float(100 * ((y >= 0.2) & (y <= 0.8)).mean()), "highlightsPct": float(100 * (y > 0.8).mean())}  # noqa: PLR2004 -- 20/80 IRE bands.
    return {
        "luma": {
            "mean": code(float(y.mean())),
            "median": code(q[3]),
            "blackPoint": code(q[0]),
            "whitePoint": code(q[6]),
            "p1": code(q[1]),
            "p5": code(q[2]),
            "p95": code(q[4]),
            "p99": code(q[5]),
            "contrastRatioP5P95": round(float((q[4] + 1e-3) / (q[2] + 1e-3)), 3),
        },
        "tonal": {k: round(v, 3) for k, v in tonal.items()},
        "clipping": {
            "lowPct": round(float(100 * (y <= 0.002).mean()), 4),  # noqa: PLR2004 -- within 2 ten-bit codes of black.
            "highPct": round(float(100 * (y >= 0.998).mean()), 4),  # noqa: PLR2004 -- within 2 ten-bit codes of white.
            "subBlackPct": round(float(100 * (y < -0.004).mean()), 4),  # noqa: PLR2004 -- below legal black.
            "superWhitePct": round(float(100 * (y > 1.004).mean()), 4),  # noqa: PLR2004 -- above legal white.
            "channels": {name: {"lowPct": round(float(100 * (px[:, i] <= 0.002).mean()), 4), "highPct": round(float(100 * (px[:, i] >= 0.998).mean()), 4)} for i, name in enumerate("rgb")},  # noqa: PLR2004 -- see above.
        },
        "legal": {"range": media.tags["range"], **(media.legal or {})} if media.legal else {"range": media.tags["range"], "note": "full-range or RGB source: no limited-range check"},
        "rgb": {"mean": [round(float(v), 4) for v in clipped.mean(axis=0)], "median": [round(float(v), 4) for v in np.median(clipped, axis=0)]},
        "lab": {"mean": [round(float(v), 3) for v in lab.mean(axis=0)]},
        "whiteBalance": {"neutralA": round(neutral["a"], 3), "neutralB": round(neutral["b"], 3), "neutralPixelsPct": round(neutral["pixelsPct"], 3), "cast": cast_words(neutral["a"], neutral["b"])},
        "zones": {name: {k: round(v, 3) for k, v in values.items()} | {"cast": cast_words(values["a"], values["b"])} for name, values in zones.items()},
        "saturation": {
            "chromaP10": round(float(np.percentile(chroma_ab, 10)), 3),
            "chromaP50": round(float(np.percentile(chroma_ab, 50)), 3),
            "chromaP90": round(float(np.percentile(chroma_ab, 90)), 3),
            "chromaMean": round(float(chroma_ab.mean()), 3),
            "vectorscopeP50Pct": round(float(np.percentile(radius, 50) / 0.5 * 100), 3),
            "vectorscopeP95Pct": round(float(np.percentile(radius, 95) / 0.5 * 100), 3),
        },
        "hueDistributionPct": {f"{i * 30}-{i * 30 + 30}": round(float(v), 2) for i, v in enumerate(hue_hist)},
        "skin": skin_stats(px, region_mask),
    }


def stat_lines(stats: dict[str, Any]) -> tuple[list[str], list[str], list[str]]:
    """Three short text panels for the contact sheet."""
    lum = stats["luma"]
    clip = stats["clipping"]
    exposure = [
        "# Exposure (IRE / 10-bit)",
        f"black point {lum['blackPoint']['ire']:.1f} / {lum['blackPoint']['code10']:.0f}",
        f"white point {lum['whitePoint']['ire']:.1f} / {lum['whitePoint']['code10']:.0f}",
        f"mean luma   {lum['mean']['ire']:.1f}   median {lum['median']['ire']:.1f}",
        f"p5..p95     {lum['p5']['ire']:.1f} .. {lum['p95']['ire']:.1f}",
        f"tonal  sh {stats['tonal']['shadowsPct']:.0f}%  mid {stats['tonal']['midsPct']:.0f}%  hi {stats['tonal']['highlightsPct']:.0f}%",
        "# Clipping",
        f"low {clip['lowPct']:.2f}%   high {clip['highPct']:.2f}%",
        f"sub-black {clip['subBlackPct']:.2f}%  super-white {clip['superWhitePct']:.2f}%",
        "R/G/B high " + " / ".join(f"{clip['channels'][c]['highPct']:.2f}" for c in "rgb") + " %",
    ]
    legal = stats["legal"]
    if "yAbovePct" in legal:
        exposure.append(f"legal: Y<16 {legal['yBelowPct']:.2f}%  Y>235 {legal['yAbovePct']:.2f}%")
    zones = stats["zones"]
    wb = stats["whiteBalance"]
    colour = [
        "# White balance (neutral pixels)",
        f"a* {wb['neutralA']:+.2f}  b* {wb['neutralB']:+.2f}  ({wb['neutralPixelsPct']:.0f}% px)",
        f"cast: {wb['cast']}",
        "# Zones (L*, a*, b*, C*)",
        *[f"{z:<10} {zones[z]['L']:5.1f} {zones[z]['a']:+5.1f} {zones[z]['b']:+5.1f} {zones[z]['C']:5.1f}" for z in ("shadows", "mids", "highlights")],
        "# Saturation",
        f"C* p10/p50/p90  {stats['saturation']['chromaP10']:.1f} / {stats['saturation']['chromaP50']:.1f} / {stats['saturation']['chromaP90']:.1f}",
        f"vectorscope p50/p95  {stats['saturation']['vectorscopeP50Pct']:.1f}% / {stats['saturation']['vectorscopeP95Pct']:.1f}%",
    ]
    skin = stats["skin"]
    skin_lines = ["# Skin (" + skin["method"] + ")", f"pixels {skin['pixelsPct']:.1f}%"]
    if skin.get("found"):
        skin_lines += [
            f"hue {skin['hueDeg']:.1f} deg  (skin line {cm.SKIN_LINE_DEG:g})",
            f"offset {skin['offsetFromSkinLineDeg']:+.1f} deg ({'toward yellow' if skin['offsetFromSkinLineDeg'] > 0 else 'toward red'})",
            f"Lab {skin['lab'][0]:.1f} {skin['lab'][1]:+.1f} {skin['lab'][2]:+.1f}",
            f"luma {skin['lumaIre']:.1f} IRE  chroma {skin['chromaPctOfFullScale']:.1f}%",
        ]
    else:
        skin_lines.append("no skin-like pixels found")
    top_hues = sorted(stats["hueDistributionPct"].items(), key=lambda kv: -kv[1])[:3]
    skin_lines += ["# Dominant hues (vectorscope deg)", *[f"{k}: {v:.0f}%" for k, v in top_hues]]
    return exposure, colour, skin_lines


# ---------------------------------------------------------------------------------------------------------------
# Scopes


def scope_images(media: Media) -> dict[str, np.ndarray]:
    """Render every scope of the analysed frames."""
    rgbs = media.frames
    lumas = [cm.luma(f) for f in rgbs]
    ycc = [cm.rgb_to_ycbcr(f) for f in rgbs]
    cbs = [c[1] for c in ycc]
    crs = [c[2] for c in ycc]
    rep = len(rgbs) // 2
    label = f"{Path(media.path).name}" + (f"  t={media.times[rep]:.2f}s" if media.times[rep] is not None else "") + f"  ({len(rgbs)} frame{'s' if len(rgbs) > 1 else ''} in scopes)"
    fc, share = sc.false_colour(rgbs[rep], lumas[rep])
    images = {
        "frame": sc.frame_tile(media.full[rep], label, media.crop),
        "false-colour": fc,
        "waveform-luma": sc.waveform([(lumas, (170, 240, 170))], "Waveform  luma Y'", CELL),
        "waveform-rgb": sc.waveform([([f[..., i] for f in rgbs], sc.CHANNEL_COLOURS[i]) for i in range(3)], "Waveform  RGB overlay", CELL),
        "parade": sc.parade(rgbs, CELL),
        "vectorscope": sc.vectorscope(cbs, crs, rgbs, zoom=1.0, size=560),
        "vectorscope-2x": sc.vectorscope(cbs, crs, rgbs, zoom=2.0, size=560),
        "histogram": sc.histogram(rgbs, lumas, CELL),
        "cie": sc.cie_chromaticity(rgbs, 560),
    }
    images["_false_colour_share"] = share  # type: ignore[assignment]
    return images


def op_scopes(request: dict[str, Any]) -> dict[str, Any]:
    """Scopes, contact sheet and statistics of one input."""
    media = Media(request["input"], request)
    out_dir = Path(request["output"])
    out_dir.mkdir(parents=True, exist_ok=True)
    stats = statistics(media, request)
    images = scope_images(media)
    stats["falseColourPct"] = images.pop("_false_colour_share")  # type: ignore[arg-type]
    files = {}
    for name, img in images.items():
        path = out_dir / f"{name}.png"
        sc.write_png(str(path), img)
        files[name] = str(path)
    exposure, colour, skin = stat_lines(stats)
    sheet = sc.grid(
        [
            [images["frame"], images["false-colour"], sc.text_panel(exposure, *CELL, "Exposure")],
            [images["waveform-luma"], images["parade"], images["waveform-rgb"]],
            [images["vectorscope"], images["vectorscope-2x"], images["cie"]],
            [images["histogram"], sc.text_panel(colour, *CELL, "Colour"), sc.text_panel(skin, *CELL, "Skin and hue")],
        ],
        CELL,
        f"Scopes  {Path(media.path).name}  " + ("  ".join(media.tags["assumed"]) or f"{media.tags['matrix']} {media.tags['range']}"),
    )
    sheet_path = out_dir / "sheet.png"
    sc.write_png(str(sheet_path), sheet)
    files["sheet"] = str(sheet_path)
    return {"ok": True, "media": media.describe(), "stats": stats, "files": files}


# ---------------------------------------------------------------------------------------------------------------
# Comparison and diagnosis


def diagnose(a: dict[str, Any], b: dict[str, Any]) -> tuple[list[dict[str, Any]], str]:  # noqa: C901 -- one rule per colourist observation.
    """What differs in `a` relative to `b`, as machine-readable findings and one short summary line."""
    findings: list[dict[str, Any]] = []

    def add(zone: str, attribute: str, value: float, phrase: str) -> None:
        findings.append({"zone": zone, "attribute": attribute, "value": round(value, 3), "text": phrase})

    for zone in ("shadows", "mids", "highlights"):
        za, zb = a["zones"][zone], b["zones"][zone]
        da, db, dl = za["a"] - zb["a"], za["b"] - zb["b"], za["L"] - zb["L"]
        if db < -1.5:  # noqa: PLR2004 -- just-noticeable chroma offset.
            add(zone, "b", db, f"{zone} cooler")
        elif db > 1.5:  # noqa: PLR2004 -- see above.
            add(zone, "b", db, f"{zone} warmer")
        if da < -1.5:  # noqa: PLR2004 -- see above.
            add(zone, "a", da, f"{zone} +green")
        elif da > 1.5:  # noqa: PLR2004 -- see above.
            add(zone, "a", da, f"{zone} +magenta")
        if abs(dl) > 2.5:  # noqa: PLR2004 -- visible lightness step.
            add(zone, "L", dl, f"{zone} {'brighter' if dl > 0 else 'darker'} (L* {dl:+.1f})")
    la, lb = a["luma"], b["luma"]
    dbp = la["blackPoint"]["ire"] - lb["blackPoint"]["ire"]
    dwp = la["whitePoint"]["ire"] - lb["whitePoint"]["ire"]
    if abs(dbp) > 2:  # noqa: PLR2004 -- IRE.
        add("shadows", "blackPoint", dbp, f"blacks {'lifted' if dbp > 0 else 'crushed'} {dbp:+.1f} IRE")
    if abs(dwp) > 2:  # noqa: PLR2004 -- IRE.
        add("highlights", "whitePoint", dwp, f"whites {'higher' if dwp > 0 else 'lower'} {dwp:+.1f} IRE")
    ca = la["p95"]["ire"] - la["p5"]["ire"]
    cb = lb["p95"]["ire"] - lb["p5"]["ire"]
    contrast = (ca / max(cb, 1e-6) - 1) * 100
    if abs(contrast) > 5:  # noqa: PLR2004 -- percent.
        add("all", "contrast", contrast, f"contrast {contrast:+.0f}%")
    sat = (a["saturation"]["chromaP50"] / max(b["saturation"]["chromaP50"], 1e-6) - 1) * 100
    if abs(sat) > 5:  # noqa: PLR2004 -- percent.
        add("all", "saturation", sat, f"saturation {sat:+.0f}%")
    sa, sb = a["skin"], b["skin"]
    if sa.get("found") and sb.get("found"):
        dh = cm.angle_difference(sa["hueDeg"], sb["hueDeg"])
        if abs(dh) > 3:  # noqa: PLR2004 -- degrees on the vectorscope.
            add("skin", "hue", dh, f"skin hue {dh:+.0f} deg ({'toward yellow' if dh > 0 else 'toward red/magenta'})")
    summary = ", ".join(f["text"] for f in findings) or "no notable difference"
    return findings, summary


def zone_delta(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    """Per-zone mean Lab differences and CIEDE2000 between zone means."""
    out: dict[str, Any] = {}
    for zone in ("shadows", "mids", "highlights"):
        za, zb = a["zones"][zone], b["zones"][zone]
        lab_a = np.array([za["L"], za["a"], za["b"]])
        lab_b = np.array([zb["L"], zb["a"], zb["b"]])
        out[zone] = {
            "dL": round(za["L"] - zb["L"], 3),
            "da": round(za["a"] - zb["a"], 3),
            "db": round(za["b"] - zb["b"], 3),
            "dC": round(za["C"] - zb["C"], 3),
            "deltaE2000": round(float(cm.delta_e_2000(lab_a, lab_b)), 3),
        }
    out["meanDeltaE2000"] = round(float(np.mean([out[z]["deltaE2000"] for z in ("shadows", "mids", "highlights")])), 3)
    return out


def paired_delta(a: Media, b: Media, *, force: bool) -> dict[str, Any]:
    """Per-pixel CIEDE2000 on frames resized to one size, when both show the same picture at the same times."""
    ha, wa = a.frames[0].shape[:2]
    hb, wb = b.frames[0].shape[:2]
    aspect_gap = abs((wa / ha) / (wb / hb) - 1)
    if aspect_gap > 0.04 and not force:  # noqa: PLR2004 -- 4% framing difference.
        return {"available": False, "reason": f"active pictures differ in aspect by {aspect_gap * 100:.1f}%"}
    import cv2

    width = 384
    height = round(width * hb / wb)
    des, corr = [], []
    for fa, fb in zip(a.frames, b.frames, strict=True):
        ra = cv2.resize(np.clip(fa, 0, 1).astype(np.float32), (width, height), interpolation=cv2.INTER_AREA).astype(np.float64)
        rb = cv2.resize(np.clip(fb, 0, 1).astype(np.float32), (width, height), interpolation=cv2.INTER_AREA).astype(np.float64)
        des.append(cm.delta_e_2000(cm.rgb_to_lab(ra.reshape(-1, 3)), cm.rgb_to_lab(rb.reshape(-1, 3))))
        ya, yb = cm.luma(ra).ravel(), cm.luma(rb).ravel()
        corr.append(float(np.corrcoef(ya, yb)[0, 1]) if ya.std() > 1e-6 and yb.std() > 1e-6 else 0.0)  # noqa: PLR2004 -- flat frame.
    de = np.concatenate(des)
    alignment = float(np.mean(corr))
    out = {
        "available": True,
        "lumaCorrelation": round(alignment, 4),
        "deltaE2000": {"mean": round(float(de.mean()), 3), "median": round(float(np.median(de)), 3), "p95": round(float(np.percentile(de, 95)), 3)},
    }
    if alignment < 0.6 and not force:  # noqa: PLR2004 -- frames do not show the same picture.
        out["reliable"] = False
        out["reason"] = "frames are not aligned (luma correlation below 0.6); trust the zone comparison"
    else:
        out["reliable"] = True
    return out


def compare_sheet(a: Media, b: Media, diagnosis: str, zones: dict[str, Any], paired: dict[str, Any]) -> np.ndarray:
    """Side-by-side scopes of input and reference, a vectorscope overlay and the diagnosis."""
    ia, ib = scope_images(a), scope_images(b)
    ycc_a = [cm.rgb_to_ycbcr(f) for f in a.frames]
    ycc_b = [cm.rgb_to_ycbcr(f) for f in b.frames]
    overlay = sc.vectorscope([], [], [], zoom=2.0, size=560, overlay=[([c[1] for c in ycc_a], [c[2] for c in ycc_a], (60, 210, 255)), ([c[1] for c in ycc_b], [c[2] for c in ycc_b], (255, 150, 40))])
    sc.text(overlay, "input = cyan   reference = orange", (10, 585), 0.45, sc.TEXT)
    lines = ["# Input relative to reference", *wrap(diagnosis, 70), "# Zone CIEDE2000 (dL, da, db)"]
    lines += [f"{z:<10} dE {zones[z]['deltaE2000']:.2f}  ({zones[z]['dL']:+.1f}, {zones[z]['da']:+.1f}, {zones[z]['db']:+.1f})" for z in ("shadows", "mids", "highlights")]
    lines.append(f"mean zone dE2000 {zones['meanDeltaE2000']:.2f}")
    if paired.get("available"):
        p = paired["deltaE2000"]
        lines.append(f"paired dE2000 mean {p['mean']:.2f} p95 {p['p95']:.2f} (align {paired['lumaCorrelation']:.2f})")
    rows = [
        [ia["frame"], ib["frame"]],
        [ia["waveform-luma"], ib["waveform-luma"]],
        [ia["parade"], ib["parade"]],
        [ia["vectorscope-2x"], ib["vectorscope-2x"]],
        [ia["histogram"], ib["histogram"]],
        [overlay, sc.text_panel(lines, *CELL, "Diagnosis")],
    ]
    return sc.grid(rows, CELL, f"Compare  input {Path(a.path).name}  |  reference {Path(b.path).name}")


def wrap(value: str, width: int) -> list[str]:
    """Wrap a comma-separated summary into panel lines."""
    lines, current = [], ""
    for part in value.split(", "):
        candidate = f"{current}, {part}" if current else part
        if len(candidate) > width and current:
            lines.append(current + ",")
            current = part
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def paired_times(a: Media, b_info: dict[str, Any], request: dict[str, Any]) -> list[float | None]:
    """Reference sample times at the same relative positions as the input's (clips of different lengths)."""
    if b_info["still"] or b_info["duration"] <= 0:
        return [None]
    if a.info["duration"] <= 0:
        return sample_times(b_info, request)
    ratio = b_info["duration"] / a.info["duration"]
    return [None if t is None else round(min(t * ratio, b_info["duration"] - 0.05), 4) for t in a.times]


def op_compare(request: dict[str, Any]) -> dict[str, Any]:
    """Compare an input with a reference: scopes side by side, zone and paired CIEDE2000, diagnosis."""
    a = Media(request["input"], request)
    b_request = {**request, "crop": request.get("referenceCrop", "auto")}
    b = Media(request["reference"], b_request, paired_times(a, probe(request["reference"]), request))
    sa, sb = statistics(a, request), statistics(b, b_request)
    findings, summary = diagnose(sa, sb)
    zones = zone_delta(sa, sb)
    paired = paired_delta(a, b, force=bool(request.get("paired")))
    lab_a = cm.rgb_to_lab(np.clip(a.pixels(), 0, 1)).mean(axis=0)
    lab_b = cm.rgb_to_lab(np.clip(b.pixels(), 0, 1)).mean(axis=0)
    out_dir = Path(request["output"])
    out_dir.mkdir(parents=True, exist_ok=True)
    sheet = out_dir / "compare.png"
    sc.write_png(str(sheet), compare_sheet(a, b, summary, zones, paired))
    return {
        "ok": True,
        "input": a.describe(),
        "reference": b.describe(),
        "stats": {"input": sa, "reference": sb},
        "zones": zones,
        "globalDeltaE2000": round(float(cm.delta_e_2000(lab_a, lab_b)), 3),
        "paired": paired,
        "findings": findings,
        "summary": summary,
        "files": {"sheet": str(sheet)},
    }


# ---------------------------------------------------------------------------------------------------------------
# Reference match


IDENTITY = np.array([0, 0, 0, 1, 1, 1, 1, 1, 1, 1], dtype=np.float64)
LOWER = np.array([-0.25, -0.25, -0.25, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.2])
UPPER = np.array([0.25, 0.25, 0.25, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5])


def params_grade(p: np.ndarray, curves: dict[str, Any] | None = None) -> dict[str, Any]:
    """Parameter vector (lift rgb, gamma rgb, gain rgb, saturation) to a grade."""
    grade: dict[str, Any] = {"lift": [float(v) for v in p[0:3]], "gamma": [float(v) for v in p[3:6]], "gain": [float(v) for v in p[6:9]], "saturation": float(p[9])}
    if curves:
        grade["curves"] = curves
    return grade


def fit_match(
    source: np.ndarray,
    target: np.ndarray,
    method: str,
    paired_pairs: tuple[np.ndarray, np.ndarray] | None,
    skin: tuple[np.ndarray, np.ndarray] | None = None,
) -> tuple[np.ndarray, dict[str, Any] | None]:
    """Solve lift/gamma/gain per channel and saturation (and a master curve) toward the reference.

    `skin` is (source skin pixels, target mean Lab): the primary then has to keep faces near that target while it
    moves the frame's statistics, so it cannot buy a better zone match by turning skin yellow.
    """
    from scipy.optimize import least_squares

    target_features = cm.match_features(cm.rgb_to_lab(np.clip(target, 0, 1)))
    regulariser = np.array([2, 2, 2, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5])

    skin_px = skin[0][:: max(1, len(skin[0]) // 4000)] if skin is not None else None
    target_y = cm.luma(np.clip(target, 0, 1))
    floor_q = [0.5, 2, 5]
    target_floor = np.percentile(target_y, floor_q)
    target_crush = float(np.mean(1 / (1 + np.exp((target_y - 0.02) / 0.004))))

    def floor_terms(graded: np.ndarray) -> np.ndarray:
        """Black point in Y' (L* barely moves near black) and a smooth share of pixels crushed below 2 IRE."""
        y = cm.luma(np.clip(graded, 0, 1))
        crush = float(np.mean(1 / (1 + np.exp((y - 0.02) / 0.004))))
        return np.concatenate([(np.percentile(y, floor_q) - target_floor) * 60, [max(0.0, crush - target_crush) * 300]])

    def residual_stats(p: np.ndarray, curves: dict[str, Any] | None = None) -> np.ndarray:
        grade = params_grade(p, curves)
        graded = cm.apply_grade(source, grade)
        parts = [cm.match_features(cm.rgb_to_lab(graded)) - target_features, floor_terms(graded), (p - IDENTITY) * regulariser]
        if skin_px is not None and skin is not None:
            parts.append((cm.rgb_to_lab(cm.apply_grade(skin_px, grade)).mean(axis=0) - skin[1]) * np.array([1.0, 2.0, 2.0]))
        return np.concatenate(parts)

    if method == "paired" and paired_pairs is not None:
        src_px, ref_lab = paired_pairs

        def residual_paired(p: np.ndarray) -> np.ndarray:
            graded = cm.apply_grade(src_px, params_grade(p))
            return np.concatenate([(cm.rgb_to_lab(graded) - ref_lab).ravel(), (p - IDENTITY) * regulariser * 10])

        solved = least_squares(residual_paired, IDENTITY, bounds=(LOWER, UPPER), loss="soft_l1", f_scale=4.0, max_nfev=400)
        return solved.x, None
    solved = least_squares(residual_stats, IDENTITY, bounds=(LOWER, UPPER), max_nfev=400)
    p = solved.x
    graded_y = cm.luma(cm.apply_grade(source, params_grade(p)))
    target_y = cm.luma(np.clip(target, 0, 1))
    qs = [1, 10, 25, 50, 75, 90, 99]
    xs = np.percentile(graded_y, qs)
    ys = np.maximum.accumulate(np.percentile(target_y, qs))
    if np.max(np.abs(xs - ys)) < 0.01 or np.any(np.diff(xs) < 0.01):  # noqa: PLR2004 -- under ten 10-bit codes, or degenerate.
        return p, None
    points = [[0.0, 0.0], *[[round(float(x), 4), round(float(y), 4)] for x, y in zip(xs, ys, strict=True)], [1.0, 1.0]]
    points = [pt for i, pt in enumerate(points) if i == 0 or pt[0] > points[i - 1][0] + 0.005]
    curves = {"master": points}
    before = float(np.sum(residual_stats(p) ** 2))
    refined = least_squares(lambda q: residual_stats(q, curves), p, bounds=(LOWER, UPPER), max_nfev=200)
    if float(np.sum(residual_stats(refined.x, curves) ** 2)) < 0.9 * before:
        return refined.x, curves
    return p, None


def soften(p: np.ndarray, curves: dict[str, Any] | None, strength: float) -> tuple[np.ndarray, dict[str, Any] | None]:
    """Blend a solved match toward identity: strength 1 is the full match, 0 no grade."""
    if strength >= 1:
        return p, curves
    blended = IDENTITY + (p - IDENTITY) * strength
    if curves:
        curves = {"master": [[x, round(x + (y - x) * strength, 4)] for x, y in curves["master"]]}
    return blended, curves


def clipped_pct(px: np.ndarray) -> float:
    """Share of pixels with any channel at or above code 1021 of 1023."""
    return float(100 * (px >= 0.998).any(axis=1).mean())  # noqa: PLR2004 -- two 10-bit codes below white.


def guard_highlights(source: np.ndarray, grade: dict[str, Any]) -> None:
    """Add a highlight soft clip when the solved grade drives more pixels into clipping than the source had."""
    before = clipped_pct(source)
    if clipped_pct(cm.apply_grade(source, grade)) - before > 0.05:  # noqa: PLR2004 -- percent of pixels.
        grade["softClip"] = {"high": 0.9}


def round_grade(grade: dict[str, Any]) -> dict[str, Any]:
    """Four decimals: editable by hand, stable in diffs."""
    out = {}
    for key, value in grade.items():
        if isinstance(value, list):
            out[key] = [round(v, 4) for v in value]
        elif isinstance(value, float):
            out[key] = round(value, 4)
        else:
            out[key] = value
    return out


def match_metrics(source: np.ndarray, target: np.ndarray, grade: dict[str, Any]) -> dict[str, Any]:
    """Zone CIEDE2000 and feature distance before and after the grade, on the sampled pixels."""
    target_lab = cm.rgb_to_lab(np.clip(target, 0, 1))
    zb = cm.zone_summary(target_lab)

    def score(px: np.ndarray) -> dict[str, float]:
        lab = cm.rgb_to_lab(np.clip(px, 0, 1))
        za = cm.zone_summary(lab)
        des = [float(cm.delta_e_2000(np.array([za[z]["L"], za[z]["a"], za[z]["b"]]), np.array([zb[z]["L"], zb[z]["a"], zb[z]["b"]]))) for z in ("shadows", "mids", "highlights")]
        return {"shadows": round(des[0], 3), "mids": round(des[1], 3), "highlights": round(des[2], 3), "mean": round(float(np.mean(des)), 3)}

    graded = cm.apply_grade(source, grade)
    return {
        "zoneDeltaE2000Before": score(source),
        "zoneDeltaE2000After": score(graded),
        "clippedPct": {"source": round(clipped_pct(source), 4), "graded": round(clipped_pct(graded), 4), "reference": round(clipped_pct(np.clip(target, 0, 1)), 4)},
    }


def match_policy(source_skin: np.ndarray, reference_skin: np.ndarray | None) -> dict[str, Any]:
    """The gate's skin allowance for a match: the move the reference asks for, plus a small margin."""
    if reference_skin is None or len(reference_skin) < cc.MIN_SKIN_PIXELS or len(source_skin) < cc.MIN_SKIN_PIXELS:
        return {"chroma": 1.0, "hueAllowance": 6}
    s, r = cc.lab_summary(source_skin), cc.lab_summary(reference_skin)
    return {"chroma": float(np.clip(r["C"] / max(s["C"], 1e-6), 0.5, 1.5)), "hueAllowance": abs((r["h"] - s["h"] + 180) % 360 - 180) + 6}


def solve(a: Media, b: Media, request: dict[str, Any]) -> dict[str, Any]:  # noqa: C901, PLR0915 -- the match stages in order.
    """Fit a match grade in the order a colourist works: balance the environment, separate it, then place skin."""
    source, skin = keyed_pixels(a, request.get("skinRegion"), 40_000)
    target, ref_skin = keyed_pixels(b, request.get("referenceSkinRegion"), 200_000)
    mode = request.get("skin", "match")
    has_skin = mode != "off" and skin.sum() >= cc.MIN_SKIN_PIXELS
    method = request.get("method", "stats")
    paired_pairs = None
    if method == "paired":
        paired = paired_delta(a, b, force=True)
        if paired.get("lumaCorrelation", 0) < 0.6:  # noqa: PLR2004 -- see paired_delta.
            fail(f"paired match needs aligned frames; luma correlation is {paired.get('lumaCorrelation', 0):.2f}. Use --method stats")
        import cv2

        hb, wb = b.frames[0].shape[:2]
        width, height = 160, round(160 * hb / wb)
        src = [cv2.resize(np.clip(f, 0, 1).astype(np.float32), (width, height), interpolation=cv2.INTER_AREA).reshape(-1, 3) for f in a.frames]
        ref = [cv2.resize(np.clip(f, 0, 1).astype(np.float32), (width, height), interpolation=cv2.INTER_AREA).reshape(-1, 3) for f in b.frames]
        paired_pairs = (np.concatenate(src).astype(np.float64), cm.rgb_to_lab(np.concatenate(ref).astype(np.float64)))
    skin_goal = None
    if has_skin:
        use_reference = mode == "match" and ref_skin.sum() >= cc.MIN_SKIN_PIXELS
        summary = cc.lab_summary(target[ref_skin]) if use_reference else cc.lab_summary(source[skin])
        skin_goal = (source[skin], np.array([summary["L"], summary["a"], summary["b"]]))
    p, curves = fit_match(source, target, method, paired_pairs, skin_goal)
    strength = float(request.get("strength", 1.0))
    p, curves = soften(p, curves, strength)
    grade = round_grade(params_grade(p, curves))
    stages = ["primary: lift/gamma/gain and saturation fitted on the frame" + (" with skin held toward its target" if skin_goal is not None else "")]
    if mode != "off" and request.get("environment", True):
        skin_hue = None
        if has_skin:
            _, scb, scr = cm.rgb_to_ycbcr(np.clip(cm.apply_grade(source[skin], grade), 0, 1))
            skin_hue = cm.circular_mean_deg(cm.vectorscope_angle(scb, scr), np.hypot(scb, scr))
        env = cc.solve_environment(grade, source[~skin], target[~ref_skin], skin_hue)
        if env:
            env["strength"] = round(strength, 4)
            grade = cc.with_secondary(grade, env)
            stages.append(f"environment secondary: hue {env['hueShift']:+.0f} deg, chroma x{env['saturation']:.2f}")
    skin_target = "none"
    if has_skin:
        graded_skin = cm.apply_grade(source[skin], grade)
        if mode == "match" and ref_skin.sum() >= cc.MIN_SKIN_PIXELS:
            goal = cc.lab_summary(target[ref_skin])
            skin_target = "reference skin (" + ("region" if request.get("referenceSkinRegion") else "chroma rule") + ")"
        else:
            goal = cc.skin_target({"chroma": 1.0, "hueAllowance": 4}, cc.lab_summary(source[skin]), cc.lab_summary(graded_skin))
            skin_target = "source skin held (no reference skin found)" if mode == "match" else "source skin held"
        sec = cc.solve_skin(grade, source[skin], source[~skin], goal, "skin")
        if sec:
            sec["strength"] = round(strength, 4)
            grade = cc.with_secondary(grade, sec)
            stages.append(f"skin secondary toward {skin_target}: hue {sec['hueShift']:+.0f} deg, chroma x{sec['saturation']:.2f}, luma {sec['luma']:+.3f}")
    guard_highlights(source, grade)
    graded = cm.apply_grade(source, grade)
    policy = match_policy(source[skin], target[ref_skin]) if mode == "match" else {"chroma": 1.0, "hueAllowance": 6}
    checks = cc.gate(source, graded, skin, policy, (target, ref_skin))
    secondaries = [s for s in grade.get("secondaries", []) if s["name"] in ("skin", "environment toward reference")]
    if secondaries and has_skin:
        checks["checks"].append(cc.spill_check(cm.apply_grade(source[~skin], {**grade, "secondaries": []}), graded[~skin]))
    return {
        "grade": grade,
        "metrics": match_metrics(source, target, grade),
        "gate": checks,
        "skinPixelsPct": round(float(100 * skin.mean()), 3),
        "skinTarget": skin_target,
        "stages": stages,
        "method": method,
        "strength": strength,
    }


def thumbnail_cuts(path: str, info: dict[str, Any]) -> list[float]:
    """Hard cuts in seconds, by the same thumbnail-difference rule colour:track uses (shot_bounds)."""
    height = max(8, round(64 * info["height"] / info["width"]) // 2 * 2)
    proc = stream_frames(path, 64, height, "gray")
    frames = []
    while True:
        chunk = proc.stdout.read(64 * height) if proc.stdout else b""
        if len(chunk) < 64 * height:
            break
        frames.append(np.frombuffer(chunk, dtype=np.uint8).reshape(height, 64).astype(np.float64))
    proc.wait()
    if len(frames) < 3:  # noqa: PLR2004 -- nothing to cut.
        return []
    diff = np.array([0.0] + [float(np.abs(frames[i] - frames[i - 1]).mean() / 255) for i in range(1, len(frames))])
    limit = max(0.09, 8 * float(np.median(diff[1:])))
    fps = info["fps"] or 25
    cuts: list[float] = []
    for i in np.nonzero(diff > limit)[0]:
        t = round(float(i) / fps, 4)
        if not cuts or t - cuts[-1] >= 0.4:  # noqa: PLR2004 -- minimum shot length in seconds.
            cuts.append(t)
    return cuts


def preview_rows(a: Media, b: Media, grade: dict[str, Any], rows: int = 4) -> list[list[np.ndarray]]:
    """Input | graded | reference tiles for the first sampled frames."""
    out = []
    for index in range(min(len(a.frames), rows)):
        graded = cm.apply_grade(a.frames[index], grade)
        out.append([sc.frame_tile(a.frames[index], "input"), sc.frame_tile(graded, "graded (match)"), sc.frame_tile(b.frames[min(index, len(b.frames) - 1)], "reference")])
    return out


def op_match(request: dict[str, Any]) -> dict[str, Any]:
    """Fit an editable grade (or one per shot) that brings the input toward the reference, with the gate's verdict."""
    out_dir = Path(request["output"])
    out_dir.mkdir(parents=True, exist_ok=True)
    b_request = {**request, "crop": request.get("referenceCrop", "auto")}
    if not request.get("perShot"):
        a = Media(request["input"], request)
        b = Media(request["reference"], b_request, paired_times(a, probe(request["reference"]), request))
        result = solve(a, b, request)
        preview = out_dir / "match-preview.png"
        gate = result["gate"]
        zones = result["metrics"]
        title = f"Match preview  {Path(a.path).name} -> {Path(b.path).name}  gate {gate['status'].upper()}"
        title += f"  zone dE2000 {zones['zoneDeltaE2000Before']['mean']:.2f} -> {zones['zoneDeltaE2000After']['mean']:.2f}"
        sc.write_png(str(preview), sc.grid(preview_rows(a, b, result["grade"]), (640, 300), title))
        return {"ok": True, **result, "input": a.describe(), "reference": b.describe(), "files": {"preview": str(preview)}}
    info, ref_info = probe(request["input"]), probe(request["reference"])
    if info["still"] or ref_info["still"]:
        fail("--per-shot needs two videos cut the same way")
    bounds = [0.0, *thumbnail_cuts(request["input"], info), info["duration"]]
    scale = ref_info["duration"] / max(info["duration"], 1e-6)
    shots, rows = [], []
    per = max(int(request.get("frames", 4)), 1)
    for index in range(len(bounds) - 1):
        start, end = bounds[index], bounds[index + 1]
        if end - start < 0.3:  # noqa: PLR2004 -- slivers are not shots.
            continue
        margin = (end - start) * 0.15
        times: list[float | None] = [round(start + margin + (end - start - 2 * margin) * (i + 0.5) / per, 4) for i in range(per)]
        a = Media(request["input"], request, times)
        b = Media(request["reference"], b_request, [round(min(t * scale, ref_info["duration"] - 0.05), 4) for t in times])
        result = solve(a, b, request)
        label = f"shot-{len(shots) + 1:02d}"
        shots.append({"label": label, "start": round(start, 4), "end": round(end, 4), **result})
        graded = cm.apply_grade(a.frames[len(a.frames) // 2], result["grade"])
        rows.append(
            [
                sc.frame_tile(a.frames[len(a.frames) // 2], f"{label} {start:.1f}-{end:.1f}s input"),
                sc.frame_tile(graded, f"graded  gate {result['gate']['status']}"),
                sc.frame_tile(b.frames[len(b.frames) // 2], "reference"),
            ]
        )
    preview = out_dir / "match-preview.png"
    sc.write_png(str(preview), sc.grid(rows, (560, 260), f"Per-shot match  {Path(request['input']).name} -> {Path(request['reference']).name}"))
    worst = max((s["gate"]["status"] for s in shots), key=lambda v: cc.RANK[v], default="pass")
    return {"ok": True, "perShot": True, "shots": shots, "gateStatus": worst, "cuts": bounds[1:-1], "files": {"preview": str(preview)}}


def op_check(request: dict[str, Any]) -> dict[str, Any]:
    """The validation gate on a rendered grade: graded file against its pixel-aligned source, optionally a reference."""
    graded_media = Media(request["input"], request)
    ap = graded_media.describe()["activePicture"]
    source_media = Media(request["source"], {**request, "crop": [ap["x"], ap["y"], ap["width"], ap["height"]]}, graded_media.times)
    if [f.shape for f in source_media.frames] != [f.shape for f in graded_media.frames]:
        fail("--source must be the ungraded file the input was rendered from (same size and timing)")
    source, skin = keyed_pixels(source_media, request.get("skinRegion"), 120_000)
    graded, _ = keyed_pixels(graded_media, None, 120_000)
    reference = None
    ref_media = None
    if request.get("reference"):
        ref_media = Media(request["reference"], {**request, "crop": request.get("referenceCrop", "auto")}, paired_times(graded_media, probe(request["reference"]), request))
        reference = keyed_pixels(ref_media, request.get("referenceSkinRegion"), 200_000)
    policy = request.get("policy") or (match_policy(source[skin], reference[0][reference[1]]) if reference else {"chroma": 1.0, "hueAllowance": 6})
    verdict = cc.gate(source, graded, skin, policy, reference)
    if graded_media.legal:
        outside = graded_media.legal["yBelowPct"] + graded_media.legal["yAbovePct"]
        legal_status = "warn" if outside > 0.5 else "pass"  # noqa: PLR2004 -- broadcast tolerance.
        verdict["checks"].append({"id": "levels.legal", "status": legal_status, "value": round(outside, 3), "limit": "0.5% outside Y' 16-235", "text": f"{outside:.2f}% of pixels outside legal luma"})
        if outside > 0.5 and verdict["status"] == "pass":  # noqa: PLR2004 -- as above.
            verdict["status"] = "warn"
    out_dir = Path(request["output"])
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for index in range(min(len(graded_media.frames), 3)):
        frame_mask = np.zeros(source_media.frames[index].shape[:2], dtype=bool)
        if request.get("skinRegion"):
            sizes = [f.shape[0] * f.shape[1] for f in source_media.frames]
            offset = sum(sizes[:index])
            frame_mask = region_pixels(source_media, request["skinRegion"])[offset : offset + sizes[index]].reshape(frame_mask.shape)
        else:
            frame_mask = cc.skin_box(source_media.frames[index].reshape(-1, 3)).reshape(frame_mask.shape)
        keyed = source_media.frames[index].copy()
        keyed[frame_mask] = keyed[frame_mask] * 0.5 + np.array([1.0, 0.2, 0.8]) * 0.5
        row = [sc.frame_tile(keyed, "source, skin key in magenta"), sc.frame_tile(graded_media.frames[index], "graded")]
        if ref_media is not None:
            row.append(sc.frame_tile(ref_media.frames[min(index, len(ref_media.frames) - 1)], "reference"))
        rows.append(row)
    lines = [f"[{c['status'].upper():4}] {c['text']}" for c in verdict["checks"]]
    rows.append([sc.text_panel(lines, 640, 300, f"Gate: {verdict['status'].upper()}")])
    sheet = out_dir / "check.png"
    sc.write_png(str(sheet), sc.grid(rows, (640, 300), f"colour:check  {Path(request['input']).name}"))
    (out_dir / "check.json").write_text(json.dumps({"policy": policy, **verdict}, indent=2) + "\n", encoding="utf8")
    return {"ok": True, **verdict, "policy": policy, "skinPixelsPct": round(float(100 * skin.mean()), 3), "files": {"sheet": str(sheet), "report": str(out_dir / "check.json")}}


def op_looks(request: dict[str, Any]) -> dict[str, Any]:
    """Apply each look with its skin policy held by a solved secondary, gate it, and lay the variants out in one grid."""
    media = Media(request["input"], request)
    px, skin = keyed_pixels(media, request.get("skinRegion"), 60_000)
    has_skin = skin.sum() >= cc.MIN_SKIN_PIXELS
    middle = media.frames[len(media.frames) // 2]
    out_dir = Path(request["output"])
    out_dir.mkdir(parents=True, exist_ok=True)
    tiles = [sc.frame_tile(middle, "0. source (ungraded)")]
    looks = []
    for index, look in enumerate(request["looks"], start=1):
        grade = look["grade"]
        policy = look.get("skin", {})
        secondary = None
        if has_skin and policy.get("mode", "hold") == "hold":
            graded_skin = cm.apply_grade(px[skin], grade)
            goal = cc.skin_target(policy, cc.lab_summary(px[skin]), cc.lab_summary(graded_skin))
            secondary = cc.solve_skin(grade, px[skin], px[~skin], goal, f"skin hold ({look['id']})")
            grade = cc.with_secondary(grade, secondary)
        graded = cm.apply_grade(px, grade)
        verdict = cc.gate(px, graded, skin, policy)
        if secondary:
            verdict["checks"].append(cc.spill_check(cm.apply_grade(px[~skin], look["grade"]), graded[~skin]))
            verdict["status"] = max(verdict["status"], verdict["checks"][-1]["status"], key=lambda v: cc.RANK[v])
        still = out_dir / f"{look['id']}.png"
        image = cm.apply_grade(middle, grade)
        sc.write_png(str(still), (np.clip(image, 0, 1) * 255).round().astype(np.uint8))
        tiles.append(sc.frame_tile(image, f"{index}. {look['name']}  [{verdict['status']}]"))
        looks.append({"id": look["id"], "grade": grade, "gate": verdict, "skinSecondary": secondary is not None, "still": str(still)})
    columns = 3 if len(tiles) <= 9 else 4  # noqa: PLR2004 -- three across keeps each variant readable.
    rows = [tiles[i : i + columns] for i in range(0, len(tiles), columns)]
    h, w = middle.shape[:2]
    cell = (640, max(200, round(640 * h / w)))
    grid = out_dir / "looks.png"
    sc.write_png(str(grid), sc.grid(rows, cell, f"Looks on {Path(media.path).name}" + ("  (skin held by a solved secondary)" if has_skin else "  (no skin found)")))
    return {"ok": True, "looks": looks, "skinPixelsPct": round(float(100 * skin.mean()), 3), "input": media.describe(), "files": {"grid": str(grid)}}


# ---------------------------------------------------------------------------------------------------------------
# Shots and consistency


def detect_cuts(path: str, info: dict[str, Any], tags: dict[str, Any], threshold: float) -> list[float]:
    """Hard cuts by colour-histogram distance between frames sampled at 6 fps."""
    import cv2

    step = 1 / 6
    width = 160
    height = max(2, round(info["height"] * width / info["width"]) // 2 * 2)
    raw = run([FFMPEG, "-v", "error", "-nostdin", "-i", path, "-vf", f"fps=6,scale={width}:{height}:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
    frames = np.frombuffer(raw, dtype=np.uint8).reshape(-1, height, width, 3)
    hists = []
    for frame in frames:
        hsv = cv2.cvtColor(frame, cv2.COLOR_RGB2HSV)
        hist = cv2.calcHist([hsv], [0, 1, 2], None, [16, 4, 4], [0, 180, 0, 256, 0, 256]).ravel()
        hists.append(hist / max(float(hist.sum()), 1))
    _ = tags
    cuts = []
    for index in range(1, len(hists)):
        distance = cv2.compareHist(hists[index - 1].astype(np.float32), hists[index].astype(np.float32), cv2.HISTCMP_BHATTACHARYYA)
        t = round(index * step, 3)
        if distance > threshold and (not cuts or t - cuts[-1] >= 0.5):  # noqa: PLR2004 -- minimum shot length in seconds.
            cuts.append(t)
    return cuts


def op_shots(request: dict[str, Any]) -> dict[str, Any]:
    """Measure every shot (or clip), compare each with the hero, and optionally solve a match grade per shot."""
    segments: list[dict[str, Any]] = []
    if request.get("detect"):
        source = request["inputs"][0]["path"]
        info = probe(source)
        tags = colour_tags(info, request)
        cuts = detect_cuts(source, info, tags, float(request.get("cutThreshold", 0.45)))
        bounds = [0.0, *cuts, info["duration"]]
        segments = [{"path": source, "start": bounds[i], "end": bounds[i + 1], "label": f"shot-{i + 1:02d}"} for i in range(len(bounds) - 1) if bounds[i + 1] - bounds[i] > 0.2]  # noqa: PLR2004 -- drop slivers.
    else:
        segments = [dict(s) for s in request["inputs"]]
    per_shot = int(request.get("frames", 3))
    measured = []
    for index, seg in enumerate(segments):
        info = probe(seg["path"])
        start = float(seg.get("start") or 0.0)
        end = seg.get("end")
        span_end = float(end) if end is not None else info["duration"]
        margin = (span_end - start) * 0.1 if span_end > start else 0
        times = sample_times(info, {"frames": per_shot}, start + margin, span_end - margin)
        media = Media(seg["path"], request, times)
        measured.append((seg | {"label": seg.get("label") or f"clip-{index + 1:02d}"}, media, statistics(media, request)))
    hero_index = int(request.get("hero", 0))
    if request.get("reference"):
        ref_media = Media(request["reference"], {**request, "frames": per_shot})
        hero_stats, hero_media, hero_label = statistics(ref_media, request), ref_media, Path(request["reference"]).name
    else:
        hero_stats, hero_media, hero_label = measured[hero_index][2], measured[hero_index][1], measured[hero_index][0]["label"]
    threshold = float(request.get("tolerance", 2.5))
    shots = []
    for seg, media, stats in measured:
        zones = zone_delta(stats, hero_stats)
        findings, summary = diagnose(stats, hero_stats)
        is_hero = media is hero_media
        entry: dict[str, Any] = {
            "label": seg["label"],
            "path": seg["path"],
            "start": seg.get("start"),
            "end": seg.get("end"),
            "hero": is_hero,
            "zones": zones,
            "summary": "hero" if is_hero else summary,
            "findings": [] if is_hero else findings,
            "outOfTolerance": (not is_hero) and zones["meanDeltaE2000"] > threshold,
            "lumaMeanIre": stats["luma"]["mean"]["ire"],
            "neutralCast": stats["whiteBalance"]["cast"],
        }
        if request.get("solve") and not is_hero:
            p, curves = fit_match(media.pixels(40_000), hero_media.pixels(200_000), "stats", None)
            grade = round_grade(params_grade(p, curves))
            guard_highlights(media.pixels(40_000), grade)
            entry["grade"] = grade
            entry["metrics"] = match_metrics(media.pixels(40_000), hero_media.pixels(200_000), grade)
        shots.append(entry)
    out_dir = Path(request["output"])
    out_dir.mkdir(parents=True, exist_ok=True)
    tiles = [sc.frame_tile(m.frames[len(m.frames) // 2], f"{s['label']}  dE {s['zones']['meanDeltaE2000']:.1f}{'  HERO' if s['hero'] else ''}") for (_, m, _), s in zip(measured, shots, strict=True)]
    columns = 4
    rows = [tiles[i : i + columns] for i in range(0, len(tiles), columns)]
    sheet = out_dir / "shots.png"
    sc.write_png(str(sheet), sc.grid(rows, (480, 260), f"Shot consistency against {hero_label}  (tolerance mean zone dE2000 {threshold:g})"))
    values = [s["zones"]["meanDeltaE2000"] for s in shots if not s["hero"]]
    return {
        "ok": True,
        "hero": hero_label,
        "shots": shots,
        "consistency": {
            "maxDeltaE2000": round(max(values), 3) if values else 0.0,
            "medianDeltaE2000": round(float(np.median(values)), 3) if values else 0.0,
            "outOfTolerance": sum(1 for s in shots if s["outOfTolerance"]),
        },
        "files": {"sheet": str(sheet)},
    }


# ---------------------------------------------------------------------------------------------------------------
# LUT bake


def op_bake(request: dict[str, Any]) -> dict[str, Any]:
    """Evaluate a normalised grade on a lattice and write it as a .cube."""
    size = int(request.get("size", 33))
    grade = request["grade"]
    grid = cm.lattice(size)
    values = cm.apply_grade(grid, grade, cm.load_luts(grade))
    path = Path(request["output"])
    path.parent.mkdir(parents=True, exist_ok=True)
    cm.write_cube(path, values, size, request.get("title", "agentbros grade"), request.get("comments", []))
    delta = np.abs(values - grid)
    return {"ok": True, "path": str(path), "size": size, "maxDelta": round(float(delta.max()), 6), "meanDelta": round(float(delta.mean()), 6), "identity": bool(delta.max() < 1e-4)}  # noqa: PLR2004 -- below one 10-bit code.


def op_selftest(_request: dict[str, Any]) -> dict[str, Any]:
    """CIEDE2000 against Sharma's published pairs and the bar targets (used by the test suite)."""
    pairs = np.array(
        [
            [50.0, 2.6772, -79.7751, 50.0, 0.0, -82.7485, 2.0425],
            [50.0, 3.1571, -77.2803, 50.0, 0.0, -82.7485, 2.8615],
            [50.0, 2.5, 0.0, 50.0, 0.0, -2.5, 4.3065],
            [50.0, -0.001, 2.49, 50.0, 0.0009, -2.49, 4.8045],
            [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
            [22.7233, 20.0904, -46.694, 23.0331, 14.973, -42.5619, 2.0373],
            [90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447, 1.4441],
        ],
    )
    computed = cm.delta_e_2000(pairs[:, 0:3], pairs[:, 3:6])
    red = cm.rgb_to_ycbcr(np.array([1.0, 0.0, 0.0]))
    return {"ok": True, "deltaE2000": [round(float(v), 4) for v in computed], "expected": [float(v) for v in pairs[:, 6]], "redAngleDeg": round(float(cm.vectorscope_angle(red[1], red[2])), 3)}


# ---------------------------------------------------------------------------------------------------------------
# Dynamic windows: tracking and mask rendering


def stream_frames(path: str, width: int, height: int, fmt: str = "rgb24", start: float = 0.0) -> subprocess.Popen[bytes]:
    """Decode every frame (scaled) as a raw pipe."""
    seek = ["-ss", f"{start:.4f}"] if start > 0 else []
    return subprocess.Popen(  # noqa: S603 -- literal argument list, no shell.
        [FFMPEG, "-v", "error", "-nostdin", *seek, "-i", path, "-vf", f"scale={width}:{height}:flags=area", "-f", "rawvideo", "-pix_fmt", fmt, "-"],
        stdout=subprocess.PIPE,
    )


def shot_bounds(frames: list[np.ndarray], anchor: int, threshold: float) -> tuple[int, int]:
    """First and one-past-last frame of the shot containing `anchor`: windows are tracked inside one shot.

    A cut is a jump in the mean absolute difference of 64-pixel-wide thumbnails above `threshold` and eight
    times the clip's median frame difference (fast motion stays well below both).
    """
    import cv2

    thumbs = [cv2.resize(f, (64, max(8, round(64 * f.shape[0] / f.shape[1]))), interpolation=cv2.INTER_AREA).astype(np.float64) for f in frames]
    diff = np.array([0.0] + [float(np.abs(thumbs[i] - thumbs[i - 1]).mean() / 255) for i in range(1, len(thumbs))])
    limit = max(threshold, 8 * float(np.median(diff[1:])) if len(diff) > 1 else threshold)
    cut = diff > limit
    first = anchor
    while first > 0 and not cut[first]:
        first -= 1
    last = anchor + 1
    while last < len(frames) and not cut[last]:
        last += 1
    return first, last


def track_pass(frames: list[np.ndarray], box: tuple[int, int, int, int]) -> list[tuple[tuple[int, int, int, int], float]]:
    """Follow a box through frames by normalised cross-correlation with a slowly adapting template."""
    import cv2

    x, y, w, h = box
    template = frames[0][y : y + h, x : x + w].astype(np.float32)
    out = [((x, y, w, h), 1.0)]
    height, width = frames[0].shape[:2]
    for frame in frames[1:]:
        mx, my = max(w // 2, 8), max(h // 2, 8)
        x0, y0 = max(0, x - mx), max(0, y - my)
        x1, y1 = min(width, x + w + mx), min(height, y + h + my)
        region = frame[y0:y1, x0:x1].astype(np.float32)
        if region.shape[0] < h or region.shape[1] < w:
            out.append(((x, y, w, h), 0.0))
            continue
        scores = cv2.matchTemplate(region, template, cv2.TM_CCOEFF_NORMED)
        _, best, _, loc = cv2.minMaxLoc(scores)
        if best > 0.4:  # noqa: PLR2004 -- below this the match is not the same subject; hold position.
            x, y = x0 + loc[0], y0 + loc[1]
            template = 0.9 * template + 0.1 * frame[y : y + h, x : x + w].astype(np.float32)
        out.append(((x, y, w, h), round(float(best), 4)))
    return out


def op_track(request: dict[str, Any]) -> dict[str, Any]:
    """Track a window from one frame forward and backward through the clip; keyframes in normalised units."""
    import cv2

    info = probe(request["input"])
    if info["still"] or info["fps"] <= 0:
        fail("tracking needs a video")
    width, height = analysis_size(info, int(request.get("maxWidth", 640)))
    proc = stream_frames(request["input"], width, height, "gray")
    frame_bytes = width * height
    frames = []
    while True:
        chunk = proc.stdout.read(frame_bytes) if proc.stdout else b""
        if len(chunk) < frame_bytes:
            break
        frames.append(cv2.GaussianBlur(np.frombuffer(chunk, dtype=np.uint8).reshape(height, width), (5, 5), 0))
    proc.wait()
    if not frames:
        fail("no frames decoded")
    fps = info["fps"]
    bx, by, bw, bh = request["box"]
    sx, sy = width / info["width"], height / info["height"]
    box = (round(bx * sx), round(by * sy), max(4, round(bw * sx)), max(4, round(bh * sy)))
    anchor = min(len(frames) - 1, max(0, round(float(request.get("at", 0)) * fps)))
    first, last = shot_bounds(frames, anchor, float(request.get("cutThreshold", 0.09)))
    forward = track_pass(frames[anchor:last], box)
    backward = track_pass(frames[first : anchor + 1][::-1], box)[::-1]
    inside = backward[:-1] + forward
    path = [(inside[0][0], 0.0)] * first + inside + [(inside[-1][0], 0.0)] * (len(frames) - last)
    keyframes = [
        {
            "t": round(i / fps, 4),
            "x": round(b[0] / width, 5),
            "y": round(b[1] / height, 5),
            "w": round(b[2] / width, 5),
            "h": round(b[3] / height, 5),
            "confidence": c,
            "active": first <= i < last,
        }
        for i, (b, c) in enumerate(path)
    ]
    lost = [k["t"] for k in keyframes if k["active"] and k["confidence"] < 0.4]  # noqa: PLR2004 -- see track_pass.
    out_dir = Path(request["output"])
    out_dir.mkdir(parents=True, exist_ok=True)
    tiles = []
    for index in np.linspace(0, len(frames) - 1, 8).round().astype(int):
        tile = cv2.cvtColor(frames[index], cv2.COLOR_GRAY2RGB)
        (x, y, w, h), conf = path[index]
        cv2.rectangle(tile, (x, y), (x + w, y + h), (255, 190, 40) if conf >= 0.4 else (240, 40, 40), 2)  # noqa: PLR2004 -- see track_pass.
        tiles.append(sc.frame_tile(tile.astype(np.float64) / 255, f"t={index / fps:.2f}s  match {conf:.2f}"))
    preview = out_dir / "track-preview.png"
    sc.write_png(str(preview), sc.grid([tiles[:4], tiles[4:]], (480, 240), f"Window track  {Path(request['input']).name}"))
    return {
        "ok": True,
        "fps": fps,
        "frames": len(frames),
        "keyframes": keyframes,
        "lostTimes": lost[:50],
        "lostPct": round(100 * len(lost) / max(1, last - first), 3),
        "shot": {"start": round(first / fps, 4), "end": round(last / fps, 4)},
        "files": {"preview": str(preview)},
    }


def active_at(keyframes: list[dict[str, Any]], t: float) -> bool:
    """Whether the window is on at time t (a track is off outside its shot)."""
    times = [k["t"] for k in keyframes]
    i = max(0, int(np.searchsorted(times, t + 1e-6, side="right")) - 1)
    return bool(keyframes[i].get("active", True))


def box_at(keyframes: list[dict[str, float]], t: float) -> tuple[float, float, float, float]:
    """Linear interpolation of a keyframed box (normalised) at time t."""
    times = [k["t"] for k in keyframes]
    if t <= times[0]:
        k = keyframes[0]
        return k["x"], k["y"], k["w"], k["h"]
    if t >= times[-1]:
        k = keyframes[-1]
        return k["x"], k["y"], k["w"], k["h"]
    i = int(np.searchsorted(times, t, side="right")) - 1
    a, b = keyframes[i], keyframes[i + 1]
    f = (t - a["t"]) / max(b["t"] - a["t"], 1e-9)
    x, y, w, h = (a[key] + (b[key] - a[key]) * f for key in ("x", "y", "w", "h"))
    return x, y, w, h


def shape_mask(shape: str, box: tuple[float, float, float, float], softness: float, size: tuple[int, int]) -> np.ndarray:
    """A soft ellipse or rectangle window, 0..1, softness as a fraction of the box size."""
    width, height = size
    x, y, w, h = box
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float64)
    u = ((xx + 0.5) / width - (x + w / 2)) / max(w / 2, 1e-6)
    v = ((yy + 0.5) / height - (y + h / 2)) / max(h / 2, 1e-6)
    distance = np.hypot(u, v) if shape == "ellipse" else np.maximum(np.abs(u), np.abs(v))
    soft = max(softness, 1e-3)
    t = np.clip((1 + soft - distance) / (2 * soft), 0, 1)
    return t * t * (3 - 2 * t)


def op_mask(request: dict[str, Any]) -> dict[str, Any]:
    """Render a shape window (static or keyframed) as a lossless grey matte video matching the input's timing."""
    info = probe(request["input"])
    size = (info["width"], info["height"])
    fps = info["fps"] if info["fps"] > 0 else 25.0
    count = 1 if info["still"] else max(1, round(info["duration"] * fps))
    keyframes = request.get("keyframes") or [{"t": 0.0, **dict(zip(("x", "y", "w", "h"), request["box"], strict=True))}]
    output = request["output"]
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    encoder = subprocess.Popen(  # noqa: S603 -- literal argument list, no shell.
        [FFMPEG, "-v", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{size[0]}x{size[1]}", "-r", f"{fps:.6f}", "-i", "-", "-c:v", "ffv1", "-pix_fmt", "gray", output],
        stdin=subprocess.PIPE,
    )
    coverage = []
    for index in range(count):
        t = index / fps
        on = active_at(keyframes, t)
        mask = shape_mask(request.get("shape", "ellipse"), box_at(keyframes, t), float(request.get("softness", 0.2)), size) if on else np.zeros((size[1], size[0]))
        if request.get("invert"):
            mask = 1 - mask
        coverage.append(float(mask.mean()))
        if encoder.stdin:
            encoder.stdin.write((mask * 255).round().astype(np.uint8).tobytes())
    if encoder.stdin:
        encoder.stdin.close()
    if encoder.wait() != 0:
        fail("mask encode failed")
    return {"ok": True, "path": output, "frames": count, "fps": fps, "meanCoveragePct": round(100 * float(np.mean(coverage)), 3)}


OPERATIONS = {
    "scopes": op_scopes,
    "compare": op_compare,
    "match": op_match,
    "shots": op_shots,
    "bake": op_bake,
    "track": op_track,
    "mask": op_mask,
    "check": op_check,
    "looks": op_looks,
    "selftest": op_selftest,
}


def main() -> None:
    """Dispatch one operation."""
    if len(sys.argv) != 3 or sys.argv[1] not in OPERATIONS:  # noqa: PLR2004 -- operation and request file.
        fail(f"usage: colour.py <{'|'.join(OPERATIONS)}> <request.json>")
    request = json.loads(Path(sys.argv[2]).read_text(encoding="utf8"))
    result = OPERATIONS[sys.argv[1]](request)
    sys.stdout.write(json.dumps(result, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
