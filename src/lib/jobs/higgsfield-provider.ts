import { CliErrorObject } from "../cli";
import { generationRequestBody, type JobProvider } from "./runner";
import { canonicalRequestBody } from "./request-body";
import { HiggsfieldUploadCache } from "../providers/higgsfield/upload-cache";
import type { HiggsfieldClient } from "../providers/higgsfield/client";
import { validHiggsfieldRequestUrl } from "../providers/higgsfield/client";
import { prepareHiggsfieldInput, type UploadMedia } from "../providers/higgsfield/uploads";
import { HiggsfieldRequestStatusSchema } from "../../types/higgsfield";

export function createHiggsfieldJobProvider(
  client: Pick<HiggsfieldClient, "submit" | "status" | "createUpload" | "putUpload">,
  options: {
    projectId?: string;
    cache?: HiggsfieldUploadCache;
    expectedBody?: string;
    transcode?: (media: UploadMedia) => UploadMedia | Promise<UploadMedia>;
  } = {},
): JobProvider {
  const cache = options.cache ?? (options.projectId ? new HiggsfieldUploadCache(options.projectId) : undefined);
  const assertBody = (body: string) => {
    if (options.expectedBody !== undefined && body !== options.expectedBody)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Prepared Higgsfield body differs from the estimated request.",
      });
  };
  return {
    idempotentSubmit: true,
    async prepareInput(input, context) {
      const prepared = await prepareHiggsfieldInput(input, { client, ...context, transcode: options.transcode, cache });
      if (
        options.expectedBody !== undefined &&
        canonicalRequestBody(prepared) !== canonicalRequestBody(JSON.parse(options.expectedBody))
      )
        throw new CliErrorObject({
          code: "VALIDATION",
          message: "Prepared Higgsfield body differs from the estimated request.",
        });
      return prepared;
    },
    async submit(endpoint, input, context) {
      if (!context)
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: "Higgsfield submit requires the durable operation ID.",
        });
      assertBody(context.body ?? generationRequestBody(input));
      const data = await client.submit(endpoint, input, { idempotencyKey: context.operationId, body: context.body });
      const requestId = typeof data.request_id === "string" ? data.request_id : "";
      const status = validHiggsfieldRequestUrl(data.status_url, requestId, "status"),
        cancel = validHiggsfieldRequestUrl(data.cancel_url, requestId, "cancel");
      if (!/^[a-zA-Z0-9_-]{1,200}$/.test(requestId))
        throw new CliErrorObject({
          code: "VALIDATION",
          message: "Higgsfield returned an invalid request ID; resume with the same idempotency key.",
        });
      return { requestId, ...(status ? { providerUrls: { status, ...(cancel ? { cancel } : {}) } } : {}) };
    },
    async inspect(_endpoint, requestId, context) {
      if (context?.providerUrls && !validHiggsfieldRequestUrl(context.providerUrls.status, requestId, "status"))
        throw new CliErrorObject({ code: "VALIDATION", message: "Invalid stored Higgsfield status URL." });
      const result = HiggsfieldRequestStatusSchema.parse(
        await client.status(context?.providerUrls?.status ?? requestId),
      );
      if (result.request_id !== requestId)
        throw new CliErrorObject({ code: "VALIDATION", message: "Higgsfield status belongs to a different request." });
      if (result.status === "queued") return { state: "queued" };
      if (result.status === "in_progress") return { state: "running" };
      if (result.status === "completed") return { state: "completed", result };
      return {
        state: "failed",
        refunded: true,
        message:
          result.status === "nsfw" ? "rejected by content moderation (nsfw)" : result.error?.trim() || result.status,
      };
    },
  };
}
