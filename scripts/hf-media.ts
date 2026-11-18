import { readFileSync } from "node:fs";
import { ZodError } from "zod";
import { CliErrorObject, parseArgs, requireProject, runScript } from "../src/lib/cli";
import { acquireRemoteMedia, resolveRemoteMedia, verifyRemoteMedia } from "../src/lib/assets/remote-media";
import { bindRemoteMediaRequest } from "../src/lib/assets/remote-request";
import { higgsfieldMediaCapabilities } from "../src/lib/providers/higgsfield/media-fields";
import { immutableWrite } from "../src/lib/jobs/model-artifacts";
import { RemoteMediaBindingSchema } from "../src/types/remote-media";

void runScript(async () => {
  try {
    const args = parseArgs([
      {
        name: "action",
        required: true,
        choices: ["capabilities", "resolve", "acquire", "bind", "check"],
        description:
          "Inspect exact URL fields, resolve public page metadata, acquire a checked original, bind a request or recheck bytes",
      },
      { name: "project", description: "Existing project ID for acquire/bind/check" },
      { name: "url", description: "Public page or direct media URL" },
      { name: "media-url", description: "Explicit authorised original when a page is dynamic or ambiguous" },
      {
        name: "kind",
        choices: ["video", "image", "audio"],
        description: "Desired original kind; resolve defaults to video",
      },
      { name: "id", description: "Immutable acquisition receipt ID" },
      { name: "sha256", description: "Receipt digest returned by acquire, not the media hash" },
      { name: "expires-at", description: "Known signed URL expiry as an ISO timestamp" },
      { name: "max-bytes", type: "number", description: "Download bound; default 256 MiB, maximum 512 MiB" },
      { name: "request", description: "Endpoint request JSON to bind" },
      { name: "field", description: "JSON pointer into input, e.g. /video_url or /image_urls/0" },
      { name: "out", description: "New immutable request JSON path" },
    ] as const);
    const required = (value: string | undefined, flag: string): string => {
      if (!value)
        throw new CliErrorObject({ code: "INVALID_INPUT", message: `--${flag} is required for ${args.action}.` });
      return value;
    };
    if (args.action === "capabilities")
      return { metadata: { models: higgsfieldMediaCapabilities(), live: false, motionLibraryApi: "unverified" } };
    if (args.action === "resolve")
      return {
        metadata: await resolveRemoteMedia(
          required(args.url, "url"),
          args.kind as "image" | "audio" | "video" | undefined,
        ),
      };
    const projectId = required(args.project, "project");
    requireProject(projectId);
    if (args.action === "acquire") {
      const result = await acquireRemoteMedia({
        projectId,
        id: required(args.id, "id"),
        url: required(args.url, "url"),
        mediaUrl: args["media-url"],
        kind: args.kind as "image" | "audio" | "video" | undefined,
        expiresAt: args["expires-at"],
        maxBytes: args["max-bytes"],
      });
      return {
        outputs: [result.file],
        metadata: {
          binding: result.binding,
          assetId: result.asset.id,
          sourceUrl: result.receipt.sourceUrl,
          mediaUrl: result.receipt.mediaUrl,
          downloadedForInspection: true,
          reuploadRequired: false,
          rightsGranted: false,
        },
      };
    }
    const binding = RemoteMediaBindingSchema.parse({
      id: required(args.id, "id"),
      sha256: required(args.sha256, "sha256"),
    });
    if (args.action === "check") {
      await verifyRemoteMedia(projectId, [binding]);
      return { metadata: { verified: true, binding, providerFetchVerified: false } };
    }
    const request = bindRemoteMediaRequest(
      JSON.parse(readFileSync(required(args.request, "request"), "utf8")),
      projectId,
      binding,
      required(args.field, "field"),
    );
    const out = required(args.out, "out");
    immutableWrite(out, `${JSON.stringify(request, null, 2)}\n`);
    return {
      outputs: [out],
      metadata: {
        binding,
        nextAction:
          "Inspect generate:model --dry-run. Genjutsu additionally requires model:prepare with remoteSource; source permissions and spend approval remain separate.",
      },
    };
  } catch (error) {
    if (error instanceof ZodError) throw new CliErrorObject({ code: "VALIDATION", message: error.message });
    throw error;
  }
});
