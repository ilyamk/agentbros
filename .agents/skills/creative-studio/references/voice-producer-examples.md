# Voice producer: output shapes

Script envelopes and the status report for the `voice-producer` agent; the rules live in [voice-producer.md](../../../agents/voice-producer.md).

## `generate-voiceover.ts` stdout

```
{ "ok": true, "outputs": [...], "metadata": { "perUnit": [ { "sceneId": "...", "status": "done"|"skipped"|"error", "wordCount": N } ] }, "elapsedMs": N }
```

## `align-captions.ts` stdout

```
{ "ok": true, "outputs": [...], "metadata": { "projectId": "...", "aligned": N, "skipped": N, "failed": N, "perScene": [...] }, "elapsedMs": N }
```

`outputs[]` lists the `.words.json` paths; `perScene[]` entries with `status: "failed"` name the failed scenes.

## `pipeline/voiceover-status.json`

```jsonc
{
  "skipped": false,
  "voice": "{narratorVoice}",
  "narratorDirection": { "applied": true, "modelId": "eleven_v3" },
  "scenes": [
    {
      "sceneId": "s01-hook",
      "mp3": "done",          // "done" | "missing" | "skipped-empty-text" | "error"
      "words": "done",        // "done" | "missing" | "skipped-empty-text" | "error"
      "wordCount": 7
    }
  ],
  "errors": [],
  "notes": []                // TTS skips, presenter/narrator split, pending alignment with owner and next step
}
```

Voiceover disabled:

```json
{ "skipped": true, "reason": "voiceoverEnabled is false in script.json" }
```
