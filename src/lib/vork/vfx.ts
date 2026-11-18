import { pythonArgs, pythonEnvironment, pythonUv } from "../python";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VorkVfxSchema, VorkTaskSchema, VorkReceiverSchema, defaultVfxLighting } from "../../types/vork";
import { baseScene, recipeParams } from "./recipes";
import { hashFile, json, runProcess, writeNew } from "./runtime";
import { probeVideo } from "../vision/media";
import { normaliseCamera, projectPoint } from "./camera";

export async function vfxAction(action: string, requestFile: string, output: string) {
  const request = VorkVfxSchema.parse(json(requestFile)),
    base = path.dirname(path.resolve(requestFile));
  const plate = path.resolve(base, request.plate),
    sourceHash = hashFile(plate);
  output = path.resolve(output);
  if (existsSync(output)) throw new Error("VFX output exists; use a new revision");
  mkdirSync(output, { recursive: true });
  const info = probeVideo(plate);
  if (
    info.width !== request.width ||
    info.height !== request.height ||
    Math.abs(info.fps - request.fps) > 0.001 ||
    info.durationSec + 1 / info.fps < request.duration
  )
    throw new Error("Plate dimensions, FPS or duration differ from the VFX request");
  const ptsRun = await runProcess(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_frames",
      "-show_entries",
      "frame=best_effort_timestamp_time",
      "-of",
      "json",
      plate,
    ],
    { timeoutSec: 120 },
  );
  const pts = (JSON.parse(ptsRun.stdout) as { frames: Array<{ best_effort_timestamp_time: string }> }).frames.map((f) =>
    Number(f.best_effort_timestamp_time),
  );
  if (!pts.length || pts.some((t, i) => !Number.isFinite(t) || (i > 0 && t <= pts[i - 1]!)))
    throw new Error("Plate needs strictly increasing presentation timestamps");
  if (action === "prepare") {
    const file = writeNew(path.join(output, "plate.json"), {
      schemaVersion: 1,
      source: { file: plate, sha256: sourceHash },
      ...info,
      pts,
      note: "Original retained. Tracking, matte and depth are separate evidence, not inferred ground truth.",
    });
    return { outputs: [file], sourceHash };
  }
  if (action === "solve") {
    if (!request.calibration)
      throw new Error("Planar solve requires explicit focal length, plane dimensions and four initial corners");
    const workerRequest = writeNew(path.join(output, "request.json"), {
      ...request,
      plate,
      matte: request.matte && path.resolve(base, request.matte),
      pts: pts.map((time) => time - pts[0]!),
    });
    const worker = fileURLToPath(new URL("../../../scripts/workers/vork-track.py", import.meta.url));
    await runProcess(pythonUv(), pythonArgs("vork", [worker, workerRequest, output]), {
      env: pythonEnvironment("vork"),
      timeoutSec: 600,
    });
    if (hashFile(plate) !== sourceHash) throw new Error("Tracking changed the original plate");
    return {
      outputs: ["camera.json", "tracking-report.json", "tracking-preview.mp4"].map((f) => path.join(output, f)),
      sourceHash,
    };
  }
  if (action === "review") {
    const cameraFile = request.camera && path.resolve(base, request.camera);
    if (!cameraFile) throw new Error("Review requires a camera sidecar");
    const camera = json(cameraFile) as { frames: unknown[] };
    const file = writeNew(path.join(output, "review.json"), {
      schemaVersion: 1,
      sourceHash,
      frameCount: camera.frames.length,
      sourceFrames: pts.length,
      acceptance:
        "Inspect all tracking overlays, boundaries, occlusion and slow motion; fit residual is not visual acceptance",
      cameraSha256: hashFile(cameraFile),
    });
    return { outputs: [file] };
  }
  if (action !== "build" || !request.camera) throw new Error("Build requires a supplied or solved camera sidecar");
  if (
    pts
      .slice(0, Math.ceil(request.duration * request.fps))
      .some((time, index) => Math.abs(time - pts[0]! - index / request.fps) > 1e-5)
  )
    throw new Error("VFX rendering needs an explicit constant-frame-rate derivative; retain the original and its PTS");
  const cameraFile = path.resolve(base, request.camera);
  const camera = normaliseCamera(json(cameraFile), request.fps);
  if (
    !camera.K ||
    camera.K.length !== 9 ||
    camera.image_size[0] !== request.width ||
    camera.image_size[1] !== request.height ||
    Math.abs(camera.K[2]! - request.width / 2) > 1 ||
    Math.abs(camera.K[5]! - request.height / 2) > 1
  )
    throw new Error("VFX build requires a centred calibrated pinhole camera at plate resolution");
  const count = Math.ceil(request.duration * request.fps);
  if (
    camera.frames.length < count ||
    camera.frames
      .slice(0, count)
      .some(
        (f) =>
          !f.translation?.every(Number.isFinite) ||
          f.translation.length !== 3 ||
          !f.rotation?.every(Number.isFinite) ||
          f.rotation.length !== 4,
      )
  )
    throw new Error("Incomplete camera poses; use the planar solver output");
  if (Math.abs(camera.frames[0]!.time) > 1e-5 || camera.frames[count - 1]!.time < (count - 1) / request.fps - 1e-5)
    throw new Error("Camera poses must cover the requested plate clock from zero");
  const scene = baseScene({
    ...recipeParams.parse({ seed: request.seed }),
    duration: request.duration,
    fps: request.fps,
  });
  scene.nodes = scene.nodes.filter((n) => !["camera", "floor", "plinth"].includes(String(n.name)));
  scene.nodes[0]!.scale = [request.scale, request.scale, request.scale];
  scene.nodes[0]!.translation = request.placement;
  scene.nodes[0]!.materials = [
    {
      inputs: {
        base_color: [0.05, 0.25, 0.3],
        base_metalness: 0.35,
        specular_roughness: 0.25,
        emission_color: [0.1, 0.8, 1],
        emission_luminance: 0.05,
      },
    },
  ];
  const lighting = request.lighting ?? defaultVfxLighting;
  scene.nodes = scene.nodes.filter((node) => node.type !== "light");
  scene.nodes.push({
    type: "light",
    shape: "environment",
    energy: lighting.world.strength,
    color: lighting.world.colour,
  });
  for (const area of lighting.areas)
    scene.nodes.push({
      type: "light",
      shape: "rectangle",
      name: area.name,
      translation: area.position,
      target: area.target,
      energy: area.energy,
      color: area.colour,
      size: area.size,
    });
  const receiver = request.receiver ?? VorkReceiverSchema.parse({});
  if (request.shadowMode === "shadow-catcher")
    scene.nodes.push({
      type: "mesh",
      name: "receiver",
      geometry: { std: "grid", size: Array.isArray(receiver.size) ? receiver.size : [receiver.size, receiver.size] },
      translation: receiver.position,
      is_shadow_catcher: true,
      materials: [{ inputs: { base_color: receiver.colour, specular_roughness: receiver.roughness } }],
    });
  if (request.proxy && request.shadowMode !== "shadow-catcher")
    throw new Error("A physical shadow proxy requires explicit shadow-catcher mode");
  if (request.proxy)
    scene.nodes.push({
      type: "asset",
      name: "proxy",
      file: path.relative(output, path.resolve(base, request.proxy)),
      is_shadow_catcher: true,
    });
  scene.nodes.push({
    type: "camera",
    name: "camera",
    translation: camera.frames[0]!.translation,
    rotation: camera.frames[0]!.rotation,
    material: {
      program: "std/camera",
      inputs: {
        lens: (camera.K[0]! * 36) / request.width,
        sensor_width: 36,
        fit: "horizontal",
        clip_start: 0.001,
        clip_end: 1000,
      },
    },
  });
  // Match the plate clock at nominal frame times; don't invent shutter samples of masks.
  scene.render = {
    ...scene.render,
    resolution: [request.width, request.height],
    background: "transparent",
    display: { program: "std/standard", inputs: { dither_intensity: 0 } },
  };
  scene.images = {
    plate: { file: path.relative(output, plate), color_space: "sRGB" },
    ...(request.matte
      ? { matte: { file: path.relative(output, path.resolve(base, request.matte)), color_space: "Non-Color" } }
      : {}),
  };
  const contact =
    request.shadowMode === "contact"
      ? camera.frames.slice(0, count).map((pose) => {
          const centre = projectPoint(request.placement, pose, camera.K, camera.image_size),
            radius = request.scale * 0.8;
          const u = projectPoint(
            request.placement.map((value, i) => value + (i === 0 ? radius : 0)),
            pose,
            camera.K,
            camera.image_size,
          ).map((value, i) => value - centre[i]!);
          const v = projectPoint(
            request.placement.map((value, i) => value + (i === 2 ? radius : 0)),
            pose,
            camera.K,
            camera.image_size,
          ).map((value, i) => value - centre[i]!);
          if (Math.abs(u[0]! * v[1]! - u[1]! * v[0]!) < 1e-10)
            throw new Error("Contact plane is edge-on; supply a physical receiver instead");
          return { centre, u, v, time: pose.time };
        })
      : undefined;
  const ratio =
    request.shadowMode === "shadow-catcher"
      ? "compositor_sample(i.shadow,c.uv).rgb"
      : contact
        ? "float3(1.-.35*exp(-3.*dot(q,q)))"
        : "float3(1.)";
  scene.programs = {
    combine: {
      source: `import vork; struct Inputs { Image plate; ${request.shadowMode === "shadow-catcher" ? "Image shadow;" : ""} ${request.matte ? "Image matte;" : ""} ${contact ? "float2 centre;float2 u;float2 v;" : ""} };
float4 composite(CompositeContext c,Inputs i) { float4 cg=compositor_sample(c.uv); float4 bg=compositor_sample(i.plate,c.uv); float hold=${request.matte ? "compositor_sample(i.matte,c.uv).r" : "0."}; ${contact ? "float2 d=c.uv-i.centre;float det=i.u.x*i.v.y-i.u.y*i.v.x;float2 q=float2(d.x*i.v.y-d.y*i.v.x,i.u.x*d.y-i.u.y*d.x)/det;" : ""} float peak=max(cg.r,max(cg.g,cg.b))/max(cg.a,.000001); cg.rgb/=1.+peak; cg*=1.-hold; float3 ratio=lerp(${ratio},float3(1.),hold); return float4(cg.rgb+bg.rgb*ratio*(1.-cg.a),1.); }`,
    },
  };
  scene.materials = {
    combine: {
      program: "combine",
      inputs: {
        plate: { image: "plate" },
        ...(request.shadowMode === "shadow-catcher" ? { shadow: { channel: "shadow_catcher" } } : {}),
        ...(request.matte ? { matte: { image: "matte" } } : {}),
        ...(contact ? { centre: contact[0]!.centre, u: contact[0]!.u, v: contact[0]!.v } : {}),
      },
    },
  };
  scene.render.compositor = ["combine"];
  scene.animation = [
    {
      tracks: [
        {
          path: ["nodes", "camera", "translation"],
          keys: camera.frames.slice(0, count).map((f) => [f.time, f.translation]),
        },
        { path: ["nodes", "camera", "rotation"], keys: camera.frames.slice(0, count).map((f) => [f.time, f.rotation]) },
        ...(contact
          ? ["centre", "u", "v"].map((field) => ({
              path: ["materials", "combine", "inputs", field],
              keys: contact.map((frame) => [frame.time, frame[field as "centre" | "u" | "v"]]),
            }))
          : []),
      ],
    },
  ];
  const file = writeNew(path.join(output, "scene.json"), scene);
  const evidence = writeNew(path.join(output, "vfx-inputs.json"), {
    plate: { file: path.relative(output, plate), sha256: sourceHash },
    camera: { file: path.relative(output, cameraFile), sha256: hashFile(cameraFile) },
    pts,
    depth: request.depth
      ? {
          file: path.relative(output, path.resolve(base, request.depth)),
          sha256: hashFile(path.resolve(base, request.depth)),
          use: "reference only; author proxy geometry explicitly",
        }
      : null,
    proxy: request.proxy ?? null,
    renderBackend: request.renderBackend,
    shadowMode: request.shadowMode,
    note: "Small authored insertion on a constrained plane; contact mode is an authored projected approximation, not physical light transport",
  });
  const taskFile = writeNew(
    path.join(output, "task.json"),
    VorkTaskSchema.parse({
      schemaVersion: 1,
      id: "footage-insert",
      workflow: "footage-vfx",
      renderBackend: request.renderBackend,
      ...(request.renderBackend === "blender-cycles" ? { hybridJob: "hybrid-job.json" } : {}),
      scene: request.renderBackend === "blender-cycles" ? "geometry.json" : "scene.json",
      inputs: [
        requestFile,
        cameraFile,
        evidence,
        ...(request.inputs ?? []).map((file) => path.resolve(base, file)),
        ...(request.depth ? [path.resolve(base, request.depth)] : []),
      ].map((file) => path.relative(output, path.resolve(file))),
      duration: request.duration,
      fps: request.fps,
      seed: request.seed,
      intent: "Anchor an authored sculpture on the calibrated source plane",
      notice: "Stable contact, foreground occlusion and motivated light",
      camera: "Supplied or constrained planar pinhole estimate",
      light: "Artistic plate-matched estimate with a shadow receiver",
      material: "Emissive ceramic and bronze",
      motion: "Preserve source presentation time and camera poses",
      effect: `Premultiplied CG insertion with foreground matte; shadow mode: ${request.shadowMode}${contact ? " (projected contact approximation, no physical reflections)" : ""}`,
      profile: "std/final",
      acknowledgedWarnings: [
        {
          code: "video_only",
          reason:
            "Picture-only insert: the original soundtrack stays in the existing edit and Remotion mix, outside Vork",
        },
      ],
      acceptance: [
        "Inspect full tracking overlays and contact",
        "Inspect all mask boundaries and reflected light",
        "Preserve the immutable source",
      ],
    }),
  );
  if (request.renderBackend === "blender-cycles") {
    if (request.shadowMode !== "shadow-catcher")
      throw new Error(
        "Cycles physical integration requires shadow-catcher mode; choose native Vork explicitly for contact approximation",
      );
    const geometryScene = writeNew(path.join(output, "geometry.json"), {
      version: 2,
      nodes: [scene.nodes[0]],
      render: { duration: request.duration, fps: request.fps, resolution: [request.width, request.height] },
    });
    const job = writeNew(path.join(output, "hybrid-job.json"), {
      schemaVersion: 1,
      renderBackend: "blender-cycles",
      scene: path.relative(output, geometryScene),
      task: path.relative(output, taskFile),
      camera: path.relative(output, cameraFile),
      plate: path.relative(output, plate),
      matte: request.matte && path.relative(output, path.resolve(base, request.matte)),
      proxy: request.proxy && path.relative(output, path.resolve(base, request.proxy)),
      fps: request.fps,
      frames: count,
      resolution: [request.width, request.height],
      seed: request.seed,
      lighting,
      receiver,
    });
    return {
      outputs: [geometryScene, evidence, taskFile, job],
      renderBackend: request.renderBackend,
      job,
      renderCommand: [
        "pnpm",
        "vork:vfx",
        "--action",
        "render",
        "--request",
        job,
        "--output",
        "<fresh-render-directory>",
      ],
    };
  }
  return {
    outputs: [file, evidence, taskFile],
    renderBackend: request.renderBackend,
    scene: file,
    taskFile,
    renderCommand: ["pnpm", "vork:render", "--task", taskFile, "--output", "<fresh-render-directory>"],
  };
}
