# Caption editor: worked example and shapes

A worked edit and output shapes for the `caption-editor` agent; the rules live in [caption-editor.md](../../../agents/caption-editor.md).

## `edit-captions.ts` stdout

```
{ "ok": true, "outputs": [...], "metadata": { "projectId": "...", "language": "en", "wordsInView": 3, "edited": N, "skipped": N, "failed": N, "perScene": [...], "captionEditPath": "..." }, "elapsedMs": N }
```

## `pipeline/caption-edit.json` (`CaptionEditSchema`)

```json
{
  "scenes": [
    {
      "sceneId": "s01-hook",
      "words": [
        { "text": "Stop", "start": 0.12, "end": 0.45, "emphasis": true },
        { "text": "scrolling", "start": 0.48, "end": 0.91, "emphasis": false }
      ],
      "droppedFillers": ["um", "like"]
    }
  ],
  "wordsInView": 3
}
```

## `voiceover/{sceneId}.words.edited.json`

```json
{
  "words": [
    { "text": "Stop", "start": 0.12, "end": 0.45, "emphasis": true },
    { "text": "scrolling", "start": 0.48, "end": 0.91, "emphasis": false }
  ],
  "droppedFillers": ["um", "like"]
}
```

The raw ElevenLabs format has `loss` per word and a top-level `characters` array; the edited format drops both and adds `emphasis` and `droppedFillers`.

## `pipeline/caption-edit.md` scene block

```
## s01-hook
Before (8 words): Stop um scrolling like this is huge
After  (6 words): Stop scrolling this is huge
Dropped: um, like
Emphasis: Stop, huge
```

## Worked edit: `s02-pain` (10 words, English)

Beat text: `You know the feeling when everything just STOPS working`; attention device: pain resonance.

Raw words (`loss` omitted): You 0.00–0.18, know 0.19–0.38, the 0.39–0.48, feeling 0.49–0.82, um 0.83–0.95, when 1.02–1.19, everything 1.21–1.65, just 1.67–1.81, STOPS 1.83–2.10, working 2.12–2.51.

1. Filler removal: `um` dropped (10%, within range); `droppedFillers: ["um"]`.
2. Orphan merge: `the` is a short particle with a 10 ms gap (< 80 ms) before `feeling`, neither has terminal punctuation → `{ "text": "the feeling", "start": 0.39, "end": 0.82 }`.
3. Emphasis: `STOPS` is upper case in the beat text → `emphasis: true` (one word, within range).

Result: You, know, the feeling, when, everything, just, STOPS (emphasis), working — 8 entries, retention 8/10 = 80%, which passes.
