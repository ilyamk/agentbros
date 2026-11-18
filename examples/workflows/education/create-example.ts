/** Offline reproducible synthetic teaching package. Tones are test audio, not narration. */
import path from "node:path";
import { mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { educationFixture } from "../../../tests/workflow-education-fixture";
import { runEducationWorkflow } from "../../../src/lib/workflows/education";
const destination = path.resolve(process.argv[2] ?? "out/education-example");
mkdirSync(path.dirname(destination), { recursive: true });
mkdirSync(destination);
const f = educationFixture(true);
try {
  for (const filename of ["source.md", "diagram.png", "example.png", "voice.wav", "music.wav"])
    copyFileSync(path.join(f.root, filename), path.join(destination, filename));
  for (const input of [...f.request.sources, ...f.request.media]) input.file = path.join(destination, input.file);
  writeFileSync(path.join(destination, "request.json"), JSON.stringify(f.request, null, 2), { flag: "wx" });
  const plan = runEducationWorkflow(f.request, {
    action: "plan",
    rootDir: destination,
  });
  writeFileSync(
    path.join(destination, "treatment.json"),
    JSON.stringify(
      {
        label:
          "Synthetic technical demonstration — replace tones with actual approved narration and diagrams with authored educational graphics before delivery",
        ...plan.metadata,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  process.stdout.write(
    `${JSON.stringify({ ok: true, outputs: [path.join(destination, "request.json"), path.join(destination, "treatment.json")], elapsedMs: 0 })}\n`,
  );
} finally {
  f.cleanup();
}
