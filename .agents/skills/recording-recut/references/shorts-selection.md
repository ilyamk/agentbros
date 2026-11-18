# Shorts selection from a long recording

The agent proposes clips and scores them on evidence; code checks the evidence, computes the score and picks. A human approves. Nothing here calls a model or a paid API.

## Steps

1. `pnpm shorts:prepare --transcript pipeline/transcript.json --output-dir pipeline/shorts --count 5 --brief "who the shorts are for"`. It writes `chunk-NN.md` (numbered sentences `S0012 [01:23.4–01:27.9] spk1: …`; chunks of 20 minutes overlapping by 60 s), `sentences.json` and `brief.md`, the task with the exact candidate JSON schema. Durations default to `--min-sec 20 --max-sec 60 --hard-max-sec 90`.
2. Read `brief.md` and every chunk, then write the candidates JSON it describes.
3. `pnpm shorts:rank --prepared pipeline/shorts --candidates candidates.json --project <id>`. Read `proposals.md`: proposed, others (below threshold or over count), rejected with reasons, dropped overlaps.
4. A human watches each proposed range. For the clips the user approves, run `pnpm shorts:request --project <id> --selections pipeline/shorts/proposals.json --ids c1,c3 --approved-by "<the user's name>"`: it writes `pipeline/chapters.json` (one whole-timeline chapter and the recut's protected spans) and `pipeline/shorts-series-request.json` with the source pin, checked by the workflow's plan. At least two clips. Then `pnpm video:workflow --scenario shorts-series --action create --request <that file>` ([guide](../../../../docs/workflows/shorts-series.md)). `--approved-by` and `--ids` record the user's own decision: typed by the user, or relayed verbatim from what the user said. Never infer, choose or fill them yourself. Over MCP, `shorts_request` only writes the chapters; approval stays on the CLI.
5. After a human has rated at least 10 ranked clips 1–5 (`{ "version": 1, "ratings": [{ "id": "c1", "rating": 4 }] }`), run `pnpm shorts:calibrate --proposals pipeline/shorts/proposals.json --ratings ratings.json --project <id>`. Later ranks for that project use the stored threshold; changing `--weights` needs a new calibration or an explicit `--threshold`.

`--project` may be the uncut project or its recut: recut clips match by `payload.sourceHash`, and a clip may cross the recut's cuts (pauses, fillers, retakes) as long as no cut removes a word your quotes cite; the proposal lists the cuts it crosses. Without `--project`, rank works in source seconds only and writes no `ShortSelection` drafts.

## Scoring

Score each axis 0–10, and quote the words that justify it verbatim from one sentence inside the range (`sentence` is its number). Do not give a total, rank or overall score: the schema rejects it.

| Axis | Default weight | 10 means |
|---|---|---|
| `hook` | 3 | the first 3 s stop the scroll: a question, a surprising claim, a conflict, a number. Quote from `hookSentence`, which must start within 3 s of the clip start |
| `standalone` | 2 | makes sense alone: no "he", "that", "as I said", "этот", "как я говорил" pointing outside the range |
| `emotion` | 1 | a clear peak of feeling, humour, tension or surprise |
| `payoff` | 2 | ends on the point, punchline or answer. Quote from one of the last two sentences |
| `value` | 1.5 | the viewer learns or gets something useful |
| `relevance` | 1 | fits the brief or a current trend |

The score is the weighted mean × 10 (0–100). The default threshold is 60 until a calibration exists. Vetoes reject a clip whatever its score: `needsSetup`, `endsBeforePayoff`, `claimOutOfContext`.

What code checks: quotes match after Unicode, case, quote-mark, dash and whitespace normalisation, at least three words or the whole sentence; evidence lies inside the range; the hook's start; duration after snapping; overlap (intersection over the shorter clip; above 50% the lower score goes); with `--project`, that the range is one whole-frame span on one timeline clip and keeps every protected negation, caveat and claim-context span whole. A first sentence that opens with a pronoun or conjunction gets a warning, not a penalty.

## Truth rules

- Whole sentences only, contiguous and in their original order. One range per short: never splice distant sentences into a claim the speaker did not make.
- Keep negations, caveats and qualifiers with the claim they qualify. If the clip only works without them, veto it with `claimOutOfContext`.
- Edges sit at the first and last spoken word, padded 150–300 ms into silence and never into a neighbouring word. With `--speech-mask pipeline/speech-mask.json` (from `speech:local`) an edge also reaches the detected speech when the word times run short, and padding stops at the next detected sound. An edge with less than 100 ms between its word and the neighbouring word is running speech: with a speech mask it moves into a mask silence of at least 100 ms found within 150 ms; otherwise the clip is rejected ("starts in running speech"), never merely demoted, so choose another first or last sentence. A `tight start` or `tight end` warning (under 150 ms of padding) is allowed: check it by ear.

## Length

30–60 s is typical. Under `--min-sec` is rejected. Between `--max-sec` and `--hard-max-sec` (90 s by default) only a story whose payoff needs the length survives, with a payoff score of 8 or more. Longer is always rejected.
