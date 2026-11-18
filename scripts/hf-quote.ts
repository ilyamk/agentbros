import { verifyRemoteMedia } from "../src/lib/assets/remote-media";
import { importedReferenceMedia, resolveImportedReferences } from "../src/lib/assets/provider-references";
import { createHiggsfieldClient } from "../src/lib/providers/higgsfield/client";
import { prepareHiggsfieldInput } from "../src/lib/providers/higgsfield/uploads";
import { HiggsfieldUploadCache } from "../src/lib/providers/higgsfield/upload-cache";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, assertPathWithin, parseArgs, requireEnv, requireProject, runScript } from "../src/lib/cli";
import { FalEndpointRequestSchema } from "../src/types/generation";
import { resolveProviderSnapshot } from "../src/lib/models/fal-catalog";
import {
  estimateHiggsfield,
  higgsfieldPriceRecordFor,
  higgsfieldPricingFor,
  loadHiggsfieldPrices,
} from "../src/lib/models/hf-pricing";
import { createHiggsfieldListPricingEvidence } from "../src/lib/models/pricing-evidence";
import { quote } from "../src/lib/pricing";
import { genjutsuMode } from "../src/lib/model-preparation/profiles";
import { preparationAdmission } from "../src/lib/model-preparation/approval";

runScript(async () => {
  const args = parseArgs([
    { name: "request", required: true, description: "Higgsfield endpoint request JSON" },
    { name: "project", description: "Optional project scope for local MCP" },
    { name: "provider-estimate", type: "boolean", description: "Free estimate POST once; CLI only" },
    { name: "scope-root", description: "Trusted MCP workspace boundary" },
  ] as const);
  if (args["scope-root"]) assertPathWithin(args["scope-root"], path.resolve(args.request!));
  const request = FalEndpointRequestSchema.parse(JSON.parse(readFileSync(args.request!, "utf8")));
  if (request.provider && request.provider !== "higgsfield")
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "hf:quote accepts only provider higgsfield." });
  if (args["provider-estimate"] && !args.project) {
    const check = (value: unknown, key = ""): void => {
      if (
        typeof value === "string" &&
        (value.startsWith("asset://") ||
          value.startsWith("data:") ||
          (/_urls?$/.test(key) && !/^https?:\/\//i.test(value)))
      )
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message:
            "hf:quote --provider-estimate requires --project for asset://, local or inline media; without --project use public HTTP(S) URLs.",
        });
      if (Array.isArray(value)) value.forEach((item) => check(item, key));
      else if (value && typeof value === "object") Object.entries(value).forEach(([name, item]) => check(item, name));
    };
    check(request.input);
  }
  const offlineResolved = args.project
    ? resolveImportedReferences({ ...request, provider: "higgsfield" }, args.project).request
    : request;
  const properties = resolveProviderSnapshot("higgsfield", request.endpoint)?.input.properties ?? {};
  const defaults = Object.fromEntries(
    Object.entries(properties)
      .filter(([, field]) => field.default !== undefined)
      .map(([key, field]) => [key, field.default]),
  );
  const context = {
    defaults,
    media: { ...offlineResolved.context?.media, ...importedReferenceMedia(request.input, args.project) },
    videoInput: typeof request.input.video_url === "string",
  };
  const quoteInput = {
    provider: "higgsfield" as const,
    model: request.endpoint,
    providerInput: request.input,
    providerContext: context,
  };
  const current = loadHiggsfieldPrices().get(request.endpoint);
  const listEvidence = current ? createHiggsfieldListPricingEvidence(current) : undefined;
  const offline = quote(quoteInput);
  if (!args["provider-estimate"])
    return { outputs: [], metadata: { quote: offline, quoteInput, listEvidence: listEvidence ?? null } };
  if (genjutsuMode(request.endpoint)) {
    const resolved = resolveImportedReferences({ ...request, provider: "higgsfield" }, args.project).request;
    const admission = preparationAdmission(
      args.project,
      request.context?.modelPreparation,
      request.endpoint,
      resolved.input,
    );
    if (!admission.ready) throw new CliErrorObject({ code: "STAGE_INCOMPLETE", message: admission.blockers.join(" ") });
  }
  if (args.project) {
    requireProject(args.project);
    if (request.context?.remoteMedia?.length) await verifyRemoteMedia(args.project, request.context.remoteMedia);
    const resolved = resolveImportedReferences({ ...request, provider: "higgsfield" }, args.project).request;
    Object.assign(context.media, resolved.context?.media);
    const input = await prepareHiggsfieldInput(resolved.input, {
      client: createHiggsfieldClient({ credentials: requireEnv("HIGGSFIELD_API_KEY") }),
      cache: new HiggsfieldUploadCache(args.project),
      uploads: [],
      persistUpload: () => {},
      onReferencePrepared: (source, url) => {
        if (context.media[source]) context.media[url] = context.media[source];
      },
    });
    quoteInput.providerInput = input;
  }
  // No retries here: the explicit quote flag makes exactly one provider estimate request.
  const estimate = await estimateHiggsfield(
    request.endpoint,
    quoteInput.providerInput,
    (url, init) => fetch(url, init),
    { maxRetries: 0 },
  );
  const record = higgsfieldPriceRecordFor(request.endpoint, quoteInput.providerInput)!;
  const priced = quote(quoteInput);
  const providerPrice = higgsfieldPricingFor(record, quoteInput.providerInput, context);
  return {
    outputs: [],
    metadata: {
      quote: priced,
      quoteInput,
      providerEstimate: estimate,
      providerPrice,
      listEvidence: listEvidence ?? null,
      pricingEvidence: priced.pricingEvidence ?? null,
    },
  };
});
