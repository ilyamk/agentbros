# Executable supplied-recording workflow

Use [`docs/workflows/recording-edit.md`](../../../../docs/workflows/recording-edit.md) and the strict request type `src/types/workflow-recording-edit.ts`.

1. Obtain an original recording, SHA256/version and supplied word timings. Version 1 uses verified 30fps CFR source frames. For VFR or exact 30000/1001 use version 2: indices address decoded ORIGINAL frames, not nominal-fps seconds or normalized master frames. Supply the explicit normalization policy from the linked guide. No ASR or provider calls are needed.
2. Declare chronological keep spans, exact complementary cuts with reasons, whole statement/negation/caveat/attribution/context protections and recording-only profile.
3. Plan using `runRecordingEditWorkflow(request,{action:'plan'})`. Watch full original and contextual proposed cuts. A whole irrelevant protected statement may be removed; surviving statements may never lose their negation or qualification.
4. Present editHash and context mapping to the human. Never manufacture review or claim that a lexical heuristic proves preserved meaning.
5. Create only after the supplied hash-bound review declaration. Render with `--timeline`, inspect every cut, full output speech, captions and format crops. Keep originals and complete transcript.
6. Use synchronized batch commands with revision checks/undo for timeline changes, or a new lineage-bound project and new review for revised selections. Do not reuse stale approval for modified edits. Delivery and rights review remain required.

Version 2 planning measures original PTS and decoded audio clocks. Review the source-to-master mapping, repeated/dropped frames, outward keep boundaries and terminal adjustment together with the cuts; policy, map, timing and tool version bind the edit hash. Captions quantize to nearest 30fps boundaries; keeps round outward to preserve the start of speech. Move unsafe cuts into silence rather than silently including excluded words. Original audio/video endpoints may differ by up to one frame; the additional master ceil extension is less than one frame. Total terminal audio pad/trim is bounded to two frames (66.7ms) and cannot replace a retained supplied word. Unsupported offsets, gaps and ambiguous terminal timestamps fail. Originals stay immutable; normalized silent picture and authentic PCM are separate derivatives. Timeline edits/undo use 30fps master coordinates.

Local browser fixture evidence is synthetic; it cannot approve a creator's actual content or production fonts. Do not reinterpret legacy requests or manufacture supplied word timing. For long conversions use the CLI or an explicitly configured longer MCP timeout; the default bridge timeout is 60 seconds.
