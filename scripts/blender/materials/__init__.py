# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Directed, metre-scale procedural surfaces; functions return reusable shader node trees.

Colours are scene-linear RGBA. No images, network, randomness or own animation clocks.
Use material(tree) to attach a returned group to a mesh. Knobs describe physical intent,
not measured optical constants; preview under both soft-product and rim-hero before use.
"""

from __future__ import annotations

from typing import Any


def _surface(name: str, colour: tuple[float, ...], roughness: float, **inputs: float) -> tuple[Any, Any]:
    import bpy

    if not 0 <= roughness <= 1 or len(colour) != 4 or any(not 0 <= c <= 1 for c in colour):
        msg = "Expected linear RGBA and roughness in [0, 1]"
        raise ValueError(msg)
    tree = bpy.data.node_groups.new("AVC " + name, "ShaderNodeTree")
    tree.interface.new_socket(name="Shader", in_out="OUTPUT", socket_type="NodeSocketShader")
    shader = tree.nodes.new("ShaderNodeBsdfPrincipled")
    shader.inputs["Base Color"].default_value = colour
    shader.inputs["Roughness"].default_value = roughness
    for key, value in inputs.items():
        shader.inputs[key.replace("_", " ")].default_value = value
    out = tree.nodes.new("NodeGroupOutput")
    tree.links.new(shader.outputs["BSDF"], out.inputs["Shader"])
    return tree, shader


def _grain(tree: Any, shader: Any, scale: float, strength: float, stretch: tuple[float, ...] = (1, 1, 1)) -> None:
    coord = tree.nodes.new("ShaderNodeTexCoord")
    mapping = tree.nodes.new("ShaderNodeVectorMath")
    mapping.operation = "MULTIPLY"
    mapping.inputs[1].default_value = stretch
    tree.links.new(coord.outputs["Object"], mapping.inputs[0])
    noise = tree.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = scale
    noise.inputs["Detail"].default_value = 2
    tree.links.new(mapping.outputs["Vector"], noise.inputs["Vector"])
    bump = tree.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = strength
    bump.inputs["Distance"].default_value = 0.001
    tree.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    tree.links.new(bump.outputs["Normal"], shader.inputs["Normal"])


def brushed_metal(colour: tuple[float, ...] = (0.55, 0.59, 0.65, 1), roughness: float = 0.27, grain: float = 0.16) -> Any:
    """Stretch fine machining marks across cool metal; strip reflections reveal the brushing."""
    tree, shader = _surface("Brushed metal", colour, roughness, Metallic=1, Anisotropic=0.65)
    _grain(tree, shader, 220, grain, (1, 45, 1))
    return tree


def anodised_metal(colour: tuple[float, ...] = (0.19, 0.038, 0.012, 1), roughness: float = 0.3) -> Any:
    """Colour an oxide skin over aluminium with restrained micrograin."""
    tree, shader = _surface("Anodised metal", colour, roughness, Metallic=0.85, Coat_Weight=0.18, Coat_Roughness=0.24)
    _grain(tree, shader, 380, 0.08)
    return tree


def frosted_glass(colour: tuple[float, ...] = (0.82, 0.93, 0.97, 1), roughness: float = 0.28, ior: float = 1.46) -> Any:
    """Diffuse transmitted highlights through etched glass; give the mesh real thickness."""
    tree, shader = _surface("Frosted glass", colour, roughness, Transmission_Weight=1, IOR=ior)
    _grain(tree, shader, 480, 0.045)
    return tree


def tinted_glass(colour: tuple[float, ...] = (0.68, 0.88, 0.78, 1), roughness: float = 0.035, ior: float = 1.46) -> Any:
    """Clear tinted glass with clean grazing reflections; closed geometry supplies refraction."""
    return _surface("Tinted glass", colour, roughness, Transmission_Weight=1, IOR=ior)[0]


def car_paint(colour: tuple[float, ...] = (0.31, 0.012, 0.023, 1), roughness: float = 0.23, coat: float = 1) -> Any:
    """Layer a smooth clearcoat over a fine metallic base for long automotive light cards."""
    tree, shader = _surface("Clearcoat paint", colour, roughness, Metallic=0.65, Coat_Weight=coat, Coat_Roughness=0.07)
    _grain(tree, shader, 650, 0.035)
    return tree


def fabric(colour: tuple[float, ...] = (0.14, 0.21, 0.28, 1), roughness: float = 0.78) -> Any:
    """Woven fabric softens broad keys; fine crossed fibres remain subtle at product scale."""
    tree, shader = _surface("Fabric", colour, roughness, Sheen_Weight=0.3, Sheen_Roughness=0.65)
    _grain(tree, shader, 500, 0.5, (1, 1, 0.25))
    return tree


def velvet(colour: tuple[float, ...] = (0.14, 0.009, 0.031, 1), roughness: float = 0.85) -> Any:
    """Deep velvet keeps the centre dark and carries a soft coloured edge sheen."""
    tree, shader = _surface("Velvet", colour, roughness, Sheen_Weight=1, Sheen_Roughness=0.45)
    _grain(tree, shader, 700, 0.14)
    return tree


def ceramic(colour: tuple[float, ...] = (0.78, 0.69, 0.51, 1), roughness: float = 0.2) -> Any:
    """Create a warm fired glaze with minute unevenness for a broad soft key."""
    tree, shader = _surface("Ceramic", colour, roughness, Coat_Weight=0.4, Coat_Roughness=0.15)
    _grain(tree, shader, 160, 0.05)
    return tree


def iridescent(colour: tuple[float, ...] = (0.22, 0.28, 0.31, 1), thickness_nm: float = 430, roughness: float = 0.16) -> Any:
    """Shift hue with a physical thin film; thickness is in nanometres."""
    return _surface("Thin film", colour, roughness, Metallic=0.6, Thin_Film_Thickness=thickness_nm, Thin_Film_IOR=1.35)[0]


def holographic(colour: tuple[float, ...] = (0.45, 0.49, 0.57, 1), thickness_nm: float = 780, roughness: float = 0.19) -> Any:
    """Embossed foil combines directional grooves and thin film; no fake emissive rainbow."""
    tree = iridescent(colour, thickness_nm, roughness)
    tree.name = "AVC Holographic foil"
    shader = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
    shader.inputs["Metallic"].default_value = 1
    _grain(tree, shader, 360, 0.12, (1, 60, 1))
    return tree


def liquid(colour: tuple[float, ...] = (0.98, 0.53, 0.055, 1), roughness: float = 0.055, pulp: float = 0.025) -> Any:
    """Translucent juice has a wet meniscus and slight pulp scattering, never a metallic shell."""
    tree, shader = _surface("Juice", colour, roughness, Transmission_Weight=0.93, IOR=1.333, Subsurface_Weight=pulp)
    shader.inputs["Subsurface Radius"].default_value = (0.14, 0.065, 0.018)
    return tree


def ice(colour: tuple[float, ...] = (0.84, 0.94, 0.98, 1), roughness: float = 0.1) -> Any:
    """Cold clear ice with a fractured micro surface; rounded geometry catches backlight."""
    tree, shader = _surface("Ice", colour, roughness, Transmission_Weight=1, IOR=1.31)
    _grain(tree, shader, 34, 0.3)
    return tree


def soft_plastic(colour: tuple[float, ...] = (0.19, 0.36, 0.51, 1), roughness: float = 0.46) -> Any:
    """Soft moulded polymer breaks its broad highlight with a fine tactile stipple."""
    tree, shader = _surface("Soft plastic", colour, roughness, Subsurface_Weight=0.035)
    _grain(tree, shader, 330, 0.12)
    return tree


def material(tree: Any) -> Any:
    """Wrap a reusable surface group in a material, without changing the group."""
    import bpy

    result = bpy.data.materials.new(tree.name)
    result.use_nodes = True
    result.node_tree.nodes.clear()
    group = result.node_tree.nodes.new("ShaderNodeGroup")
    group.node_tree = tree
    out = result.node_tree.nodes.new("ShaderNodeOutputMaterial")
    result.node_tree.links.new(group.outputs["Shader"], out.inputs["Surface"])
    return result


SURFACES = {
    "brushed-metal": brushed_metal,
    "anodised-metal": anodised_metal,
    "frosted-glass": frosted_glass,
    "tinted-glass": tinted_glass,
    "car-paint": car_paint,
    "fabric": fabric,
    "velvet": velvet,
    "ceramic": ceramic,
    "iridescent": iridescent,
    "holographic": holographic,
    "liquid": liquid,
    "ice": ice,
    "soft-plastic": soft_plastic,
}
