import { rasterise } from "./worker";
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { inspectAsset } from "../assets/inspect";
import {
  IconCandidateSchema,
  IconExportOptionsSchema,
  IconManifestSchema,
  type IconProvider,
  type IconCandidate,
} from "../../types/icon-resources";
import { readResources, importResource } from "../font-resources/registry";
import { importAsset } from "../assets/registry";
import { CliErrorObject } from "../cli";
import { IconHttp } from "./http";
import { iconifyCandidate, localCatalogue, localSvg, svglCatalogue, capabilities } from "./providers";
import { searchIcons } from "./search";
import { atomicJson, digest, iconFile, projectPath, readManifest, readProfile, scoped, withLock } from "./storage";
import { styleSvg, validateSvg } from "./svg";

const exporter = "chromium-4.0.539/jsquash-webp-1.5.0/svg-1";
export class IconResources {
  constructor(
    readonly root: string,
    readonly project: string,
    readonly http = new IconHttp(),
    private rasteriser = rasterise,
  ) {
    projectPath(root, project);
  }
  capabilities() {
    return capabilities();
  }
  search(options: Parameters<typeof searchIcons>[0]) {
    this.http.begin();
    const profile = readProfile(this.root, this.project);
    return searchIcons(
      { ...options, preferred: profile?.provider },
      this.http,
      readManifest(this.root, this.project).acquisitions.map((a) => a.candidate),
    );
  }
  async inspect(id: string, offline = false): Promise<IconCandidate> {
    this.http.begin();
    const existing = readManifest(this.root, this.project).acquisitions.find((a) => a.candidate.id === id);
    if (existing) return existing.candidate;
    const match = /^(phosphor|lucide|tabler|simple-icons|iconify|svgl):([a-z0-9-]+)(?::([a-z0-9-]+))?$/.exec(id);
    if (!match) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid candidate ID" });
    const provider = match[1] as IconProvider;
    if (provider === "iconify" || provider === "svgl") {
      if (offline)
        throw new CliErrorObject({
          code: "ASSET_MISSING",
          message: "Candidate has not been acquired locally; offline mode forbids discovery",
        });
      if (provider === "iconify") {
        if (!match[3])
          throw new CliErrorObject({ code: "INVALID_INPUT", message: "Iconify ID requires collection:name" });
        return iconifyCandidate(this.http, match[2], match[3]);
      }
      const item = (await svglCatalogue(this.http, "")).find((c) => c.id === id);
      if (item) return item;
    } else {
      if (match[3]) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Unexpected candidate suffix" });
      const item = localCatalogue(provider).find((c) => c.id === id);
      if (item) return item;
    }
    throw new CliErrorObject({ code: "ASSET_MISSING", message: `Candidate not found: ${id}` });
  }
  async acquire(
    id: string,
    options: { variant?: string; offline?: boolean; allowStyleOverride?: boolean; reason?: string } = {},
  ) {
    const manifest = readManifest(this.root, this.project),
      profile = readProfile(this.root, this.project);
    const candidate = IconCandidateSchema.parse(await this.inspect(id, options.offline));
    const variant =
      options.variant ??
      (candidate.kind === "icon" && profile?.provider === candidate.provider
        ? profile.variant
        : candidate.variants.includes("regular")
          ? "regular"
          : candidate.variants.includes("outline")
            ? "outline"
            : candidate.variants.includes("original")
              ? "original"
              : candidate.variants[0]);
    if (!candidate.variants.includes(variant))
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Unsupported variant ${variant}; choose ${candidate.variants.join(", ")}`,
      });
    if (
      candidate.kind === "icon" &&
      profile &&
      (profile.provider !== candidate.provider || profile.variant !== variant) &&
      (!options.allowStyleOverride || !options.reason?.trim())
    )
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Candidate differs from the project profile; explicit style override and reason required",
      });
    const previous = manifest.acquisitions.find((a) => a.candidate.id === id && a.variant === variant);
    if (previous) {
      this.check();
      return previous;
    }
    let svg: string;
    if (candidate.provider === "iconify" || candidate.provider === "svgl") {
      if (options.offline)
        throw new CliErrorObject({
          code: "ASSET_MISSING",
          message: "Original is not local; offline mode forbids download",
        });
      svg = (
        await this.http.get(
          candidate.provider === "svgl" ? candidate.routes![variant] : candidate.source,
          2 * 1024 * 1024,
        )
      ).toString("utf8");
    } else svg = localSvg(candidate, variant);
    validateSvg(svg);
    return withLock(iconFile(this.root, this.project, "store.lock"), () => {
      const current = readManifest(this.root, this.project),
        prior = current.acquisitions.find((a) => a.candidate.id === id && a.variant === variant);
      if (prior) return prior;
      const temporary = mkdtempSync(iconFile(this.root, this.project, ".acquire-"));
      try {
        const source = path.join(temporary, "original.svg");
        writeFileSync(source, svg, { flag: "wx" });
        const checkedAt = new Date().toISOString();
        const record = importResource(
          this.project,
          source,
          {
            kind: "svg-icon",
            provider: candidate.provider,
            collection: candidate.collection,
            name: candidate.name,
            source: candidate.source,
            licence: candidate.rights.licence,
            licenceEvidence: candidate.rights.licenceUrl,
            licenceText: candidate.rights.notice,
            attribution: candidate.rights.attribution,
            checkedAt,
          },
          this.root,
        );
        const acquisitionId = digest(`${id}:${variant}:${record.hash}:${JSON.stringify(candidate)}`),
          metadataFile = `projects/${this.project}/resources/icons/${acquisitionId}.source.json`;
        atomicJson(scoped(this.root, this.project, metadataFile), {
          candidate,
          variant,
          checkedAt,
          styleOverride: options.allowStyleOverride ? options.reason : undefined,
        });
        const acquisition = {
          id: acquisitionId,
          candidate,
          variant,
          resourceId: record.id,
          original: record.original,
          hash: record.hash,
          checkedAt,
          metadataFile,
        };
        current.acquisitions.push(acquisition);
        current.revision++;
        atomicJson(iconFile(this.root, this.project, "manifest.json"), IconManifestSchema.parse(current));
        return acquisition;
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    });
  }
  async export(resourceId: string, input: unknown = {}) {
    this.check();
    const manifest = readManifest(this.root, this.project),
      profile = readProfile(this.root, this.project);
    const acquisition = manifest.acquisitions.find((a) => a.id === resourceId || a.resourceId === resourceId);
    if (!acquisition)
      throw new CliErrorObject({ code: "ASSET_MISSING", message: "Acquire the SVG before exporting it" });
    const icon = acquisition.candidate.kind === "icon";
    const options = IconExportOptionsSchema.parse({
      ...(profile
        ? {
            size: profile.size,
            padding: profile.padding,
            background: profile.background,
            ...(icon ? { colour: profile.colour, strokeWidth: profile.strokeWidth } : {}),
          }
        : {}),
      ...(input as object),
    });
    if (
      icon &&
      profile &&
      (profile.provider !== acquisition.candidate.provider || profile.variant !== acquisition.variant) &&
      (!options.allowStyleOverride || !options.reason)
    )
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Export differs from the project profile; explicit style override and reason required",
      });
    if (
      acquisition.candidate.kind === "brand" &&
      (options.colour || options.strokeWidth) &&
      (!options.allowStyleOverride || !options.reason)
    )
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Changing a brand requires an explicit override and reason; check its guidelines",
      });
    if (
      options.strokeWidth &&
      (acquisition.candidate.provider === "phosphor" || acquisition.candidate.kind === "brand")
    )
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Stroke width is supported only by stroke-based icons",
      });
    const id = digest(JSON.stringify({ source: acquisition.id, options, exporter, profile }));
    const prior = manifest.derivatives.find((d) => d.id === id);
    if (prior) return this.result(prior);
    const dir = iconFile(this.root, this.project, "");
    mkdirSync(dir, { recursive: true });
    const temporary = mkdtempSync(path.join(dir, ".export-"));
    try {
      const svg = styleSvg(readFileSync(scoped(this.root, this.project, acquisition.original), "utf8"), options),
        source = path.join(temporary, "input.svg"),
        output = path.join(temporary, `output.${options.format}`);
      writeFileSync(source, svg, { flag: "wx" });
      if (options.format === "svg") writeFileSync(output, svg, { flag: "wx" });
      else await this.rasteriser(source, output, options.format);
      const bytes = readFileSync(output),
        hash = digest(bytes);
      if (options.format !== "svg") {
        const info = inspectAsset(output);
        if (
          info.media.width !== options.size ||
          info.media.height !== options.size ||
          info.mime !== `image/${options.format}`
        )
          throw Error("Raster output failed inspection");
      }
      return withLock(iconFile(this.root, this.project, "store.lock"), () => {
        const current = readManifest(this.root, this.project),
          duplicate = current.derivatives.find((d) => d.id === id);
        if (duplicate) return this.result(duplicate);
        const file = `projects/${this.project}/resources/icons/${hash}.${options.format}`,
          absolute = scoped(this.root, this.project, file);
        if (existsSync(absolute)) {
          if (digest(readFileSync(absolute)) !== hash) throw Error("Export collision");
        } else writeFileSync(absolute, bytes, { flag: "wx" });
        const asset =
          options.format === "svg"
            ? undefined
            : importAsset({
                projectId: this.project,
                rootDir: this.root,
                sourceFile: absolute,
                provenance: {
                  origin: "stock",
                  tool: `icons:${acquisition.candidate.provider}:${acquisition.candidate.id}`,
                },
                rights: {
                  licence: acquisition.candidate.rights.licence,
                  commercialAllowed: acquisition.candidate.rights.commercialAllowed,
                  attributionRequired: true,
                  attribution: acquisition.candidate.rights.attribution,
                  sourceUrl: acquisition.candidate.source,
                  checkedAsOf: acquisition.checkedAt,
                },
              }).asset;
        const derivative = {
          id,
          acquisitionId: acquisition.id,
          resourceId: acquisition.resourceId,
          sourceHash: acquisition.hash,
          file,
          hash,
          options,
          exporter,
          assetId: asset?.id,
          profile,
        };
        current.derivatives.push(derivative);
        current.revision++;
        atomicJson(iconFile(this.root, this.project, "manifest.json"), IconManifestSchema.parse(current));
        return this.result(derivative);
      });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  private result(derivative: ReturnType<typeof readManifest>["derivatives"][number]) {
    return {
      ...derivative,
      absolutePath: scoped(this.root, this.project, derivative.file),
      usage: {
        resourceId: derivative.resourceId,
        derivativeId: derivative.id,
        src: derivative.file,
        placementId: "replace-with-scene-id",
      },
    };
  }
  list() {
    return readManifest(this.root, this.project);
  }
  check() {
    readResources(this.project, this.root);
    const manifest = readManifest(this.root, this.project);
    for (const a of manifest.acquisitions) {
      const file = scoped(this.root, this.project, a.original);
      if (digest(readFileSync(file)) !== a.hash) throw Error("Icon original missing or changed");
      validateSvg(readFileSync(file, "utf8"));
      const metadata = JSON.parse(readFileSync(scoped(this.root, this.project, a.metadataFile), "utf8"));
      if (JSON.stringify(metadata.candidate) !== JSON.stringify(a.candidate))
        throw Error("Icon source metadata changed");
    }
    for (const d of manifest.derivatives) {
      const a = manifest.acquisitions.find((a) => a.id === d.acquisitionId);
      if (
        !a ||
        a.resourceId !== d.resourceId ||
        a.hash !== d.sourceHash ||
        digest(readFileSync(scoped(this.root, this.project, d.file))) !== d.hash
      )
        throw Error("Icon export missing, changed or detached from original");
    }
    return { acquisitions: manifest.acquisitions.length, derivatives: manifest.derivatives.length };
  }
}
