import { openAsBlob } from "node:fs";
import { z } from "zod";
import { CliErrorObject } from "../cli";
import { readResourceResponse, resourceJson } from "../resources/http";
import { ElevenLabsIdSchema } from "../../types/elevenlabs";

const API = "https://api.elevenlabs.io";
export const remoteId = (value: string) => ElevenLabsIdSchema.parse(value);
const JSON_LIMIT = 8 * 1024 * 1024;
export class ElevenLabsClient {
  constructor(private readonly options: { fetch?: typeof fetch; apiKey?: string } = {}) {}
  private request = (route: string, init: RequestInit) => {
    if (!/^\/v[12]\/[a-zA-Z0-9_/?=&.,%+-]+$/.test(route) || route.includes(".."))
      throw Error("Invalid ElevenLabs API route");
    const key = this.options.apiKey ?? process.env.ELEVENLABS_API_KEY;
    if (!key)
      throw new CliErrorObject({
        code: "MISSING_API_KEY",
        message: "ELEVENLABS_API_KEY is required for this explicit API action",
      });
    return (this.options.fetch ?? fetch)(`${API}${route}`, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init.headers)), "xi-api-key": key },
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
  };
  async value(route: string): Promise<unknown> {
    const transport: typeof fetch = (_url, init) => this.request(route, init ?? {});
    return resourceJson(
      await readResourceResponse(transport, `${API}${route}`, { maxBytes: JSON_LIMIT, timeoutMs: 60_000 }),
    );
  }
  async json(route: string): Promise<Record<string, any>> {
    return z.record(z.string(), z.any()).parse(await this.value(route));
  }
  post(route: string, body?: Record<string, unknown> | FormData, method: "POST" | "PATCH" = "POST") {
    return this.request(
      route,
      body instanceof FormData
        ? { method, body }
        : body === undefined
          ? { method }
          : { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
    );
  }
  async mutation(
    route: string,
    body?: Record<string, unknown> | FormData,
    method: "POST" | "PATCH" = "POST",
  ): Promise<Record<string, any>> {
    const response = await this.post(route, body, method);
    const transport: typeof fetch = async () => response;
    return z
      .record(z.string(), z.any())
      .parse(
        resourceJson(
          await readResourceResponse(transport, `${API}${route}`, { maxBytes: JSON_LIMIT, timeoutMs: 60_000 }),
        ),
      );
  }
  async download(address: string, maxBytes = 256 * 1024 * 1024) {
    const url = new URL(address);
    const allowed =
      url.hostname === "api.elevenlabs.io" ||
      url.hostname === "storage.googleapis.com" ||
      url.hostname.endsWith(".elevenlabs.io") ||
      url.hostname.endsWith(".elevenlabs.com");
    if (url.protocol !== "https:" || url.port || url.username || url.password || !allowed)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Untrusted ElevenLabs result URL; fetch from the original API resource",
      });
    // Signed result URLs never receive the account API key, including on redirects.
    return readResourceResponse(this.options.fetch ?? fetch, url.toString(), { maxBytes, timeoutMs: 60_000 });
  }
}
export async function appendFile(form: FormData, name: string, file: string) {
  form.append(name, await openAsBlob(file), file.split(/[\\/]/).at(-1)!);
}
