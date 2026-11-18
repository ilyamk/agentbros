import type { FalTransport } from "../../types/generation";

/** Exact executable subsets; a new schema snapshot never enables a new transport by itself. */
export const FAL_HTTP_STREAM_ENDPOINTS: readonly string[] = Object.freeze([
  "fal-ai/flux-2/stream",
  "fal-ai/flux-2/edit/stream",
  "fal-ai/flux-2/lora/stream",
  "fal-ai/flux-2/lora/edit/stream",
  "fal-ai/flux-2/klein/4b/stream",
  "fal-ai/flux-2/klein/9b/stream",
]);
export function hasLocalFalTransport(endpoint: string, transport: FalTransport): boolean {
  if (transport === "queue" || transport === "training") return true;
  if (transport === "stream") return FAL_HTTP_STREAM_ENDPOINTS.includes(endpoint);
  return transport === "realtime" && endpoint === "fal-ai/flux-2/klein/realtime";
}
