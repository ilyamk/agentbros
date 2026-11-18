import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { RealtimeEditorStore, readRealtimeEditorRequest, readRealtimeDerive } from "../src/lib/realtime/editor";
import path from "node:path";
import { readWorkflowEvidence } from "../src/lib/workflows/local-evidence";
import { RealtimeReviewService } from "../src/lib/review-ui/realtime";
void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Existing project ID" },
    { name: "editor", required: true, description: "Local editor ID" },
    {
      name: "action",
      choices: [
        "create",
        "status",
        "add",
        "add-asset",
        "derive",
        "queue",
        "handoff",
        "cancel",
        "recover",
        "complete",
        "select",
        "request",
      ],
      default: "status",
      description: "Offline editor action",
    },
    { name: "expected", type: "number", description: "Expected editor sequence for mutations" },
    { name: "ceiling", type: "number", description: "Positive aggregate planning ceiling USD" },
    { name: "request", description: "Strict offline realtime request JSON for add" },
    {
      name: "asset-draft",
      description: "Project-relative strict still selector/control JSON within16KiB; no provider execution",
    },
    { name: "patch", description: "Strict derive JSON within 16 KiB, with explicit new IDs/input/user quote" },
    { name: "revision", description: "Revision ID for queue/complete/select/request" },
    { name: "manifest", description: "Published pinned realtime capture manifest for complete" },
  ] as const);
  try {
    const store = new RealtimeEditorStore(process.cwd(), String(args.project), String(args.editor));
    const expected = Number(args.expected);
    const action = String(args.action);
    if (!["create", "status", "request"].includes(action) && (!Number.isInteger(expected) || expected < 0))
      throw new Error("Mutation requires nonnegative --expected sequence");
    let result;
    switch (action) {
      case "create":
        result = store.create(Number(args.ceiling));
        break;
      case "status":
        result = store.read();
        break;
      case "add": {
        if (!args.request) throw new Error("add requires --request");
        result = store.add(expected, readRealtimeEditorRequest(String(args.request)));
        break;
      }
      case "add-asset": {
        if (!args["asset-draft"]) throw Error("add-asset requires --asset-draft");
        const selector = String(args["asset-draft"]);
        if (path.isAbsolute(selector) || selector.includes("\\")) throw Error("asset-draft must be project-relative");
        const project = path.join(process.cwd(), "public/projects", String(args.project)),
          file = path.resolve(project, selector);
        const draft = JSON.parse(readWorkflowEvidence(file, project, 16384).text);
        result = new RealtimeReviewService(process.cwd(), String(args.project)).mutate({
          action: "add-asset",
          editorId: String(args.editor),
          expected,
          draft,
        });
        break;
      }
      case "derive":
        if (!args.patch) throw Error("derive requires --patch");
        result = store.derive(expected, readRealtimeDerive(String(args.patch)));
        break;
      case "queue":
        result = store.queue(expected, String(args.revision));
        break;
      case "handoff":
        result = store.handoff(expected);
        break;
      case "cancel":
        result = store.cancel(expected);
        break;
      case "recover":
        result = store.recover(expected);
        break;
      case "complete":
        if (!args.manifest) throw new Error("complete requires --manifest");
        result = store.complete(expected, String(args.revision), String(args.manifest));
        break;
      case "select":
        result = store.select(expected, String(args.revision));
        break;
      case "request":
        result = store.request(String(args.revision));
        break;
      default:
        throw new Error("Unsupported offline editor action");
    }
    return {
      outputs: [],
      metadata: {
        action,
        editor: result,
        offline: true,
        providerAck: false,
        liveVerified: false,
        execution: "No token acquisition or socket submission. Explicit existing capture executor is separate.",
      },
    };
  } catch (error) {
    if (error instanceof CliErrorObject) throw error;
    throw new CliErrorObject({ code: "VALIDATION", message: error instanceof Error ? error.message : String(error) });
  }
});
