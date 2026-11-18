# Narrator director: worked examples

Long examples and lookup tables for the `narrator-director` agent; the rules live in [narrator-director.md](../../../agents/narrator-director.md).

## Audio tags on Eleven v4 and v3

Choose a tag for the audible change, using natural language. The examples below span the available categories. Consult the dated [ElevenLabs tag guide](https://elevenlabs.io/blog/elevenlabs-audio-tags-list) for audio examples and additional wording. The vocabulary is open.

| Need | Example direction |
|---|---|
| Delight, pride, surprise | `[delighted, trying to stay composed]` |
| Irritation, anger, sarcasm | `[irritated, keeping it professional]` |
| Anxiety, fear, vulnerability | `[nervous, trying to sound reassuring]` |
| Tiredness, boredom, disappointment | `[exhausted, with quiet disappointment]` |
| Calm, curiosity, warmth | `[gently curious, giving them room to answer]` |
| Timbre and level | `[low, gravelly voice]` or `[whispers]` |
| Pace and pauses | `[picks up the pace]` or `[brief pause]` |
| A change during a line | `[calm at first, then firm]` before the affected phrase |
| Body and reactions | `[sharp intake of breath]` or `[laughs]` |
| Accent and character | `[with a light Scottish accent]` or `[like a tired night-shift dispatcher]` |
| Sound within a performance | `[distant train rumble]` only if the brief asks for the sound in the take |

Keep narration, lip-sync audio and dialogue stems dry by default. Put ambient
effects on their own track. Keep visible action in the video prompt.

**RU.** Approved words `Ты меня слышишь? Тогда слушай внимательно.`.
Directed take `[quietly, checking the connection] Ты меня слышишь? [firm, controlled urgency] Тогда слушай внимательно.`.

**EN.** Approved words `We saved a copy. Open it only after the call.`.
Directed take `[reassuring] We saved a copy. [slower, making the condition clear] Open it only after the call.`.

Both models use punctuation and tags for expressive pauses. Put measured
silence on the timeline when an exact frame matters. In v4 choose a
versioned pronunciation dictionary for recurring names or inline IPA for a
one-off. Preserve the display text and record the expected spoken form.

## Delivery register by motionStyle

| motionStyle | Register |
|-------------|----------|
| `snappy` | Shorter pauses (150–300ms max), clean articulation |
| `smooth` | Flowing rhythm, no hard stops |
| `cinematic` | Longer breaths, deliberate pacing |
| `playful` | Lifted energy, light touch on tags |

## Worked beat (hook, 3s, cinematic)

Original: `What if I told you the most powerful coder on Earth wasn't human anymore?`

```
directedText: "[curious]What if I told you… the most powerful coder on Earth — wasn't human, anymore?"
emotionalContext: "leaning in, building suspicion"
emphasisWords: ["powerful", "human"]
speechSettings: stability 0.4, similarity_boost 0.75
```

One tag sets the register; the ellipsis lets the listener anticipate the claim; the dash lands the pivot; emphasis falls on the two words that carry the payload.

## Mode A output

```jsonc
{
  "modelId": "eleven_v4",
  "speechSettings": { "stability": 0.4, "similarity_boost": 0.75 },
  "beats": [
    { "beatId": "b01-hook", "directedText": "[curious]What if I told you… ...", "emotionalContext": "leaning in, building suspicion", "emphasisWords": ["powerful", "human"] }
  ],
  "pacingNote": "Lead with quiet curiosity; build through brisk pain; warmth on the CTA."
}
```

## Mode B output (native presenter audio)

```jsonc
{
  "modelId": "seedance-2-fast",
  "beats": [],
  "nativeAudioDirection": {
    "language": "ru",
    "totalSeconds": 15,
    "presenterPersona": "lecturer — calm, slightly contrarian, never raises voice",
    "deliveryArc": [
      { "fromSec": 0, "toSec": 4, "direction": "neutral curious tone, slight head-tilt on the contradiction" },
      { "fromSec": 4, "toSec": 9, "direction": "empathetic concern, brow softens, palms open" },
      { "fromSec": 9, "toSec": 14, "direction": "confident lecturer authority, single calm nod on the statistic" },
      { "fromSec": 14, "toSec": 15, "direction": "warm collegial close, half-smile" }
    ],
    "fullScript": "Падение биткоина — это не катастрофа. Это распродажа. ...",
    "constraints": [
      "No on-screen captions or subtitles in the generated video.",
      "No background music in the generated audio — keep voice clean for downstream mixing.",
      "Direct-to-camera medium-close shot, vertical 9:16."
    ]
  }
}
```

`modelId` here is the historical example; use the exact presenter model chosen in the asset plan.

## Companion `.md` beat block

```
## Beat {id} — {kind} ({durationSec}s)
ORIGINAL: {beat.text}
DIRECTED: {directedText}
Emotional context: {emotionalContext}
Emphasis: {emphasisWords}
```
