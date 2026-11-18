"""Inspect proposed Blender Python as syntax/data; never execute it or import bpy."""

from __future__ import annotations

import ast
import builtins
import json
import symtable
import sys
from typing import Any


def name(node: ast.AST) -> str:
    """Resolve a dotted call target without evaluating it."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return name(node.value) + "." + node.attr
    return ""


def inspect(code: str) -> dict[str, Any]:  # noqa: C901, PLR0912, PLR0915 — one inert AST pass over independent syntax kinds.
    """Return syntax, concrete operations and literal dependencies of one script."""
    try:
        tree = ast.parse(code)
        symbols = symtable.symtable(code, "<plan>", "exec")
    except SyntaxError as error:
        return {"error": str(error)}
    functions = {node.name: node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
    active: list[ast.AST] = []
    pending: list[ast.AST] = [tree]
    reached: set[str] = set()
    while pending:
        current = pending.pop()
        if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        active.append(current)
        if isinstance(current, ast.Call) and isinstance(current.func, ast.Name) and current.func.id in functions and current.func.id not in reached:
            reached.add(current.func.id)
            pending.extend(functions[current.func.id].body)
        pending.extend(ast.iter_child_nodes(current))
    imports: dict[str, str] = {}
    constants: dict[str, ast.AST] = {}
    for node in active:
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports[alias.asname or alias.name.split(".")[0]] = alias.name
        elif isinstance(node, ast.ImportFrom) and node.module:
            for alias in node.names:
                imports[alias.asname or alias.name] = node.module + "." + alias.name
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    constants[target.id] = node.value

    def value(node: ast.AST, seen: frozenset[str] = frozenset()) -> Any:  # noqa: ANN401 — literal JSON values.
        if isinstance(node, ast.Name) and node.id in constants and node.id not in seen:
            return value(constants[node.id], seen | {node.id})
        if isinstance(node, ast.Dict):
            result = {}
            for key, item in zip(node.keys, node.values, strict=True):
                if key is None:
                    expanded = value(item, seen)
                    if not isinstance(expanded, dict):
                        raise ValueError
                    result.update(expanded)
                else:
                    result[value(key, seen)] = value(item, seen)
            return result
        if isinstance(node, (ast.Tuple, ast.List)):
            return [value(item, seen) for item in node.elts]
        return ast.literal_eval(node)

    calls, recipes, assets, extensions, faults, commands = [], [], [], [], [], []
    numeric: list[float] = []
    lenses, temperatures, presets, material_values, seed_values, moves, setup_types = [], [], [], [], [], [], []
    emission = False

    def argument(node: ast.Call, index: int, keyword: str) -> ast.AST:
        if len(node.args) > index:
            return node.args[index]
        return next(k.value for k in node.keywords if k.arg == keyword)

    def optional(node: ast.AST) -> Any:  # noqa: ANN401 — a literal or no evidence.
        try:
            return value(node)
        except (ValueError, TypeError):
            return None

    blackbody_names = {
        name(target): True
        for node in active
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call) and node.value.args and optional(node.value.args[0]) == "ShaderNodeBlackbody"
        for target in node.targets
    }

    def record_assignment(assignment: ast.AST, assigned: Any) -> None:  # noqa: ANN401, C901 — independent literal socket/property cases.
        nonlocal emission
        if not isinstance(assignment, ast.Attribute):
            return
        if assignment.attr == "temperature" and isinstance(assigned, (int, float)):
            temperatures.append(assigned)
        if assignment.attr == "lens" and isinstance(assigned, (int, float)):
            lenses.append(assigned)
        if assignment.attr == "seed" and isinstance(assigned, (int, float)):
            seed_values.append(assigned)
        socket = None
        if assignment.attr == "default_value" and isinstance(assignment.value, ast.Subscript):
            socket = optional(assignment.value.slice)
            source = assignment.value.value
            if socket == 0 and isinstance(source, ast.Attribute) and source.attr == "inputs" and name(source.value) in blackbody_names:
                socket = "Temperature"
        if assignment.attr == "default_value" and isinstance(assignment.value, ast.Call) and assignment.value.args:
            socket = optional(assignment.value.args[0])
        if socket in ("Emission Color", "Emission Strength") and assigned:
            emission = True
        if socket in ("Roughness", "Metallic", "Transmission Weight", "Transmission") and isinstance(assigned, (int, float)):
            material_values.append({"input": socket, "value": assigned})
        if socket == "Temperature" and isinstance(assigned, (int, float)):
            temperatures.append(assigned)

    for node in active:
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
            numeric.append(node.value)
        if isinstance(node, ast.Assign):
            for assignment in node.targets:
                record_assignment(assignment, optional(node.value))
        if not isinstance(node, ast.Call):
            continue
        target = name(node.func)
        first, *tail = target.split(".")
        target = ".".join([imports.get(first, first), *tail])
        calls.append(target)
        if target.startswith("subprocess.") and node.args:
            command = optional(node.args[0])
            if isinstance(command, list) and command and command[0] == "pnpm" and all(isinstance(item, str) for item in command):
                commands.append(command)
        if isinstance(node.func, ast.Name) and node.func.id in functions:
            function = functions[node.func.id]
            bindings = {parameter.arg: optional(default) for parameter, default in zip(function.args.args[-len(function.args.defaults) :], function.args.defaults, strict=False)}
            bindings.update({parameter.arg: optional(default) for parameter, default in zip(function.args.kwonlyargs, function.args.kw_defaults, strict=True) if default is not None})
            bindings.update({parameter.arg: optional(argument) for parameter, argument in zip(function.args.args, node.args, strict=False)})
            bindings.update({keyword.arg: optional(keyword.value) for keyword in node.keywords if keyword.arg})
            for assignment in ast.walk(function):
                if isinstance(assignment, ast.Assign) and isinstance(assignment.value, ast.Name) and assignment.value.id in bindings:
                    for destination in assignment.targets:
                        record_assignment(destination, bindings[assignment.value.id])
        for keyword in node.keywords:
            literal_value = optional(keyword.value)
            if keyword.arg == "lens" and target.endswith(".Rig") and isinstance(literal_value, (int, float)):
                lenses.append(literal_value)
            if keyword.arg == "type" and isinstance(literal_value, str):
                setup_types.append(literal_value)
            if keyword.arg in {"roughness", "metallic"} and isinstance(literal_value, (int, float)):
                material_values.append({"input": keyword.arg.title(), "value": literal_value})
        if node.args and isinstance(optional(node.args[0]), str) and target.endswith(".new") and str(optional(node.args[0])).startswith(("ShaderNode", "GeometryNode", "CompositorNode")):
            setup_types.append(optional(node.args[0]))
        if target == "kit.light.mood" and node.args and isinstance(optional(node.args[0]), str):
            presets.append(optional(node.args[0]))
        if target in {"random.seed", "random.Random", "mathutils.noise.seed_set"} and node.args:
            seed_values.append(optional(node.args[0]))
        if target.rsplit(".", 1)[-1] in {"push_in", "dolly", "orbit", "crane", "truck", "handheld"}:
            moves.append(target.rsplit(".", 1)[-1].replace("_", "-"))
        if "keyframe_insert" in target and ("cam" in target.lower()):
            moves.append("keyed")
        try:
            if target == "avc_recipes.apply":
                params = value(node.args[1]) if len(node.args) > 1 else next((value(k.value) for k in node.keywords if k.arg == "params"), {})
                recipes.append({"id": value(argument(node, 0, "recipe_id")), "params": {} if params is None else params})
            elif target == "avc_assets.append":
                assets.append(value(argument(node, 0, "asset_id")))
            elif target == "avc_extensions.require":
                extensions.append(value(argument(node, 0, "extension_id")))
            elif target == "avc_extensions.enable":
                ids = value(argument(node, 0, "ids"))
                if not isinstance(ids, list) or not all(isinstance(item, str) for item in ids):
                    faults.append("Extension enable needs literal string ids")
                else:
                    extensions.extend(ids)
        except (ValueError, TypeError, IndexError, StopIteration):
            faults.append("Non-literal dependency/parameters: " + target)
    module_defined = {s.get_name() for s in symbols.get_symbols() if s.is_assigned() or s.is_imported() or s.is_namespace()}
    undefined: set[str] = set()

    def globals_in(table: symtable.SymbolTable) -> None:
        for symbol in table.get_symbols():
            symbol_name = symbol.get_name()
            if symbol.is_global() and symbol.is_referenced() and symbol_name not in module_defined and symbol_name not in vars(builtins) and symbol_name not in {"__name__", "__file__"}:
                undefined.add(symbol_name)
        for child in table.get_children():
            globals_in(child)

    globals_in(symbols)
    simulation = any(isinstance(node, ast.Constant) and node.value in ("CLOTH", "FLUID", "SOFT_BODY", "RIGID_BODY", "GeometryNodeSimulationInput", "GeometryNodeSimulationOutput") for node in active)
    concrete = sum(
        target.startswith(
            (
                "bpy.ops.mesh.",
                "bpy.ops.object.text_add",
                "bpy.data.meshes.new",
                "bpy.data.curves.new",
                "bpy.data.materials.new",
                "kit.stage.",
                "studio_kit.import_device",
                "avc_assets.append",
                "avc_recipes.apply",
            )
        )
        or target.endswith("nodes.new")
        for target in calls
    )
    animated = any("keyframe_insert" in target or target.endswith((".bake", ".key_intent")) or target in {"avc_recipes.apply", "kit.anim.key_intent"} for target in calls)
    baked = any("ptcache.bake" in target or "bake_cache" in target or target in {"bpy.ops.fluid.bake_all", "bpy.ops.object.simulation_nodes_cache_bake"} for target in calls)
    seeds = any(target in {"random.seed", "random.Random", "mathutils.noise.seed_set"} for target in calls) or any(
        isinstance(node, ast.Attribute) and node.attr == "seed" and isinstance(node.ctx, ast.Store) for node in active
    )
    placeholders = any(isinstance(node, ast.Constant) and node.value is Ellipsis for node in active) or any(
        isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and len(node.body) == 1 and isinstance(node.body[0], ast.Pass) for node in active
    )
    return {
        "error": None,
        "imports": sorted(set(imports.values())),
        "undefined": sorted(undefined),
        "faults": faults,
        "recipes": recipes,
        "assets": assets,
        "extensions": extensions,
        "commands": commands,
        "concrete": concrete,
        "calls": calls,
        "animated": animated,
        "simulation": simulation,
        "baked": baked,
        "seeded": seeds,
        "numbers": numeric,
        "emission": emission,
        "lenses": lenses,
        "temperatures": temperatures,
        "presets": presets,
        "materials": material_values,
        "seedValues": [item for item in seed_values if isinstance(item, (int, float))],
        "moves": moves,
        "setupTypes": setup_types,
        "loops": sum(isinstance(node, (ast.For, ast.ListComp)) for node in active),
        "labels": sorted({node.id for node in active if isinstance(node, ast.Name)}),
        "unsafe": any(target.startswith(("urllib.", "requests.", "os.system")) or target in {"exec", "eval", "__import__"} for target in calls),
        "placeholders": placeholders,
        "statements": len(tree.body),
    }


if __name__ == "__main__":
    print(json.dumps([inspect(script) for script in json.load(sys.stdin)]))  # noqa: T201 — JSON worker contract.
