# SPDX-License-Identifier: GPL-3.0-or-later
"""Bound diagnostic outputs shared by the explicit Vork-to-Cycles routes."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pathlib import Path

import bpy


def subject_masks(tree: bpy.types.CompositorNodeTree, layers: bpy.types.CompositorNodeRLayers, output: Path) -> None:
    """Write a direct full-resolution mask of meshes carrying subject pass index one."""
    silhouette = tree.nodes.new("CompositorNodeIDMask")
    silhouette.inputs["Index"].default_value = 1
    tree.links.new(layers.outputs["Object Index"], silhouette.inputs[0])
    masks = tree.nodes.new("CompositorNodeOutputFile")
    masks.directory = str(output / "masks")
    masks.file_name = "frame-"
    masks.format.media_type = "IMAGE"
    masks.format.file_format = "PNG"
    masks.format.color_mode = "BW"
    masks.format.color_depth = "8"
    masks.save_as_render = False
    masks.file_output_items.new("FLOAT", "hero")
    tree.links.new(silhouette.outputs[0], masks.inputs[0])


def linear_passes(output: Path) -> None:
    """Retain scene-linear compositor pixels and all enabled Cycles passes."""
    linear = output / "linear"
    linear.mkdir()

    def save_linear(rendered_scene: bpy.types.Scene, _depsgraph: bpy.types.Depsgraph | None = None) -> None:
        """Keep display settings out of the multilayer scene-linear EXR."""
        settings = rendered_scene.render.image_settings
        previous = (settings.file_format, settings.color_depth, settings.color_mode)
        settings.media_type = "MULTI_LAYER_IMAGE"
        settings.file_format = "OPEN_EXR_MULTILAYER"
        settings.color_depth = "16"
        settings.color_mode = "RGBA"
        bpy.data.images["Render Result"].save_render(str(linear / f"frame-{rendered_scene.frame_current:06d}.exr"), scene=rendered_scene)
        settings.media_type = "IMAGE"
        settings.file_format, settings.color_depth, settings.color_mode = previous

    bpy.app.handlers.render_write.append(save_linear)
