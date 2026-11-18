import { FalEndpointRequestSchema } from "../../types/generation";
import type { RemoteMediaBinding } from "../../types/remote-media";
import { CliErrorObject } from "../cli";
import { buildFalOperation } from "../providers/fal-operations";
import { mediaUrlFields } from "../providers/higgsfield/media-fields";
import { resolveProviderSnapshot } from "../models/fal-catalog";
import { readRemoteMedia } from "./remote-media";
import { resolveImportedReferences } from "./provider-references";

export function bindRemoteMediaRequest(
  raw: unknown,
  projectId: string,
  binding: RemoteMediaBinding,
  pointer: string,
  rootDir = process.cwd(),
) {
  const request = FalEndpointRequestSchema.parse(structuredClone(raw));
  if (request.provider !== "higgsfield")
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Remote media binding requires provider higgsfield." });
  if (request.context?.modelPreparation)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Prepared inputs are immutable. Set remoteSource in a new model:prepare specification.",
    });
  const snapshot = resolveProviderSnapshot("higgsfield", request.endpoint);
  const parts = pointer
    .split("/")
    .slice(1)
    .map((value) => value.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (
    !pointer.startsWith("/") ||
    !parts.length ||
    parts.some((part) => ["__proto__", "constructor", "prototype", ""].includes(part)) ||
    !snapshot ||
    !mediaUrlFields(snapshot.input, snapshot.schemas).some((field) => {
      const pattern = field.split("/").slice(1);
      return (
        pattern.length === parts.length &&
        pattern.every((value, index) =>
          value === "*" ? /^(?:0|[1-9]\d*)$/.test(parts[index]) : value === pointer.split("/")[index + 1],
        )
      );
    })
  )
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message:
        "field must be a JSON pointer to an exact documented media URL field; inspect hf:media --action capabilities.",
    });
  const data = readRemoteMedia(projectId, binding, rootDir);
  let parent: Record<string, unknown> | unknown[] = request.input;
  for (let index = 0; index < parts.length - 1; index++) {
    const key = parts[index],
      item: unknown = (parent as Record<string, unknown>)[key];
    if (!item || typeof item !== "object")
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Create the parent attachment object/array in the scaffold before binding.",
      });
    parent = item as Record<string, unknown>;
  }
  const key = parts.at(-1)!;
  if (Array.isArray(parent) && Number(key) > parent.length)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Cannot create sparse attachment arrays." });
  (parent as Record<string, unknown>)[key] = data.receipt.mediaUrl;
  const attached = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === "string") attached.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(request.input);
  const remoteMedia = (request.context?.remoteMedia ?? []).filter((row) => {
    const url = readRemoteMedia(projectId, row, rootDir).receipt.mediaUrl;
    return attached.has(url) && url !== data.receipt.mediaUrl;
  });
  request.context = {
    ...request.context,
    allowTranslatedSpeech: request.context?.allowTranslatedSpeech ?? false,
    media: request.context?.media ?? {},
    remoteMedia: [...remoteMedia, binding],
  };
  const resolved = resolveImportedReferences(request, projectId, rootDir).request;
  buildFalOperation(resolved);
  return request;
}
