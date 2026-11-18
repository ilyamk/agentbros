# concept-director: worked examples

Products here are invented. "Lumen" is a fictional note-taking app that keeps quotes from connected sources; "Tally" is a fictional smart bike lock.

## Truth: claims

| Bad | Why | Good |
|---|---|---|
| "Lumen remembers your whole life", working | The product forbids "whole life"; coverage depends on sources | "A page per person with exact quotes from connected sources", working, `source: VALUE §4` |
| "Lumen answers your email for you", working | Email triage is in development, and the owner always sends | "Sorts email into tasks; the owner checks and sends the draft", in-development, `publicRule: teaser "soon" only` |
| "Works with ChatGPT and Gemini", working | True and still not sayable | "Works with your assistants on Mac", working, plus a `mayNotSay` entry for client names |

Unchecked keys in `product-truth.json` that later agents read: `claims[].source` (document and section), `claims[].publicRule`, `mayNotSay[]` {wish, why, sayInstead}, `showingLimits[]` {what, limit, source}, `flow` {entry, action, result}, `alternatives[]` {what, lacks} (by category if rivals may not be named), `material[]` {what, where, state: exists|needs-capture|missing|unknown}.

A claim with mixed status splits: "Works. Card redesign in progress" is two claims.

A limit on showing, stated in no forbidden word: "films show Lumen itself; the assistant part stays unnamed".

## Concept: benchmark line

Good *learn*: "Reference, 13.2–14.4 s: a counter runs to $100K, most of the way in 6 frames, then 0.5 s of rest." Bad: "dynamic editing".

## Concept: ideas that are not ideas

- *No subject, no turn.* "A smooth fly-through of the Lumen interface, a glowing graph of connections, text: 'All your contacts in one place'." The graph fits any CRM; the line is generic.
- *Chosen for its asset.* A roastery film built so an existing pour render had a place: the pour is beautiful and connected to nothing. Remove the shot and the film loses no meaning.
- *A line, not a picture.* "Your AI is one day old. You have years." Strong contrast, but copy. A picture: an empty window with a blinking cursor, beneath it a shaft of years of messages. Now the line can be cut.
- *"Different" that is not.* "Person page full screen" / "Goal map full screen" / "Connections full screen": three features in one window; the wording differs, the picture does not.
- *Tally, good.* Picture: a city street at night, every bike chained, one bike with no chain at all and its owner walking away without looking back. Turn: a thief's hand touches it and the bike chirps once; everything else on the street stops. Last frame: the same owner, morning, the bike where they left it.

## Ideas: the field guide for a team

Each idea in `pipeline/concepts/<team>.json` carries:

- **Picture** (`coreImage`): one sentence of what we see. No product name, no benefit verb.
- **Hook frame** (`openingFrame`): the first frame, what fills it, where the eye lands, how it executes the strategy's hook mechanic in 2 s. No logo.
- **Turn** (`turn`): what changes, and what stops for it. **Last frame** (`lastFrame`): the thumbnail and loop frame.
- **What carries** (`carries`): one device across the boundaries.
- **Rules out** (`rulesOut`, at least 3): the temptations this idea refuses.
- **Native move** (`nativeMove`): what only moving picture with sound can do here, without naming an effect.
- **Why watch** (`whyWatch`): why a viewer in the strategy's moment does not scroll past.
- **Risks** (`risks`): truth, production and taste, each named.

Unchecked keys the director reads if present: `meetsNumbers` (median shot, variety, longest still, where it breathes; or that it cannot, advisory in promo), `claimsUsed[]` with status, `implies` (what the picture claims without words, checked against truth like copy), `material[]` with state (exists, needs-capture, missing). `TeamIdeasSchema.parse` drops these keys, but `creative:pool` passes them through unchanged: keep them as fields and do not copy them into `risks`.

The director scores the text, not your intent: an image you meant but did not write scores as absent. A benchmark that only you know ("like that Apple ad") counts for nothing; give its time and numbers.

## Ideas: one team, four ideas that differ

The provocation team, for the fictional Tally lock:

1. A street of chained bikes; one bike with no chain; its owner walks off without looking back.
2. A thief's training montage, every lock defeated, until the last bike chirps once.
3. A lost-property office full of chains nobody came back for.
4. An insurance form filling itself in, line by line, then deleting itself.

Four worlds, four scales, four ways of moving. Four shots of the same street at different times of day would be one idea.

## Ideas: the file, valid as written

`pipeline/concepts/<team>.json` (`TeamIdeasSchema`): `team` is your stance id, `round` the dispatch's round, four to six ideas. Required per idea: `id`, `title`, `premise`, `coreImage`, `openingFrame`, `whyWatch`; `risks` and `referenceIds` (ids like `ref-city-night`, or `[]`) default to empty; the rest are optional strings or string arrays. The same four ideas:

```json
{
  "schemaVersion": 1,
  "team": "provocation",
  "round": 1,
  "ideas": [
    {
      "id": "street",
      "title": "The unchained bike",
      "premise": "In a street of chained bikes, one stands free and is still there in the morning.",
      "coreImage": "A night street of chained bikes; one has no chain; its owner walks off without looking back.",
      "openingFrame": "Wide street, chains catching the light; the bare frame of one bike at centre. Question in 2 s: why is it not locked?",
      "whyWatch": "A commuter who lost a bike sees the thing they would never do.",
      "risks": ["truth: the chirp must be a working alert", "production: street from blender-plate, no filmed plate", "taste: night street can read as stock"],
      "referenceIds": ["ref-city-night"],
      "turn": "A hand touches the free bike; it chirps once; the street goes still.",
      "lastFrame": "Morning, same street, the bike where it was left.",
      "carries": "The owner's back, leaving and returning.",
      "rulesOut": ["a lock close-up", "a phone alert screen", "a thief's face"],
      "nativeMove": "Silence until the chirp; the cut lands on it."
    },
    {"id": "montage", "title": "Training montage", "premise": "A thief defeats every lock in a montage until one bike answers.", "coreImage": "Bolt cutters through lock after lock, faster each time, until one bike chirps.", "openingFrame": "Cutters closing on a chain, full frame, 6 frames.", "whyWatch": "The rhythm promises a pattern and breaks it.", "risks": ["production: needs hands; drawable only as silhouettes from a library block"], "referenceIds": [], "turn": "The chirp stops the montage mid-cut.", "lastFrame": "Cutters frozen, open, on an untouched frame.", "carries": "The cut rhythm.", "rulesOut": ["a crime-drama grade", "a crowd", "slow motion"], "nativeMove": "The edit itself speeds up and stops."},
    {"id": "lost-property", "title": "Unclaimed chains", "premise": "A lost-property shelf of chains nobody came back for.", "coreImage": "Shelves of cut chains with paper tags, one empty slot.", "openingFrame": "Slow push along tags dated years back.", "whyWatch": "Every viewer who lost a bike owns one of these tags.", "risks": ["truth: implies theft numbers; use none"], "referenceIds": [], "turn": "The empty slot: its tag reads 'returned'.", "lastFrame": "The empty slot, tag in focus.", "carries": "The tags.", "rulesOut": ["statistics", "a narrator", "the product in the first half"], "nativeMove": "A camera move that reads tags like a list."},
    {"id": "form", "title": "The form that deletes itself", "premise": "A theft report fills itself in, then erases itself.", "coreImage": "An insurance form typing itself, line by line, then deleting back to blank.", "openingFrame": "Cursor in the field 'date stolen'.", "whyWatch": "The viewer knows the form and dreads it.", "risks": ["production: a form and a caret, each found with library:list or not drawable"], "referenceIds": [], "turn": "The backspace starts on its own.", "lastFrame": "A blank form, cursor blinking.", "carries": "The cursor.", "rulesOut": ["a lock shown", "a price", "an alert screen"], "nativeMove": "Type and erase timed to the beat."}
  ]
}
```

## Clichés, stimulus and subversion in the team file

With a category scan in the brief, the same file adds:

```json
"killedObvious": ["lock close-up on a gradient", "thief caught on a doorbell camera", "phone alert: 'your bike moved'", "owner relieved, then smiling", "city map with a pulsing dot", "before/after: cut chain vs intact lock", "stat card: bikes stolen per minute", "rider testimonial to camera", "logo on the lock, whoosh", "countdown to launch day"]
```

Per idea, where they apply: `"stimulus": {"method": "triz", "seed": "r3", "prompt": "Contradiction: the film must show the product working, but must not look like a demo. Separate in scale: …"}` and `"subverts": {"cliche": "phone alert: 'your bike moved'", "how": "the alert arrives on the thief's phone, not the owner's"}`.

## Proof in the hook or the turn

Strategy proof: "the lock's tamper log, timestamped to the second". Weak: the street film ends on the log as an end card. Good: the turn is the log itself, a line appearing at 02:14:07 while the owner sleeps, and the camera pulls back from it to the empty street. `"proofFrame": {"proof": "tamper log, timestamped to the second", "where": "turn"}`. A watchman could chase a thief; he could not write that line.

## Swap test: name the frame

Bad: "Only Tally could make this." Good: "Done by hand, the owner checks the bike from a window; a U-lock just holds. Neither produces the turn: a bike that answers a touch with one chirp while the street goes still." No frame that only this product produces: not an idea.

## Truth: sources and notes

`sources` holds the paths exactly as `product-sources.json` lists them, strings only. Notes go beside them:

```json
"sources": ["docs/PRODUCT.md", "docs/STATUS.md"],
"sourceNotes": [
  { "path": "docs/PRODUCT.md", "role": "what ships today", "readToEnd": true },
  { "path": "docs/STATUS.md", "role": "statuses by feature", "readToEnd": false, "note": "§7–9 server only, not read" }
]
```

## Concept: presenting the top three (creative-director)

`concept.md`, in the user's language, readable in two minutes: per idea, the picture, the hook frame, the turn, the last frame, the board, and the director's argument against it. Say which ideas need material that does not exist yet before the user chooses. Recommend the first, and say under which brief you would make each of the other two.
