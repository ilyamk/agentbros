import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { ReferencePackSpec } from "../../../types/references";
import { ScriptSchema } from "../../../types/pipeline";
import { VoiceRefSchema } from "../../../types/elevenlabs";
import { projectOutput, regularInput, verifyVoiceRef } from "../../elevenlabs/files";
import { speechAlignmentPath } from "../../elevenlabs/operations";
import { sameSpokenWords } from "../../elevenlabs/direction";
import { canonicalInputIdentity } from "../../jobs/identity";
import { CliErrorObject } from "../../cli";

const lineSchema = z.object({
  lineId: z.string(),
  speaker: z.string(),
  approvedText: z.string(),
  voiceRef: VoiceRefSchema.optional(),
});
const receiptSchema = z.object({
  sha256: z.string(),
  alignmentSha256: z.string(),
  output: z.string(),
  request: z.object({ language: z.string(), turns: z.array(lineSchema).optional() }).passthrough(),
});
const wordsSchema = z.object({
  sourceSha256: z.string(),
  words: z.array(z.object({ lineId: z.string(), speaker: z.string().optional(), start: z.number(), end: z.number() })),
});

const scriptPath = (projectId: string) => `public/projects/${projectId}/pipeline/script.json`;

export function pinPackSpeechScript(projectId: string, spec: ReferencePackSpec, root: string): ReferencePackSpec {
  const usesScript = spec.nativeSpeech || spec.attachments.some(({ speech }) => speech?.kind === "performed-lines");
  if (!usesScript || spec.scriptSha256) return spec;
  const file = projectOutput(root, projectId, scriptPath(projectId)).file;
  if (!existsSync(file)) return spec;
  const script = regularInput(root, file, root, 4 * 1024 * 1024);
  return { ...spec, scriptSha256: script.sha256 };
}

export function verifyPackSpeech(projectId: string, spec: ReferencePackSpec, root: string) {
  try {
    verifySpeechInputs(projectId, spec, root);
  } catch (error) {
    if (error instanceof CliErrorObject) throw error;
    throw new CliErrorObject({ code: "VALIDATION", message: (error as Error).message });
  }
}

function verifySpeechInputs(projectId: string, spec: ReferencePackSpec, root: string) {
  const shotLines = [
    ...(spec.nativeSpeech ?? []),
    ...spec.attachments.flatMap(({ speech }) => (speech?.kind === "performed-lines" ? speech.lines : [])),
  ];
  if (!shotLines.length) return;
  const scriptFile = projectOutput(root, projectId, scriptPath(projectId)).file;
  const scriptVoices = new Map<string, z.infer<typeof VoiceRefSchema>>();
  if (spec.scriptSha256 || existsSync(scriptFile)) {
    const file = regularInput(root, scriptFile, root, 4 * 1024 * 1024);
    if (spec.scriptSha256 && file.sha256 !== spec.scriptSha256) throw Error("Approved speech script changed");
    const script = ScriptSchema.parse(JSON.parse(readFileSync(file.file, "utf8")));
    const declared = [
      ...(script.dialogue ?? []),
      ...script.beats
        .filter((beat) => beat.lineId)
        .map((beat) => ({ ...beat, language: script.language, shotId: undefined, voiceRef: script.voiceRef })),
    ];
    for (const line of declared) if (line.lineId && line.voiceRef) scriptVoices.set(line.lineId, line.voiceRef);
    if (
      declared.length &&
      shotLines.some((line) => {
        const source = declared.find((row) => row.lineId === line.lineId);
        return (
          !source ||
          source.speakerId !== line.speakerId ||
          source.language !== line.language ||
          (source.shotId && source.shotId !== spec.shotId) ||
          source.text !== line.text
        );
      })
    )
      throw Error("Speech pack differs from its current script lines");
  }
  for (const attachment of spec.attachments) {
    const speech = attachment.speech;
    if (speech?.kind !== "performed-lines") continue;
    const receiptPath = projectOutput(root, projectId, speech.receipt).file;
    const receiptFile = regularInput(root, receiptPath, root, 4 * 1024 * 1024);
    if (receiptFile.sha256 !== speech.receiptSha256) throw Error("Speech take receipt changed");
    const receipt = receiptSchema.parse(JSON.parse(readFileSync(receiptFile.file, "utf8")));
    const take = projectOutput(root, projectId, path.join("public/projects", projectId, receipt.output)).file;
    if (
      receiptPath !== `${take}.take.json` ||
      receipt.sha256 !== speech.sha256 ||
      regularInput(root, take, root).sha256 !== speech.sha256
    )
      throw Error("Speech take bytes do not match the bound attachment");
    const alignment = regularInput(root, speechAlignmentPath(take), root, 4 * 1024 * 1024);
    if (alignment.sha256 !== receipt.alignmentSha256) throw Error("Speech take alignment changed");
    const aligned = wordsSchema.parse(JSON.parse(readFileSync(alignment.file, "utf8")));
    if (aligned.sourceSha256 !== speech.sha256) throw Error("Speech alignment belongs to another take");
    const authored = receipt.request.turns ?? [lineSchema.parse(receipt.request)];
    if (authored.length !== speech.lines.length) throw Error("Declare every line in the supplied take");
    for (const [index, line] of speech.lines.entries()) {
      const source = authored[index]!;
      if (!source.voiceRef) throw Error(`Speech line ${line.lineId} needs a pinned VoiceRef`);
      const approvedVoice = scriptVoices.get(line.lineId);
      if (
        approvedVoice &&
        canonicalInputIdentity(source.voiceRef).sha256 !== canonicalInputIdentity(approvedVoice).sha256
      )
        throw Error(`Speech line ${line.lineId} uses a different voice from the approved script`);
      verifyVoiceRef(root, source.voiceRef, root, "video-reference");
      if (source.voiceRef.manifest && !source.voiceRef.selection)
        throw Error("Select a listening-approved clone before binding a video reference");
      const words = aligned.words.filter((word) => word.lineId === line.lineId);
      if (
        source.lineId !== line.lineId ||
        source.speaker !== line.speakerId ||
        receipt.request.language !== line.language ||
        !sameSpokenWords(source.approvedText, line.text) ||
        !words.length ||
        words.some((word) => word.speaker !== line.speakerId)
      )
        throw Error(`Speech line ${line.lineId} differs from its take or speaker alignment`);
      if (words.at(-1)!.end - words[0]!.start > line.endSec - line.startSec + 0.05)
        throw Error(`Speech line ${line.lineId} does not fit the shot window`);
      if (
        speech.use === "drive" &&
        (words[0]!.start < line.startSec - 1 / 30 || words.at(-1)!.end > line.endSec + 1 / 30)
      )
        throw Error(`Speech-driven line ${line.lineId} does not match the take's clock`);
    }
  }
}
