import path from "node:path";
import { readRejectedObservation } from "../src/lib/ingest/rejected-observation";
import { parseArgs, runScript, CliErrorObject } from "../src/lib/cli";
import {
  prepareExistingCorpus,
  readPreparedCorpus,
  runCorpusDiagnostics,
  captureCorpusFile,
} from "../src/lib/ingest/corpus-diagnostics";
import { LocalWorkerConfigSchema } from "../src/lib/ingest/local-worker";
runScript(async () => {
  const a = parseArgs([
    {
      name: "action",
      required: true,
      description: "prepare, inspect, inspect-rejected or run fixed existing AI/TTS corpus diagnostics",
    },
    { name: "source-root", description: "Audited original repository root; originals never changed" },
    { name: "output", description: "New immutable prepared-corpus artifact root" },
    { name: "manifest", description: "Prepared immutable manifest JSON" },
    { name: "manifest-sha256", description: "Exact reviewed manifest checksum for inspect/run" },
    { name: "config", description: "Trusted CLI-only installed offline whisper native-word configuration" },
    { name: "receipt", description: "Quarantined observation receipt for inspect-rejected" },
    { name: "receipt-sha256", description: "Exact reviewed observation receipt checksum" },
    { name: "entry", description: "Exact fixed corpus entry ID for inspect-rejected" },
    {
      name: "retain-rejected-observation",
      type: "boolean",
      description: "Opt-in quarantined raw observations for fresh strict clock refusals; never usable timings",
    },
    { name: "project", description: "Existing isolated diagnostic project" },
  ] as const);
  if (a.action === "prepare") {
    if (!a["source-root"] || !a.output)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "prepare requires source-root and output" });
    const r = prepareExistingCorpus(a["source-root"], a.output);
    return {
      outputs: [r.file],
      metadata: {
        manifestSha256: captureCorpusFile(r.file).sha256,
        cacheHit: r.cacheHit,
        corpusKey: r.manifest.key,
        entries: r.manifest.entries.length,
        providerSpendUsd: 0,
        humanGroundTruth: false,
        approved: false,
      },
    };
  }
  if (!a.manifest || !a["manifest-sha256"])
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "inspect/run require exact manifest and manifest-sha256",
    });
  if (a.action === "inspect-rejected") {
    if (!a.receipt || !a["receipt-sha256"] || !a.project || !a.entry)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "inspect-rejected requires receipt/receipt-sha256/project/entry plus exact manifest pins",
      });
    const manifest = readPreparedCorpus(a.manifest, a["manifest-sha256"]),
      entry = manifest.entries.find((e) => e.id === a.entry);
    if (!entry) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Unknown fixed corpus entry" });
    const observation = readRejectedObservation(a.project, a.receipt, a["receipt-sha256"], {
      manifestFile: path.resolve(a.manifest),
      manifestSha256: a["manifest-sha256"],
      corpusKey: manifest.key,
      entryId: entry.id,
      originalSha256: entry.original.sha256,
      inputSha256: entry.input.sha256,
    });
    return {
      outputs: [a.receipt],
      metadata: {
        kind: observation.receipt.kind,
        sha256: observation.receiptSha256,
        rawSha256: observation.receipt.raw.sha256,
        refusal: observation.receipt.refusal,
        lexicalHypothesis: observation.lexicalHypothesis,
        accepted: false,
        approved: false,
        timingUse: "forbidden",
        reviewRequired: true,
      },
    };
  }
  if (a.action === "inspect") {
    const m = readPreparedCorpus(a.manifest, a["manifest-sha256"]);
    return {
      outputs: [],
      metadata: {
        corpusKey: m.key,
        entries: m.entries.length,
        providerSpendUsd: 0,
        humanGroundTruth: false,
        approved: false,
      },
    };
  }
  if (a.action !== "run" || !a.config || !a.project)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "run requires config/project; supported actions prepare/inspect/inspect-rejected/run",
    });
  const config = LocalWorkerConfigSchema.parse(JSON.parse(captureCorpusFile(a.config).bytes.toString()));
  const r = await runCorpusDiagnostics({
    manifestFile: a.manifest,
    manifestSha256: a["manifest-sha256"],
    config,
    projectId: a.project,
    ...(a["retain-rejected-observation"] ? { retainRejectedObservation: true } : {}),
  });
  return {
    outputs: [r.file],
    metadata: {
      sha256: r.sha256,
      entries: r.report.entries.length,
      observedOsNetworkDenial: r.report.observedOsNetworkDenial,
      providerSpendUsd: 0,
      humanGroundTruth: false,
      approved: false,
    },
  };
});
