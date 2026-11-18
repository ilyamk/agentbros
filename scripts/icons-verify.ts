import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs, runScript, CliErrorObject } from "../src/lib/cli";
import { IconResources } from "../src/lib/icon-resources/service";
import { localCatalogue } from "../src/lib/icon-resources/providers";
runScript(async () => {
  const args = parseArgs([
    { name: "live", type: "boolean", description: "Explicitly contact Iconify and SVGL public APIs" },
  ] as const);
  const root = mkdtempSync(path.join(os.tmpdir(), "icons-verify-"));
  mkdirSync(path.join(root, "public/projects/verify"), { recursive: true });
  writeFileSync(path.join(root, "public/projects/verify/project.json"), "{}");
  try {
    const service = new IconResources(root, "verify");
    const results = [];
    for (const provider of ["phosphor", "lucide", "tabler", "simple-icons"] as const) {
      const candidates = localCatalogue(provider);
      const candidate = candidates.find((c) => c.name === "shield") ?? candidates[0];
      const acquired = await service.acquire(candidate.id, { offline: true });
      const exported = await service.export(acquired.id);
      results.push({ provider, count: candidates.length, candidate: candidate.id, export: exported.hash });
    }
    if (args.live) {
      const found = await service.search({ query: "shield", providers: ["iconify"], collection: "mdi" });
      if (!found.results.length) throw Error("Iconify search returned no results");
      const icon = await service.acquire(found.results[0].id);
      await service.export(icon.id);
      results.push({ provider: "iconify", search: found.results.length });
      const logos = await service.search({ query: "google", providers: ["svgl"], kind: "brand" });
      if (!logos.results.length) throw Error("SVGL search returned no results");
      const logo = await service.acquire((logos.results.find((c) => c.title === "Google") ?? logos.results[0]).id);
      await service.export(logo.id);
      const themed = await service.search({ query: "vercel", providers: ["svgl"], kind: "brand" });
      const variants: string[] = [];
      if (!themed.results.length) throw Error("SVGL themed sample is missing");
      const inspected = await service.inspect(themed.results[0].id);
      for (const variant of inspected.variants) {
        const item = await service.acquire(inspected.id, { variant });
        await service.export(item.id, { format: "webp", size: 128 });
        variants.push(variant);
      }
      results.push({ provider: "svgl", search: logos.results.length, variants });
    }
    return { metadata: { results, live: args.live ?? false, check: service.check() } };
  } catch (error) {
    throw new CliErrorObject({ code: "VALIDATION", message: String(error) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
