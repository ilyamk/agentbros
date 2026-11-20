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
import colour_maths as cm  # noqa: E402
import colour_scopes as sc  # noqa: E402

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
    raw = run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,pix_fmt,color_space,color_range,color_transfer,color_primaries,r_frame_rate,duration:format=duration,format_name", "-of", "json", path])
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


def statistics(media: Media, request: dict[str, Any]) -> dict[str, Any]:  # noqa: PLR0914 -- one flat measurement record.
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
        rx, ry, rw, rh = request["skinRegion"]
        sx = media.size[0] / media.info["width"]
        sy = media.size[1] / media.info["height"]
        x0, y0 = round(rx * sx) - media.crop[0], round(ry * sy) - media.crop[1]
        masks = []
        for frame in media.frames:
            m = np.zeros(frame.shape[:2], dtype=bool)
            m[max(y0, 0) : max(y0 + round(rh * sy), 0), max(x0, 0) : max(x0 + round(rw * sx), 0)] = True
            masks.append(m.ravel())
        region_mask = np.concatenate(masks)[:: max(1, math.ceil(sum(f.shape[0] * f.shape[1] for f in media.frames) / MAX_STAT_PIXELS))]
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
        out[zone] = {"dL": round(za["L"] - zb["L"], 3), "da": round(za["a"] - zb["a"], 3), "db": round(za["b"] - zb["b"], 3), "dC": round(za["C"] - zb["C"], 3), "deltaE2000": round(float(cm.delta_e_2000(lab_a, lab_b)), 3)}
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
    out = {"available": True, "lumaCorrelation": round(alignment, 4), "deltaE2000": {"mean": round(float(de.mean()), 3), "median": round(float(np.median(de)), 3), "p95": round(float(np.percentile(de, 95)), 3)}}
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


def fit_match(source: np.ndarray, target: np.ndarray, method: str, paired_pairs: tuple[np.ndarray, np.ndarray] | None) -> tuple[np.ndarray, dict[str, Any] | None]:
    """Solve lift/gamma/gain per channel and saturation (and a master curve) toward the reference."""
    from scipy.optimize import least_squares

    target_features = cm.match_features(cm.rgb_to_lab(np.clip(target, 0, 1)))
    regulariser = np.array([2, 2, 2, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5])

    def residual_stats(p: np.ndarray, curves: dict[str, Any] | None = None) -> np.ndarray:
        graded = cm.apply_grade(source, params_grade(p, curves))
        return np.concatenate([cm.match_features(cm.rgb_to_lab(graded)) - target_features, (p - IDENTITY) * regulariser])

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
    points = [pt for i, pt in enumerate(points) if i == 0 or pt[0] > points[i - 1][0] + 0.005]  # noqa: PLR2004 -- distinct x.
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

    return {"zoneDeltaE2000Before": score(source), "zoneDeltaE2000After": score(cm.apply_grade(source, grade))}


def op_match(request: dict[str, Any]) -> dict[str, Any]:
    """Fit an editable grade that brings the input toward the reference, with before/after evidence."""
    a = Media(request["input"], request)
    b_request = {**request, "crop": request.get("referenceCrop", "auto")}
    b = Media(request["reference"], b_request, paired_times(a, probe(request["reference"]), request))
    source = a.pixels(40_000)
    target = b.pixels(200_000)
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
    p, curves = fit_match(source, target, method, paired_pairs)
    strength = float(request.get("strength", 1.0))
    p, curves = soften(p, curves, strength)
    grade = round_grade(params_grade(p, curves))
    metrics = match_metrics(source, target, grade)
    out_dir = Path(request["output"])
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for index in range(min(len(a.frames), 4)):
        graded = cm.apply_grade(a.frames[index], grade)
        rows.append([sc.frame_tile(a.frames[index], "input"), sc.frame_tile(graded, "graded (match)"), sc.frame_tile(b.frames[index], "reference")])
    preview = out_dir / "match-preview.png"
    sc.write_png(str(preview), sc.grid(rows, (640, 300), f"Match preview  {Path(a.path).name} -> {Path(b.path).name}  zone dE2000 {metrics['zoneDeltaE2000Before']['mean']:.2f} -> {metrics['zoneDeltaE2000After']['mean']:.2f}"))
    return {"ok": True, "grade": grade, "method": method, "strength": strength, "metrics": metrics, "input": a.describe(), "reference": b.describe(), "files": {"preview": str(preview)}}


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


def op_shots(request: dict[str, Any]) -> dict[str, Any]:  # noqa: PLR0914 -- one record per shot.
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
        "consistency": {"maxDeltaE2000": round(max(values), 3) if values else 0.0, "medianDeltaE2000": round(float(np.median(values)), 3) if values else 0.0, "outOfTolerance": sum(1 for s in shots if s["outOfTolerance"])},
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


OPERATIONS = {"scopes": op_scopes, "compare": op_compare, "match": op_match, "shots": op_shots, "bake": op_bake, "selftest": op_selftest}


def main() -> None:
    """Dispatch one operation."""
    if len(sys.argv) != 3 or sys.argv[1] not in OPERATIONS:  # noqa: PLR2004 -- operation and request file.
        fail(f"usage: colour.py <{'|'.join(OPERATIONS)}> <request.json>")
    request = json.loads(Path(sys.argv[2]).read_text(encoding="utf8"))
    result = OPERATIONS[sys.argv[1]](request)
    sys.stdout.write(json.dumps(result, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
