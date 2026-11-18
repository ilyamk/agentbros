# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 ILIA MAKSIMENKA
"""Read a real molecular structure as a sculptural scientific hero with honest atom positions.

Supply a local PDB/CIF file (no silent network). To use a public id, acquire the PDB
from RCSB into local/generated/molecularnodes first and preserve its citation sidecar.
The wrapper does not invent bonds, coordinates or an illustrative replacement.
"""

from __future__ import annotations

import importlib
from pathlib import Path
from typing import Any

from avc_recipes import validate_params
from kit import curves

from _common import finish, timeline_for

META = {
    "id": "molecule",
    "title": "Molecular Nodes structure",
    "category": "geometry",
    "intent": "Read a real molecular structure as a sculptural scientific hero with honest atom positions.",
    "params": {
        "seed": {"type": "integer", "default": 19, "min": 0, "max": 2147483647, "doc": "Reserved reproducible scene seed; atom positions are data."},
        "file": {"type": "string", "default": "", "doc": "Required local PDB or CIF file, with provenance sidecar."},
        "pdb_id": {"type": "string", "default": "", "doc": "Public PDB id acquired with attribution by blender:recipe before the offline render."},
        "style": {"type": "string", "default": "ball_and_stick", "doc": "ball_and_stick, spheres, cartoon or ribbon."},
    },
    "frames_hint": 64,
    "cost_hint": {"cycles": None, "eevee": None},
    "status": "experimental",
    "needs_bake": False,
    "requires": {"extensions": ["molecularnodes"], "generators": []},
    "capabilities": ["science", "molecules"],
}


def apply(scene: Any, params: dict[str, Any], timeline: Any = None) -> dict[str, Any]:
    """Load data through the approved pin; no network calls occur during rendering."""
    import bpy
    from avc_extensions import require

    require("molecularnodes", "520.2.0")
    p = validate_params(META, params)
    file = Path(p["file"])
    if not p["file"] or not file.is_file() or file.suffix.lower() not in {".pdb", ".cif"}:
        msg = "file must name an existing local PDB/CIF; acquire it with attribution before rendering"
        raise ValueError(msg)
    if p["style"] not in {"ball_and_stick", "spheres", "cartoon", "ribbon"}:
        msg = "Unsupported molecular style"
        raise ValueError(msg)
    mn = importlib.import_module("bl_ext.user_default.molecularnodes")
    molecule = mn.Molecule.load(str(file.resolve()), style=p["style"])
    if molecule.universe.trajectory.n_frames != 1:
        msg = "The static molecule wrapper requires one structure model; supply a single-model file"
        raise ValueError(msg)
    obj = molecule.object
    # Molecular Nodes uses 0.01 Blender metres per angstrom by default.
    coords = [v.co.copy() for v in obj.data.vertices]
    if not coords:
        msg = "Structure contains no atoms"
        raise ValueError(msg)
    lo = [min(v[k] for v in coords) for k in range(3)]
    hi = [max(v[k] for v in coords) for k in range(3)]
    scale = 2.4 / max(*(b - a for a, b in zip(lo, hi, strict=True)), 1e-6)
    pivot = bpy.data.objects.new("AVC Molecular presentation pivot", None)
    scene.collection.objects.link(pivot)
    pivot.location.z = 1.6
    obj.parent = pivot
    obj.scale = (scale, scale, scale)
    obj.location = tuple(-(lo[k] + hi[k]) / 2 * scale for k in range(3))
    obj["avc_structure"] = str(file.resolve())
    tl, owned = timeline_for(scene, timeline)
    tl.add(pivot, "rotation_euler", lambda f: (0.12, 0, -0.3 + 0.6 * curves.progress(f, 1, 54, "glide")))
    return finish([obj, pivot], [], tl, owned)
