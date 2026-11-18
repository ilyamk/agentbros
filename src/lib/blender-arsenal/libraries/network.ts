import type { Source } from "./schemas";

const HOSTS: Record<string, string[]> = {
  polyhaven: ["dl.polyhaven.org"],
  ambientcg: ["ambientcg.com", "acg-download.struffelproductions.com"],
  "khronos-samples": ["raw.githubusercontent.com"],
  "google-fonts": ["raw.githubusercontent.com"],
  polypizza: ["static.poly.pizza"],
  smithsonian: ["3d-api.si.edu"],
};
export function assertStableDownloadUrl(value: string): void {
  const url = new URL(value);
  for (const key of url.searchParams.keys())
    if (!["file", "download"].includes(key))
      throw new Error("Canonical download URL contains credentials or an expiring signature");
}
export function assertDownloadHost(value: string, source: Pick<Source, "id" | "adapter" | "config">): URL {
  const url = new URL(value);
  const hosts =
    source.config.downloadHosts ??
    (source.adapter === "blender-library-server" ? ["cdn.extensions.blender.org"] : (HOSTS[source.id] ?? []));
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    /(^|\.)ihdri\.com$/.test(url.hostname) ||
    !hosts.includes(url.hostname)
  )
    throw new Error(`Unapproved download host: ${url.hostname} (${source.id})`);
  return url;
}
/** Every redirect is checked before sending a request; token URLs never become pins. */
export function downloadFetch(source: Source, request: typeof fetch): typeof fetch {
  return async (input, init) => {
    let url = String(input);
    for (let hop = 0; hop < 4; hop++) {
      assertDownloadHost(url, source);
      const headers = new Headers(init?.headers);
      headers.set("User-Agent", "AI-Video-Creator/1.0 (Powered by Poly Haven)");
      if (
        source.adapter === "poly-pizza-api" &&
        new URL(url).hostname === "static.poly.pizza" &&
        process.env.POLY_PIZZA_API_KEY
      )
        headers.set("x-auth-token", process.env.POLY_PIZZA_API_KEY);
      const response = await request(url, { ...init, headers, redirect: "manual" });
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Download redirect has no Location");
      url = new URL(location, url).toString();
    }
    throw new Error("Download redirect limit exceeded");
  };
}
