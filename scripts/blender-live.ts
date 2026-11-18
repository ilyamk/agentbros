import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, requireProject, runScript } from "../src/lib/cli";
import { LIVE_ACTIONS, LiveRecipeSchema } from "../src/lib/backends/blender-live-schema";
import {
  artefactPath,
  DEFAULT_IDLE_MINUTES,
  isLiveProcess,
  KIT_DIR,
  liveRequest,
  livePaths,
  readSession,
  replayCommand,
  replayShotScript,
  shellLine,
  startSession,
  stopSession,
  stripSheet,
  type LivePaths,
  type ReplaySettings,
  type SessionRecord,
} from "../src/lib/backends/blender-live";

const ACTIONS = LIVE_ACTIONS;
type Action = (typeof ACTIONS)[number];
const SPECS = [
  {
    name: "action",
    required: true,
    choices: ACTIONS,
    description:
      "Session lifecycle, typed edits, append-asset, apply-recipe, enable-extension, arsenal (read-only), still/strip, save, export or export-recipe (shot script)",
  },
  {
    name: "project",
    description:
      "Project the session belongs to: renders in out/<id>/blender-live/<session>, save and export in public/projects/<id>/assets/blender. Without it: out/qa/blender-live/<session>",
  },
  { name: "session", default: "main", description: "Session name; several can run side by side" },
  {
    name: "params",
    description:
      "JSON object. append-asset {id,kind?,name?,scale?,location?,material_scale?,target?}; apply-recipe {id,params}; enable-extension {id}; arsenal {kind?,filter?,limit?}; add {kind,name,location,rotation_deg,scale,target,material,smooth,lens,light_type,energy,color,size,active_camera}; delete {name}; material {name,base_color,metallic,roughness,transmission,ior,coat,emission_color,emission_strength,alpha,assign_to}; set {target:{kind,name},path,value,frame}; run-kit {script,params}; still {frame,name,samples,width,height,percentage,engine,device}; strip {frames:[a,b],count,...still}; save {name}; export {name,frame,width,height,samples}",
  },
  {
    name: "blend",
    description:
      "start: open this .blend (inside the workspace) as the base instead of the empty scene. Its scripts never run",
  },
  {
    name: "extensions",
    description:
      "start: approved installed extension ids (comma-separated), or approved; isolated arsenal profile only",
  },
  {
    name: "ui",
    type: "boolean",
    description:
      "start: open the Blender window too (the server polls from a timer). Experimental: not covered by the real-Blender test. Default is background",
  },
  {
    name: "idle-minutes",
    type: "number",
    default: DEFAULT_IDLE_MINUTES,
    description: "start: the session exits after this long without a request",
  },
  {
    name: "overwrite",
    type: "boolean",
    description: "save, export: replace an existing file of that name. Ask the user first",
  },
  {
    name: "executable",
    description: "start: Blender executable; default searches PATH, then /Applications/Blender.app",
  },
  {
    name: "timeout",
    type: "number",
    default: 600,
    description: "Seconds to wait for one answer (a still at full size can take minutes)",
  },
] as const;

function parseParams(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  if (raw.length > 256 * 1024)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--params is limited to 256 KiB." });
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--params must be a JSON object." });
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--params must be a JSON object." });
  return value as Record<string, unknown>;
}

const visible = (record: SessionRecord) =>
  Object.fromEntries(Object.entries(record).filter(([key]) => key !== "token"));

function kitList() {
  return readdirSync(KIT_DIR)
    .filter(
      (name) =>
        name.endsWith(".py") &&
        !["studio_kit.py", "toy_kit.py", "prepare_devices.py"].includes(name) &&
        !name.startsWith("_"),
    )
    .sort()
    .map((name) => {
      const source = readFileSync(path.join(KIT_DIR, name), "utf8");
      const doc = /^"""([^\n]*)/.exec(source)?.[1]?.trim() ?? "";
      return { script: name, summary: doc };
    });
}

function requireSession(paths: LivePaths): SessionRecord {
  const record = readSession(paths);
  if (!record || !isLiveProcess(record.pid))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `No live session "${paths.session}"${paths.project ? ` for ${paths.project}` : ""} is running. Start one with --action start.`,
    });
  return record;
}

void runScript(async () => {
  const args = parseArgs(SPECS);
  const action = args.action as Action;
  const project = args.project;
  if (project) requireProject(project);
  const workspace = process.cwd();
  const paths = livePaths(workspace, project, args.session);
  const params = parseParams(args.params);
  const timeoutMs = Math.max(1, args.timeout!) * 1000;

  if (action === "kits")
    return {
      outputs: [],
      metadata: {
        kits: kitList(),
        note: "run-kit takes {script, params}; params are the shot's JSON keys, documented in each script's docstring.",
      },
    };
  if (action === "start") {
    if (Object.keys(params).length)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "start takes no --params." });
    const { record, reused } = await startSession({
      workspace,
      paths,
      blend: args.blend,
      executable: args.executable,
      extensions: args.extensions,
      idleMinutes: args["idle-minutes"]!,
      ui: Boolean(args.ui),
    });
    return {
      outputs: [paths.sessionFile],
      metadata: {
        reused,
        ...visible(record),
        next: "inspect, then add/material/set or run-kit, then still; export when the look is right.",
      },
    };
  }
  if (action === "status") {
    const record = readSession(paths);
    if (!record || !isLiveProcess(record.pid))
      return { outputs: [], metadata: { running: false, session: paths.session, project: project ?? null } };
    const ping = await liveRequest(record.port, record.token, "ping", {}, 10000);
    return { outputs: [], metadata: { running: true, ...visible(record), ...ping } };
  }
  if (action === "stop") {
    const result = await stopSession(paths);
    return { outputs: [], metadata: { session: paths.session, project: project ?? null, ...result } };
  }

  const record = requireSession(paths);
  const call = (op: string, body: Record<string, unknown> = params) =>
    liveRequest(record.port, record.token, op, body, timeoutMs);
  switch (action) {
    case "inspect":
    case "journal":
    case "reset":
    case "arsenal":
      return { outputs: [], metadata: await call(action) };
    case "add":
    case "delete":
    case "material":
    case "set":
    case "run-kit":
    case "append-asset":
    case "apply-recipe":
    case "enable-extension":
      return { outputs: [], metadata: { op: action, ...(await call(action)) } };
    case "still": {
      const result = (await call("still")) as { path: string };
      return {
        outputs: [result.path],
        metadata: { ...result, look: "Open the PNG with your image tool before changing anything else." },
      };
    }
    case "strip": {
      const result = (await call("strip")) as {
        directory: string;
        frames: Array<{ frame: number; path: string }>;
        size: [number, number];
      };
      const sheet = stripSheet(result.frames, result.size, path.join(result.directory, "contact-sheet.png"));
      return { outputs: [sheet, ...result.frames.map((item) => item.path)], metadata: { ...result, sheet } };
    }
    case "save": {
      const extra = Object.keys(params).filter((key) => key !== "name");
      if (extra.length)
        throw new CliErrorObject({ code: "INVALID_INPUT", message: `Unknown save params: ${extra.join(", ")}.` });
      const target = artefactPath(paths, String(params.name ?? ""), ".blend", Boolean(args.overwrite));
      const result = await call("save", { path: target });
      return {
        outputs: [String(result.path)],
        metadata: {
          ...result,
          note: "A .blend is a snapshot for people. The recipe from export is what blender:run replays.",
        },
      };
    }
    case "export":
    case "export-recipe": {
      const extra = Object.keys(params).filter(
        (key) => !["name", "frame", "width", "height", "samples", "engine"].includes(key),
      );
      if (extra.length)
        throw new CliErrorObject({ code: "INVALID_INPUT", message: `Unknown export params: ${extra.join(", ")}.` });
      for (const key of ["frame", "width", "height", "samples"] as const)
        if (params[key] !== undefined && !Number.isInteger(params[key]))
          throw new CliErrorObject({ code: "INVALID_INPUT", message: `${key} must be a whole number.` });
      if (params.engine !== undefined && params.engine !== "cycles" && params.engine !== "eevee")
        throw new CliErrorObject({ code: "INVALID_INPUT", message: "engine must be cycles or eevee." });
      const target = artefactPath(paths, String(params.name ?? ""), ".live.json", Boolean(args.overwrite));
      const script =
        action === "export-recipe"
          ? artefactPath(paths, String(params.name ?? ""), ".py", Boolean(args.overwrite))
          : undefined;
      const { lastStill, ...recipe } = (await call("journal", {})) as {
        lastStill: ReplaySettings | null;
        version: number;
        base: unknown;
        ops: unknown[];
      };
      LiveRecipeSchema.parse(recipe);
      const frameCurrent = ((await call("inspect", {})).scene as { frameCurrent: number }).frameCurrent;
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(recipe, null, 2)}\n`);
      // The replay repeats the last still's frame, size, samples and engine unless the params say otherwise.
      const { name: _name, ...overrides } = params;
      const settings = { ...(lastStill ?? { frame: frameCurrent }), ...overrides } as ReplaySettings;
      const output = path.join(workspace, "out", project ?? "qa", `${String(params.name)}-replay`);
      const command = replayCommand(workspace, target, output, settings);
      if (script) {
        writeFileSync(script, replayShotScript(recipe));
        command[command.indexOf("--script") + 1] = path.relative(workspace, script);
        command.splice(command.indexOf("--script-args"), 2);
      }
      const extensions = [
        ...new Set(
          recipe.ops.flatMap((step) => {
            const entry = step as { op: string; params: { id: string } };
            return entry.op === "enable-extension" ? [entry.params.id] : [];
          }),
        ),
      ];
      if (extensions.length) command.push("--extensions", extensions.join(","));
      return {
        outputs: [target, ...(script ? [script] : [])],
        metadata: {
          recipe: target,
          ...(script ? { script } : {}),
          ops: recipe.ops.length,
          base: recipe.base,
          settings,
          command,
          commandLine: shellLine(command),
        },
      };
    }
    default:
      throw new CliErrorObject({ code: "INVALID_INPUT", message: `Unknown action ${action}.` });
  }
});
