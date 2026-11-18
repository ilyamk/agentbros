"""Build bounded native Vork simulations through its separately installed SDK."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any


def apply_textile(scene: dict[str, Any], scene_file: Path, divisions: int) -> None:
    """Keep weave coordinates and finish separate from the solver topology."""
    side = divisions + 1
    scene["buffers"]["weave_uv"] = {"type": "vec2", "data": [[x / divisions, y / divisions] for y in range(side) for x in range(side)]}
    scene["geometry"]["fabric"]["attributes"]["TEXCOORD_0"] = "weave_uv"
    scene["nodes"][0]["materials"] = [{"program": {"file": "textile.slang"}, "inputs": {"uv": {"attribute": "TEXCOORD_0"}}}]
    (scene_file.parent / "textile.slang").write_text(
        """import vork;
struct Inputs {Attribute<float2> uv;};
Closure surface(ShadingContext c,Inputs i) {
 AttributeSample<float2> uv=read_attribute(i.uv,c);float footprint=max(length(uv.dx),length(uv.dy));
 float weave=sin(uv.value.x*2199.115)*sin(uv.value.y*1256.637)*exp(-pow(footprint*700.,2.));
 float edge=min(min(uv.value.x,1.-uv.value.x),min(uv.value.y,1.-uv.value.y));
 float hem=1.-smoothstep(.004,.009,edge);
 Closure m={};m.base_color=float3(.28,.025,.014)*(1.+.11*weave-.15*hem);
 m.specular_roughness=.82;m.fuzz_weight=.65;m.fuzz_color=float3(.42,.06,.035);m.fuzz_roughness=.7;return m;
}
"""
    )
    rim = next(node for node in scene["nodes"] if node.get("name") == "rim")
    rim["energy"], rim["color"] = 280, [1, 0.85, 0.72]


def fluid_callbacks(*, final: bool, budget: int, spacing: float) -> str:
    """Author distinct mass-matched pool and cheap drop initial conditions."""
    if final:
        return """
float container(float3 p) { return max(abs(p.x)-.42,max(-.34-p.y,abs(p.z)-.42)); }
float initial_field(float3 p) {
 float horizontal=max(abs(p.x),abs(p.z))-.32;
 return max(container(p),max(horizontal,max(-.34-p.y,p.y+.18)));
}
bool initial_marker(uint id,out float3 p) {
 uint x=id%markers_dims.x,z=id/(markers_dims.x*markers_dims.y),y=(id/markers_dims.x)%markers_dims.y;
 p=float3(-.32,-.34,-.32)+(float3(x,y,z)+.5)*MARKER_SPACING; return true;
}
float3 initial_velocity(float3 p,float dx) { return float3(-.25*p.z,0,.25*p.x); }
float initial_pressure(float3 p) { return initial_field(p)<0 ? GRAVITY*max(0.,-.18-p.y) : 0.; }
bool film_accept(float2 p) { return false; }
float film_height(float2 p) { return -.34; }
float3 boundary_velocity(float3 p,float time,float3 v) { return v; }
"""
    return (
        """
float container(float3 p) { return max(abs(p.x)-.42,max(-.34-p.y,abs(p.z)-.42)); }
float initial_field(float3 p) { return max(length(p-float3(0,0,0))-FIELD_RADIUS,container(p)); }
bool initial_marker(uint id,out float3 p) {
 uint x=id%BUDGETu,y=(id/BUDGETu)%BUDGETu,z=id/BUDGET_SQUAREDu;
 p=(float3(x,y,z)-CENTRE)*SPACING; return length(p)<MARKER_RADIUS;
}
float3 initial_velocity(float3 p,float dx) { return float3(-p.z*SPIN,UP,p.x*SPIN); }
float initial_pressure(float3 p) { return 0.; }
bool film_accept(float2 p) { return false; }
float film_height(float2 p) { return -.4; }
float3 boundary_velocity(float3 p,float time,float3 v) { return v; }
""".replace("SPIN", ".7" if final else "2.")
        .replace("UP", ".1" if final else ".25")
        .replace("FIELD_RADIUS", ".18")
        .replace("MARKER_RADIUS", ".17")
        .replace("BUDGET_SQUARED", str(budget * budget))
        .replace("BUDGET", str(budget))
        .replace("CENTRE", str((budget - 1) / 2))
        .replace("SPACING", str(spacing))
    )


def main() -> None:
    """Regenerate an author-owned scene; never render or download here."""
    recipe, source, sdk, seed, quality = sys.argv[1:]
    final = quality == "final"
    sys.path.insert(0, sdk)
    from vork import write_scene

    scene_file = Path(source)
    scene = json.loads(scene_file.read_text())
    scene.pop("animation", None)
    if recipe == "cloth-banner":
        from vork.cloth import attach

        divisions = 31 if final else 8
        side = divisions + 1
        positions = [[(x / divisions - 0.5) * 1.4, 1.4 - y / divisions, 0.045 * math.sin(4 * math.pi * x / divisions) * math.sin(math.pi * y / divisions)] for y in range(side) for x in range(side)]
        indices = []
        for y in range(divisions):
            for x in range(divisions):
                a = y * side + x
                indices.extend([a, a + side, a + 1, a + 1, a + side, a + side + 1])
        scene["buffers"] = {"p": {"type": "vec3", "data": positions}, "i": {"type": "u32", "data": indices}}
        scene["geometry"] = {"fabric": {"attributes": {"POSITION": "p"}, "indices": "i"}}
        scene["nodes"][0] = {"type": "mesh", "name": "hero", "geometry": "fabric", "materials": [{"inputs": {"base_color": [0.25, 0.035, 0.015], "specular_roughness": 0.6}}]}
        if final:
            apply_textile(scene, scene_file, divisions)
        attach(
            scene,
            "hero",
            pins=list(range(side)),
            iterations=64 if final else 16,
            bending_rigidity=0.0002 if final else 0.002,
            damping=0.3 if final else 0.8,
            acceleration="return float3(0,-9.81,(1.2*sin(time*1.7)+1.8*sin(p.x*18.-time*4.))*smoothstep(0.,.6,time));"
            if final
            else "return float3(0,-9.81,(2.*sin(time*1.7)+4.*sin(p.x*12.-time*4.))*smoothstep(0.,.6,time));",
        )
        camera = next(node for node in scene["nodes"] if node.get("name") == "camera")
        camera["translation"] = [2.65, 1.8, 4.1]
        camera["target"] = [0, 0.73, 0]
        camera["material"]["inputs"]["lens"] = 50
        support = [{"inputs": {"base_color": [0.15, 0.17, 0.18], "base_metalness": 0.8, "specular_roughness": 0.2}}]
        for x in [-0.74, 0.74]:
            scene["nodes"].append({"type": "mesh", "name": f"banner-post-{x}", "geometry": {"std": "cylinder", "radius": 0.015, "height": 1.4}, "translation": [x, 0.7, 0], "materials": support})
        scene["nodes"].append(
            {
                "type": "mesh",
                "name": "banner-bar",
                "geometry": {"std": "cylinder", "radius": 0.022, "height": 1.54},
                "translation": [0, 1.42, 0],
                "rotation": [0, 0, math.sqrt(0.5), math.sqrt(0.5)],
                "materials": support,
            }
        )
    else:
        from vork.fluid import build

        budget = 24 if final else 10
        spacing = 0.32 / budget
        solver_scale = 0.5
        domain_extent = [0.25, 0.5, 0.25] if final else [0.5, 0.5, 0.5]
        callbacks = fluid_callbacks(final=final, budget=budget, spacing=spacing)
        fluid = build(
            callbacks=callbacks,
            extent=domain_extent,
            particle_budget=[48, 12, 48] if final else [budget] * 3,
            scale=solver_scale,
            spacing=spacing * solver_scale,
            grid=[32, 64, 32] if final else [16] * 3,
            surface_grid=[96, 192, 96] if final else [32] * 3,
            speed=2.0 if final else 3.0,
            dt=1 / 360 if final else None,
            seed=int(seed),
            pressure_iterations=50 if final else 12,
        )
        for key in ("buffers", "programs", "geometry", "materials"):
            scene.setdefault(key, {}).update(fluid[key])
        scene["simulation"] = fluid["simulation"]
        scene["nodes"][0] = {
            "type": "mesh",
            "name": "hero",
            "geometry": "water",
            "scale": domain_extent,
            "translation": [0, 0.5, 0],
            "materials": [{"inputs": {"transmission_weight": 1, "specular_ior": 1.333, "specular_roughness": 0.03}}],
        }
        plinth = next(node for node in scene["nodes"] if node.get("name") == "plinth")
        plinth["geometry"] = {"std": "cylinder", "radius": 0.5, "height": 0.42, "segments": 128}
        plinth["translation"] = [0, 0.08, 0]
        camera = next(node for node in scene["nodes"] if node.get("name") == "camera")
        camera.update(translation=[0.8, 1.65, 1.2], target=[0, 0.4, 0])
        camera["material"]["inputs"]["lens"] = 40
        basin_material = [{"inputs": {"base_color": [0.65, 0.69, 0.72], "base_metalness": 0, "specular_roughness": 0.25}}]
        for name, size, centre in [
            ("basin-bottom", [0.46, 0.04, 0.46], [0, 0.31, 0]),
            ("basin-left", [0.02, 0.16, 0.46], [-0.22, 0.41, 0]),
            ("basin-right", [0.02, 0.16, 0.46], [0.22, 0.41, 0]),
            ("basin-back", [0.42, 0.16, 0.02], [0, 0.41, -0.22]),
            ("basin-front", [0.42, 0.16, 0.02], [0, 0.41, 0.22]),
        ]:
            scene["nodes"].append({"type": "mesh", "name": name, "geometry": {"std": "box", "size": size}, "translation": centre, "materials": basin_material})
    write_scene(scene, str(scene_file), base_dir=str(scene_file.parent))
    print(json.dumps({"recipe": recipe, "scene": str(scene_file)}))  # noqa: T201 - worker JSON protocol


if __name__ == "__main__":
    main()
