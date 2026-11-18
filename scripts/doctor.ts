import { inspectCapabilities } from "../src/lib/local-capabilities";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { formatReport, overall } from "../src/lib/doctor";
import { collectDoctorChecks } from "../src/lib/doctor/collect";

runScript(async () => {
  parseArgs([] as const);
  const { os, checks, keys } = await collectDoctorChecks();
  process.stderr.write(formatReport(checks, keys));

  const { ok, counts } = overall(checks);
  const localCapabilities = os === "macos" ? await inspectCapabilities(undefined, { persist: true }) : [];
  const metadata = {
    localCapabilities: localCapabilities
      .filter((c) => c.state === "ready")
      .map((c) => ({ task: c.task, quality: c.quality })),
    os,
    ok,
    counts,
    checks,
    keys: Object.fromEntries(keys.map((key) => [key.name, key.set])),
  };
  if (!ok)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${counts.fail} required check(s) failed.`,
      details: metadata,
    });
  return { metadata };
});
