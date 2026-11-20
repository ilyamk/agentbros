import path from "node:path";
import { fail } from "../fal-errors";
import { arrayField, type FalGuard } from "./index";

const generators = ["meshy/v7.1/image-to-3d", "meshy/v7.1/text-to-3d"];
const modelExtensions = [".glb", ".gltf", ".obj", ".fbx", ".stl", ".ply", ".usdz", ".blend"];

/** Semantic constraints in the pinned 3D input descriptions. */
export const threeDGuard: FalGuard = {
  id: "generated-3d",
  phase: "main",
  match: ({ endpoint }) =>
    [...generators, "meshy/rigging", "meshy/n1/retexture", "fal-ai/hunyuan-3d/v3.1/smart-topology"].includes(endpoint),
  check: (input, ctx, warnings, { endpoint }) => {
    if (generators.includes(endpoint) || endpoint === "meshy/rigging") {
      if (input.enable_animation === true) {
        if (generators.includes(endpoint) && input.enable_rigging !== true)
          fail("Meshy animation requires enable_rigging:true.");
        const action = input.animation_action_id ?? 92;
        if (typeof action !== "number" || action < 0 || action > 696)
          fail("Meshy animation_action_id must be in [0, 696] when animation is enabled.");
      }
    }
    const texturing = endpoint.endsWith("image-to-3d") ? input.should_texture !== false : input.mode !== "preview";
    if (generators.includes(endpoint) && texturing && input.texture_model === "meshy-n1") {
      if (
        input.texture_prompt != null ||
        input.enable_pbr === true ||
        (input.topology === "quad" && input.should_remesh !== false)
      ) {
        fail("Meshy N1 rejects texture_prompt, enable_pbr and quad topology with remeshing.");
      }
    }
    // The 2026-11-20 text-to-3d schema states that texture_image_url "cannot be combined with texture_prompt".
    if (endpoint === "meshy/v7.1/text-to-3d" && input.texture_image_url != null && input.texture_prompt != null)
      fail("Meshy 7.1 text-to-3d accepts texture_image_url or texture_prompt, not both.");
    if (endpoint === "meshy/n1/retexture") {
      const single = typeof input.image_style_url === "string" && input.image_style_url.trim().length > 0;
      const multi = arrayField(input, "multiview_image_urls").length > 0;
      if (single === multi) fail("Meshy N1 needs exactly one of image_style_url or multiview_image_urls.");
    }
    if (endpoint === "meshy/rigging") {
      const extension =
        typeof input.model_url === "string" ? path.extname(new URL(input.model_url).pathname).toLowerCase() : "";
      if (modelExtensions.includes(extension) && extension !== ".glb") fail("Meshy rigging requires a GLB model_url.");
      if (extension !== ".glb")
        warnings.push("Meshy rigging input must be GLB; verify the format because the URL does not identify it.");
      warnings.push(
        "Meshy rigging requires a humanoid with clearly defined limbs; inspect the model before submission. Some skeleton/finger combinations may still fail provider validation.",
      );
    }
    if (endpoint === "fal-ai/hunyuan-3d/v3.1/smart-topology" && typeof input.input_file_url === "string") {
      const extension = path.extname(new URL(input.input_file_url).pathname).toLowerCase();
      if (modelExtensions.includes(extension) && ![".glb", ".obj"].includes(extension))
        fail("Smart topology supports GLB or OBJ input only.");
      if (![".glb", ".obj"].includes(extension))
        warnings.push(
          "Smart topology input must be GLB or OBJ; verify the format because the URL does not identify it.",
        );
      const bytes = ctx.media[input.input_file_url]?.bytes;
      if (bytes !== undefined && bytes > 200_000_000) fail("Smart topology input exceeds 200MB.");
      if (bytes === undefined)
        warnings.push("Smart topology input must be at most 200MB; measure bytes before submission.");
    }
  },
};
