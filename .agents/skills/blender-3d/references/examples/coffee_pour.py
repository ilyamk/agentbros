# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Coffee beans pour from an off-frame hopper into a stoneware bowl: a real rigid-body flow, Cycles light and depth of field.

Two stages, so that look changes never re-run the simulation:
  sim  ASSET_DIR BLEND   builds the physics scene, bakes it and saves BLEND with the cache inside. Run with --no-render.
  look ASSET_DIR FIRST LAST   opens that BLEND (--blend) and adds meshes, materials, light and camera.

World units are ten times real size (a bean is 0.12 long), because Bullet is unstable with tiny objects.
"""

import math
import os
import random
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

import avc_export

BEANS = 1320
SIM_END = 220
PREFILL_FRAMES = 50
PREFILL_RATE = 6
POUR_RATE = 7
GRAVITY = 24.0  # A quarter of the true value at this scale: a slow-motion pour that keeps beans readable.
BOWL_SCALE = 0.62
FEED_SPEED = 0.15
RELEASE_Z = 3.25
SEED = 11
BOWL_PROFILE = [(0.0, 0.03), (0.34, 0.03), (0.38, 0.0), (0.46, 0.0), (0.52, 0.05), (0.74, 0.26), (0.90, 0.52), (0.975, 0.70), (0.985, 0.725), (0.97, 0.735), (0.945, 0.72), (0.87, 0.54), (0.70, 0.30), (0.46, 0.12), (0.2, 0.085), (0.0, 0.08)]
FUNNEL_PROFILE = [(0.62, 3.1), (0.25, 2.45), (0.25, 2.2)]
FUNNEL_AXIS = (-0.06, 0.02)


def lathe(name, profile, segments, closed=True, offset=(0.0, 0.0)):
    mesh = bpy.data.meshes.new(name)
    rings = len(profile)
    verts = [(offset[0] + r * math.cos(2 * math.pi * s / segments), offset[1] + r * math.sin(2 * math.pi * s / segments), z) for r, z in profile for s in range(segments)]
    faces = [(i * segments + s, i * segments + (s + 1) % segments, (i + 1) * segments + (s + 1) % segments, (i + 1) * segments + s) for i in range(rings - 1) for s in range(segments)]
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    if closed:
        target = bmesh.new()
        target.from_mesh(mesh)
        bmesh.ops.remove_doubles(target, verts=target.verts, dist=1e-5)
        bmesh.ops.recalc_face_normals(target, faces=target.faces)
        target.to_mesh(mesh)
        target.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    return obj


def bean_mesh(name, rings, segments):
    """A roasted bean: rounded back, flatter face, S-curved crease. `crease` drives the darkened shader line."""
    theta = np.linspace(0, np.pi, rings)
    phi = np.linspace(0, 2 * np.pi, segments, endpoint=False)
    grid_theta, grid_phi = np.meshgrid(theta, phi, indexing="ij")
    x = 0.062 * np.cos(grid_theta)
    y = 0.044 * np.sin(grid_theta) * np.cos(grid_phi)
    z = 0.040 * np.sin(grid_theta) * np.sin(grid_phi)
    z = np.where(z < 0, z * 0.5, z)
    centre = 0.007 * np.sin(x / 0.062 * 2.6)
    crease = np.exp(-(((y - centre) / 0.0052) ** 2)) * (z < 0) * np.clip(np.sin(grid_theta) * 1.6 - 0.45, 0, 1)
    z = z + crease * 0.012
    y = y + 0.003 * np.sign(y - centre) * crease
    points = np.stack([x, y, z], axis=-1).reshape(-1, 3)
    faces = [(i * segments + s, i * segments + (s + 1) % segments, (i + 1) * segments + (s + 1) % segments, (i + 1) * segments + s) for i in range(rings - 1) for s in range(segments)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(p) for p in points], [], faces)
    target = bmesh.new()
    target.from_mesh(mesh)
    layer = target.verts.layers.float.new("crease")
    flat = crease.reshape(-1)
    for vertex in target.verts:
        vertex[layer] = float(flat[vertex.index])
    bmesh.ops.remove_doubles(target, verts=target.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(target, faces=target.faces)
    target.to_mesh(mesh)
    target.free()
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    mesh.update()
    return mesh


def stage_sim(blend):
    random.seed(SEED)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = 30
    scene.frame_start, scene.frame_end = 1, SIM_END
    bpy.ops.rigidbody.world_add()
    world = scene.rigidbody_world
    world.substeps_per_frame = 8
    world.solver_iterations = 12
    world.point_cache.frame_start, world.point_cache.frame_end = 1, SIM_END
    scene.gravity = (0, 0, -GRAVITY)
    world.collection = bpy.data.collections.new("Physics")
    scene.collection.children.link(world.collection)

    bowl = lathe("Bowl", [(r * BOWL_SCALE, z * BOWL_SCALE) for r, z in BOWL_PROFILE], 192)
    funnel = lathe("Funnel", FUNNEL_PROFILE, 48, closed=False, offset=FUNNEL_AXIS)
    bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0))
    table = bpy.context.active_object
    table.name = "Table"

    # Beans queue above the funnel on a slow kinematic feed and turn dynamic one by one. Held beans cost the
    # solver nothing, unlike a packed hopper, and the funnel still gives them real tumbling and a real stream.
    low = bean_mesh("BeanLow", 7, 8)
    spacing = 0.135
    slots = [(ix * spacing, iy * spacing) for ix in range(-3, 4) for iy in range(-3, 4) if math.hypot(ix, iy) * spacing < 0.36]
    random.shuffle(slots)
    bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
    beans = []
    for index in range(BEANS):
        prefill = PREFILL_FRAMES * PREFILL_RATE
        release = 2 + (index // PREFILL_RATE if index < prefill else PREFILL_FRAMES + (index - prefill) // POUR_RATE)
        x, y = slots[index % len(slots)]
        bean = bpy.data.objects.new(f"Bean{index:04d}", low)
        scene.collection.objects.link(bean)
        bean.rotation_euler = Euler([random.uniform(0, math.tau) for _ in range(3)])
        place = (FUNNEL_AXIS[0] + x + random.uniform(-0.01, 0.01), FUNNEL_AXIS[1] + y + random.uniform(-0.01, 0.01))
        bean.location = (*place, RELEASE_Z + FEED_SPEED * (release - 1))
        bean.keyframe_insert("location", frame=1)
        bean.location = (*place, RELEASE_Z)
        bean.keyframe_insert("location", frame=release)
        beans.append((bean, release))

    objects = [bean for bean, _ in beans]
    with bpy.context.temp_override(selected_objects=objects, selected_editable_objects=objects):
        bpy.ops.rigidbody.objects_add(type="ACTIVE")
    with bpy.context.temp_override(selected_objects=[bowl, funnel, table], selected_editable_objects=[bowl, funnel, table]):
        bpy.ops.rigidbody.objects_add(type="PASSIVE")
    for obj, shape, friction, bounce in ((bowl, "MESH", 0.55, 0.2), (funnel, "MESH", 0.1, 0.05), (table, "BOX", 0.7, 0.25)):
        obj.rigid_body.collision_shape = shape
        obj.rigid_body.friction = friction
        obj.rigid_body.restitution = bounce
        obj.rigid_body.use_margin = True
        obj.rigid_body.collision_margin = 0.004
    for bean, release in beans:
        body = bean.rigid_body
        body.kinematic = True
        body.keyframe_insert("kinematic", frame=1)
        body.keyframe_insert("kinematic", frame=release)
        body.kinematic = False
        body.keyframe_insert("kinematic", frame=release + 1)
        body.collision_shape = "CONVEX_HULL"
        body.mesh_source = "BASE"
        body.mass = 0.1
        body.friction = 0.55
        body.restitution = 0.3
        body.use_margin = True
        body.collision_margin = 0.002
        body.linear_damping = 0.0
        body.angular_damping = 0.05
        body.use_deactivation = True

    os.makedirs(os.path.dirname(blend), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=blend)
    print(f"Baking {len(beans)} beans over {SIM_END} frames", flush=True)
    with bpy.context.temp_override(scene=scene, point_cache=world.point_cache):
        bpy.ops.ptcache.bake(bake=True)
    scene.frame_set(SIM_END)
    inside = sum(1 for b in objects if math.hypot(*b.matrix_world.translation.xy) < BOWL_SCALE and b.matrix_world.translation.z < 1.2)
    falling = sum(1 for b in objects if b.matrix_world.translation.z >= 1.2)
    print(f"At the last frame: {inside} in the bowl, {falling} still above it", flush=True)
    bpy.ops.wm.save_as_mainfile(filepath=blend)


def image_node(tree, path, colour):
    node = tree.nodes.new("ShaderNodeTexImage")
    node.image = bpy.data.images.load(path, check_existing=True)
    node.image.colorspace_settings.name = "sRGB" if colour else "Non-Color"
    return node


def wood_material(asset_dir):
    material = bpy.data.materials.new("DarkWood")
    material.use_nodes = True
    tree = material.node_tree
    shader = tree.nodes["Principled BSDF"]
    coords = tree.nodes.new("ShaderNodeTexCoord")
    mapping = tree.nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (0.11, 0.11, 1)
    mapping.inputs["Rotation"].default_value = (0, 0, math.radians(86))
    tree.links.new(coords.outputs["Object"], mapping.inputs["Vector"])
    diffuse = image_node(tree, os.path.join(asset_dir, "dark_wood_diff_2k.jpg"), True)
    rough = image_node(tree, os.path.join(asset_dir, "dark_wood_rough_2k.jpg"), False)
    normal_map = image_node(tree, os.path.join(asset_dir, "dark_wood_nor_gl_2k.jpg"), False)
    normal = tree.nodes.new("ShaderNodeNormalMap")
    normal.inputs["Strength"].default_value = 0.7
    grade = tree.nodes.new("ShaderNodeHueSaturation")
    grade.inputs["Value"].default_value = 0.3
    grade.inputs["Saturation"].default_value = 0.55
    for node in (diffuse, rough, normal_map):
        tree.links.new(mapping.outputs["Vector"], node.inputs["Vector"])
    tree.links.new(diffuse.outputs["Color"], grade.inputs["Color"])
    tree.links.new(grade.outputs["Color"], shader.inputs["Base Color"])
    tree.links.new(rough.outputs["Color"], shader.inputs["Roughness"])
    tree.links.new(normal_map.outputs["Color"], normal.inputs["Color"])
    tree.links.new(normal.outputs["Normal"], shader.inputs["Normal"])
    return material


def bean_material():
    material = bpy.data.materials.new("RoastedBean")
    material.use_nodes = True
    tree = material.node_tree
    shader = tree.nodes["Principled BSDF"]
    info = tree.nodes.new("ShaderNodeObjectInfo")
    roast = tree.nodes.new("ShaderNodeValToRGB")
    roast.color_ramp.elements[0].color = (0.030, 0.0135, 0.0075, 1)
    roast.color_ramp.elements[1].color = (0.105, 0.048, 0.024, 1)
    tree.links.new(info.outputs["Random"], roast.inputs["Fac"])
    mottle_coords = tree.nodes.new("ShaderNodeTexCoord")
    mottle = tree.nodes.new("ShaderNodeTexNoise")
    mottle.inputs["Scale"].default_value = 22
    mottle.inputs["Detail"].default_value = 5
    tree.links.new(mottle_coords.outputs["Object"], mottle.inputs["Vector"])
    shade = tree.nodes.new("ShaderNodeMix")
    shade.data_type = "RGBA"
    shade.blend_type = "MULTIPLY"
    shade.inputs["Factor"].default_value = 0.9
    tone = tree.nodes.new("ShaderNodeMapRange")
    tone.inputs["From Min"].default_value = 0.3
    tone.inputs["From Max"].default_value = 0.7
    tone.inputs["To Min"].default_value = 0.55
    tone.inputs["To Max"].default_value = 1.3
    tree.links.new(mottle.outputs["Fac"], tone.inputs["Value"])
    tree.links.new(roast.outputs["Color"], shade.inputs["A"])
    tree.links.new(tone.outputs["Result"], shade.inputs["B"])

    crease = tree.nodes.new("ShaderNodeAttribute")
    crease.attribute_name = "crease"
    darken = tree.nodes.new("ShaderNodeMix")
    darken.data_type = "RGBA"
    darken.inputs["B"].default_value = (0.008, 0.003, 0.002, 1)
    tree.links.new(crease.outputs["Fac"], darken.inputs["Factor"])
    tree.links.new(shade.outputs["Result"], darken.inputs["A"])
    tree.links.new(darken.outputs["Result"], shader.inputs["Base Color"])

    coords = tree.nodes.new("ShaderNodeTexCoord")
    grain = tree.nodes.new("ShaderNodeTexNoise")
    grain.inputs["Scale"].default_value = 70
    grain.inputs["Detail"].default_value = 6
    tree.links.new(coords.outputs["Object"], grain.inputs["Vector"])
    bump = tree.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.25
    bump.inputs["Distance"].default_value = 0.004
    tree.links.new(grain.outputs["Fac"], bump.inputs["Height"])
    tree.links.new(bump.outputs["Normal"], shader.inputs["Normal"])

    oil = tree.nodes.new("ShaderNodeMapRange")
    oil.inputs["To Min"].default_value = 0.26
    oil.inputs["To Max"].default_value = 0.5
    tree.links.new(grain.outputs["Fac"], oil.inputs["Value"])
    tree.links.new(oil.outputs["Result"], shader.inputs["Roughness"])
    return material


def stoneware_material():
    material = bpy.data.materials.new("Stoneware")
    material.use_nodes = True
    tree = material.node_tree
    shader = tree.nodes["Principled BSDF"]
    coords = tree.nodes.new("ShaderNodeTexCoord")
    speck = tree.nodes.new("ShaderNodeTexNoise")
    speck.inputs["Scale"].default_value = 55
    speck.inputs["Detail"].default_value = 3
    tree.links.new(coords.outputs["Object"], speck.inputs["Vector"])
    ramp = tree.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.68
    ramp.color_ramp.elements[0].color = (0.70, 0.635, 0.53, 1)
    ramp.color_ramp.elements[1].position = 0.72
    ramp.color_ramp.elements[1].color = (0.13, 0.09, 0.06, 1)
    tree.links.new(speck.outputs["Fac"], ramp.inputs["Fac"])
    tree.links.new(ramp.outputs["Color"], shader.inputs["Base Color"])
    shader.inputs["Roughness"].default_value = 0.3
    shader.inputs["Coat Weight"].default_value = 0.35
    shader.inputs["Coat Roughness"].default_value = 0.12
    ripple = tree.nodes.new("ShaderNodeTexNoise")
    ripple.inputs["Scale"].default_value = 9
    tree.links.new(coords.outputs["Object"], ripple.inputs["Vector"])
    bump = tree.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.08
    bump.inputs["Distance"].default_value = 0.02
    tree.links.new(ripple.outputs["Fac"], bump.inputs["Height"])
    tree.links.new(bump.outputs["Normal"], shader.inputs["Normal"])
    return material


def backdrop():
    bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 9, 10), rotation=(math.radians(90), 0, 0))
    wall = bpy.context.active_object
    wall.name = "Backdrop"
    material = bpy.data.materials.new("Plaster")
    material.use_nodes = True
    shader = material.node_tree.nodes["Principled BSDF"]
    shader.inputs["Base Color"].default_value = (0.085, 0.052, 0.034, 1)
    shader.inputs["Roughness"].default_value = 0.85
    wall.data.materials.append(material)


def area(name, location, target, size, energy, kelvin_rgb, spread=None):
    light = bpy.data.lights.new(name, "AREA")
    light.shape = "RECTANGLE"
    light.size, light.size_y = size
    light.energy = energy
    light.color = kelvin_rgb
    if spread:
        light.spread = math.radians(spread)
    obj = bpy.data.objects.new(name, light)
    obj.location = location
    obj.rotation_euler = (Vector(target) - Vector(location)).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.collection.objects.link(obj)


def stage_look(asset_dir, first, last):
    scene = bpy.context.scene
    random.seed(SEED + 1)
    high = bean_mesh("BeanHigh", 72, 64)
    high.materials.append(bean_material())
    for obj in list(scene.objects):
        if obj.name.startswith("Bean"):
            obj.data = high
    bpy.data.objects["Funnel"].hide_render = True

    bowl = bpy.data.objects["Bowl"]
    bowl.data.materials.append(stoneware_material())
    bpy.data.objects["Table"].data.materials.append(wood_material(asset_dir))
    backdrop()

    # A few resting beans in the out-of-focus foreground give the table scale and depth.
    for index in range(26):
        loose = bpy.data.objects.new(f"Loose{index:02d}", high)
        angle, reach = random.uniform(math.radians(205), math.radians(335)), random.uniform(0.95, 2.1)
        loose.location = (reach * math.cos(angle), reach * math.sin(angle), 0.021)
        flip = random.random() < 0.4
        loose.rotation_euler = Euler((math.pi if flip else 0, 0, random.uniform(0, math.tau)))
        if flip:
            loose.location.z = 0.04
        scene.collection.objects.link(loose)

    scene.world = bpy.data.worlds.new("Studio")
    scene.world.use_nodes = True
    tree = scene.world.node_tree
    environment = tree.nodes.new("ShaderNodeTexEnvironment")
    environment.image = bpy.data.images.load(os.path.join(asset_dir, "brown_photostudio_02_2k.hdr"))
    background = tree.nodes["Background"]
    background.inputs["Strength"].default_value = 0.16
    tree.links.new(environment.outputs["Color"], background.inputs["Color"])

    warm, neutral = (1.0, 0.80, 0.58), (1.0, 0.93, 0.84)
    area("Key", (-3.4, -1.3, 4.0), (0, 0, 0.4), (2.4, 1.8), 620, warm, spread=75)
    area("Rim", (3.0, 3.6, 2.6), (-0.1, 0, 0.8), (1.2, 2.4), 700, warm)
    area("Fill", (2.8, -5.2, 1.6), (0, 0, 0.5), (3.5, 3.5), 55, neutral)
    area("WallPool", (-1.2, 5.6, 5.2), (-1.8, 9, 1.4), (2.0, 2.0), 380, warm, spread=60)

    camera_data = bpy.data.cameras.new("Macro")
    camera_data.lens = 65
    camera_data.sensor_width = 36
    camera_data.clip_end = 200
    camera_data.dof.use_dof = True
    camera_data.dof.aperture_fstop = 0.75
    camera_data.dof.aperture_blades = 7
    camera = bpy.data.objects.new("Macro", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    focus = bpy.data.objects.new("Focus", None)
    focus.location = (-0.04, -0.08, 0.6)
    scene.collection.objects.link(focus)
    camera_data.dof.focus_object = focus
    aim = bpy.data.objects.new("Aim", None)
    aim.location = (-0.14, 0, 0.46)
    scene.collection.objects.link(aim)
    constraint = camera.constraints.new("TRACK_TO")
    constraint.target = aim
    constraint.track_axis, constraint.up_axis = "TRACK_NEGATIVE_Z", "UP_Y"
    camera.location = (-0.55, -4.45, 1.86)
    camera.keyframe_insert("location", frame=first)
    camera.location = (-0.32, -3.95, 1.68)
    camera.keyframe_insert("location", frame=last)
    for curve in avc_fcurves(camera):
        for point in curve.keyframe_points:
            point.interpolation = "BEZIER"
            point.easing = "EASE_IN_OUT"

    render = scene.render
    render.engine = "CYCLES"
    render.resolution_x, render.resolution_y, render.resolution_percentage = 1920, 1080, 100
    render.fps = 30
    render.use_motion_blur = True
    render.motion_blur_shutter = 0.2
    render.use_persistent_data = True
    cycles = scene.cycles
    cycles.samples = 64
    cycles.use_adaptive_sampling = True
    cycles.adaptive_threshold = 0.03
    cycles.use_denoising = True
    cycles.denoiser = "OPENIMAGEDENOISE"
    cycles.denoising_input_passes = "RGB_ALBEDO_NORMAL"
    cycles.denoising_prefilter = "ACCURATE"
    cycles.use_animated_seed = True
    cycles.max_bounces, cycles.diffuse_bounces, cycles.glossy_bounces = 6, 3, 3
    cycles.transmission_bounces, cycles.volume_bounces, cycles.transparent_max_bounces = 0, 0, 2
    cycles.caustics_reflective = cycles.caustics_refractive = False
    cycles.sample_clamp_indirect = 6.0
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Punchy"
    scene.view_settings.exposure = -0.75
    scene.frame_start, scene.frame_end = first, last
    avc_export.export_camera(anchors=["Focus"], frames=(first, last))


def avc_fcurves(obj):
    """Action f-curves, through the layered action API when the action has slots (Blender 4.4+)."""
    action = obj.animation_data.action
    if hasattr(action, "layers") and action.layers:
        slot = obj.animation_data.action_slot
        return action.layers[0].strips[0].channelbag(slot).fcurves
    return action.fcurves


def main():
    args = sys.argv[sys.argv.index("--") + 1 :]
    if args[0] == "sim":
        stage_sim(os.path.abspath(args[2]))
    else:
        stage_look(os.path.abspath(args[1]), int(args[2]), int(args[3]))


main()
