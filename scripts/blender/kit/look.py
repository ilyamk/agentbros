# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Look and colour: view transform per mood, motion blur, the compositor grade, and screens that keep their colour.

    look.apply(scene, "agx", exposure=0.0)        # kit.presets.VIEWS: view transform and look, with the reason
    look.motion_blur(scene, shutter=0.5)           # on by default for anything fast; 0.25 keeps fast detail readable
    look.grade(scene, "filmic")                    # bloom, vignette, warmth, lift: kit.presets.GRADES
    mat = look.screen_material("ui", "path/to/ui.png", scene)   # emissive screen that shows its true sRGB colours

Screens: AgX desaturates bright colour by design, so a UI emitted at strength 1 through AgX renders greyer than the
PNG. The texture is tagged with the inverse of the view ("AgX Base sRGB" under AgX), so the emission comes out as the
source colours. Measured on saturated patches: sRGB-tagged through AgX turned (0.78, 0.95, 0.49) into (0.69, 0.75, 0.55);
inverse-tagged it renders (0.75, 0.89, 0.49); Standard is exact but clips the rest of the scene. Pair it with a view
whose look is None ("agx-base"): any AgX look (Punchy, contrast) moves the screen again.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import TYPE_CHECKING

import bpy

from . import presets
from .light import hex_linear

if TYPE_CHECKING:
    from collections.abc import Sequence


def apply(scene: bpy.types.Scene, view: str = "agx", exposure: float = 0.0) -> dict[str, str]:
    """Sets the view transform and look from kit.presets.VIEWS (the reason is in the table)."""
    spec = presets.VIEWS[view]
    scene.view_settings.view_transform = spec["view"]
    try:
        scene.view_settings.look = spec["look"]
    except TypeError:
        scene.view_settings.look = "None"
    scene.view_settings.exposure = exposure
    scene.view_settings.gamma = 1.0
    return spec


def motion_blur(scene: bpy.types.Scene, shutter: float = 0.5, on: bool = True) -> bpy.types.Scene:
    """Camera-shutter motion blur. 0.5 is a 180-degree film shutter; 0.25 to 0.3 for fast moves that must stay legible."""
    scene.render.use_motion_blur = on
    scene.render.motion_blur_shutter = shutter
    scene.render.motion_blur_position = "CENTER"
    return scene


def grade(scene: bpy.types.Scene, preset: str = "clean", background: str | Sequence[float] | None = None, **overrides: float) -> bpy.types.NodeTree:
    r"""Build the scene-linear compositor grade from the selected preset.

    A compositor grade (Blender 5 node group on scene.compositing_node_group): bloom from Glare, a radial vignette
    from image coordinates (resolution independent), warmth and lift from Color Balance, saturation, and a touch of
    lens dispersion for filmic. Runs in scene-linear light before the view transform.

    `background` (hex) composites a transparent render (film_transparent, shadow catchers included) over that exact
    colour first: under the Standard view the ground equals the hex, with the subject's real contact shadow on it.
    """
    g = {**presets.GRADES[preset], **overrides}
    tree = bpy.data.node_groups.new(f"grade-{preset}", "CompositorNodeTree")
    tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    nodes, links = tree.nodes, tree.links
    layers = nodes.new("CompositorNodeRLayers")
    layers.scene = scene
    image = layers.outputs["Image"]
    if background:
        over = nodes.new("CompositorNodeAlphaOver")
        over.inputs["Background"].default_value = (*hex_linear(background), 1.0)
        links.new(image, over.inputs["Foreground"])
        image = over.outputs["Image"]
    if g["bloom"] > 0:
        glare = nodes.new("CompositorNodeGlare")
        glare.inputs["Type"].default_value = "Bloom"
        glare.inputs["Quality"].default_value = "High"
        glare.inputs["Threshold"].default_value = g["threshold"]
        glare.inputs["Strength"].default_value = g["bloom"]
        glare.inputs["Size"].default_value = 0.6
        links.new(image, glare.inputs["Image"])
        image = glare.outputs["Image"]
    if g["dispersion"] > 0:
        lens = nodes.new("CompositorNodeLensdist")
        lens.inputs["Dispersion"].default_value = g["dispersion"]
        lens.inputs["Distortion"].default_value = 0.0
        lens.inputs["Fit"].default_value = False
        links.new(image, lens.inputs["Image"])
        image = lens.outputs["Image"]
    if g["warmth"] or g["lift"]:
        balance = nodes.new("CompositorNodeColorBalance")
        balance.inputs["Type"].default_value = "Offset/Power/Slope (ASC-CDL)"
        w = g["warmth"]
        # Slope (gain) warms highlights, offset lifts blacks: the two print-like moves, kept small.
        slopes = [s for s in balance.inputs if s.name == "Slope" and s.type == "RGBA"]
        offsets = [s for s in balance.inputs if s.name == "Offset" and s.type == "RGBA"]
        if slopes:
            slopes[0].default_value = (1 + w, 1 + w * 0.35, 1 - w * 0.6, 1)
        if offsets:
            offsets[0].default_value = (g["lift"], g["lift"], g["lift"] * 1.15, 1)
        links.new(image, balance.inputs["Image"])
        image = balance.outputs["Image"]
    if abs(g["saturation"] - 1.0) > 1e-6:
        hue = nodes.new("CompositorNodeHueSat")
        hue.inputs["Saturation"].default_value = g["saturation"]
        links.new(image, hue.inputs["Image"])
        image = hue.outputs["Image"]
    if g["vignette"] > 0:
        coords = nodes.new("CompositorNodeImageCoordinates")
        links.new(layers.outputs["Image"], coords.inputs["Image"])
        length = nodes.new("ShaderNodeVectorMath")
        length.operation = "LENGTH"
        links.new(coords.outputs["Uniform"], length.inputs[0])
        ramp = nodes.new("ShaderNodeMapRange")
        ramp.interpolation_type = "SMOOTHSTEP"
        ramp.inputs["From Min"].default_value = 0.55
        ramp.inputs["From Max"].default_value = 1.35
        ramp.inputs["To Min"].default_value = 1.0
        ramp.inputs["To Max"].default_value = 1.0 - g["vignette"]
        links.new(length.outputs["Value"], ramp.inputs["Value"])
        darken = nodes.new("ShaderNodeMix")
        darken.data_type = "RGBA"
        darken.blend_type = "MULTIPLY"
        darken.inputs["Factor"].default_value = 1.0
        links.new(image, darken.inputs["A"])
        links.new(ramp.outputs["Result"], darken.inputs["B"])
        image = darken.outputs["Result"]
    out = nodes.new("NodeGroupOutput")
    links.new(image, out.inputs[0])
    scene.compositing_node_group = tree
    return tree


def screen_colourspace(scene: bpy.types.Scene) -> str:
    """Return the inverse view colourspace used for emissive screens."""
    return presets.SCREEN_COLOURSPACE.get(scene.view_settings.view_transform, "sRGB")


def gradient_image(name: str, top: str | Sequence[float], bottom: str | Sequence[float], width: int = 8, height: int = 256) -> bpy.types.Image:
    """A vertical gradient as an image (so it can carry the inverse view colourspace like a real UI capture)."""

    def srgb(value: str | Sequence[float]) -> Sequence[float]:
        if not isinstance(value, str):
            return value
        value = value.lstrip("#")
        return [int(value[i : i + 2], 16) / 255 for i in (0, 2, 4)]

    t, b = srgb(top), srgb(bottom)
    image = bpy.data.images.new(name, width, height, alpha=False)
    pixels = []
    for y in range(height):
        u = y / (height - 1)
        row = [b[i] + (t[i] - b[i]) * u for i in range(3)] + [1.0]
        pixels.extend(row * width)
    image.pixels = pixels
    image.pack()
    return image


def screen_material(name: str, source: bpy.types.Image | str, scene: bpy.types.Scene, strength: float = 1.0, gloss: float = 0.035) -> tuple[bpy.types.Material, bpy.types.Node]:
    """An emissive display under glass: `source` is an image path, a bpy image, or a folder of numbered frames.

    Emission strength stays 1.0 so the inverse colourspace round-trips; brightness is a scene exposure question, not a
    screen one. The glass coat keeps real reflections of the set on the display.
    """
    mat = bpy.data.materials.new(name)
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0, 0, 0, 1)
    bsdf.inputs["Roughness"].default_value = gloss
    bsdf.inputs["Specular IOR Level"].default_value = 0.25
    tex = nodes.new("ShaderNodeTexImage")
    tex.extension = "EXTEND"
    tex.interpolation = "Cubic"
    if isinstance(source, bpy.types.Image):
        image = source
    elif Path(source).is_dir():
        files = sorted(f for f in [entry.name for entry in Path(source).iterdir()] if f.lower().endswith((".png", ".jpg", ".jpeg")))
        image = bpy.data.images.load(str(Path(source).joinpath(files[0])))
        image.source = "SEQUENCE"
        user = tex.image_user
        user.frame_duration = len(files)
        user.frame_start = 1
        digits = re.findall(r"\d+", Path(files[0]).stem)
        user.frame_offset = int(digits[-1]) - 1 if digits else 0
        user.use_auto_refresh = True
    else:
        image = bpy.data.images.load(source, check_existing=True)
    image.colorspace_settings.name = screen_colourspace(scene)
    tex.image = image
    links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = strength
    return mat, tex
