# strategist: worked examples

Products here are invented. "Tally" is a fictional smart bike lock; "Lumen" a fictional note-taking app.

## Proposition

| Bad | Why | Good |
|---|---|---|
| "Tally is smart, secure and stylish" | Three claims; any lock says it | "Leave your bike anywhere: Tally tells you before a thief has finished" |
| "Lumen helps you remember" | Swap in any notes app and it holds | "Every quote from every person, the moment you need it, without searching" |
| "The best AI notes app" | Unverifiable, and a claim the truth cannot mark working | Use a working claim, said as a consequence for the viewer |

## Audience and moment

Bad: "urban cyclists, 25-40". Good: "a commuter locking up outside a station at 08:10, already late, who has lost a bike before". The moment decides the hook: they give the feed half a second, sound off.

## Hook mechanic

Name the mechanism, not the content. "Result first: the stolen bike is shown before the lock" is a mechanic; "a cool bike shot" is content. With sound off, the mechanic must be legible in picture alone.

## Success criteria

Good: "a viewer who saw it on mute can say what Tally does"; "the hook frame asks a question within 2 s"; "median shot within the reference's range". Bad: "goes viral", "increases sales" (not measurable from the film).

## A QA line the brief overrides

The secondary type's QA says "interface shown from real captures"; the brief allows only synthetic interface content. Bad: leave it, and the QA step fails a film the brief demanded. Good:

```json
"waivers": [{ "rule": "interface shown from real captures", "reason": "brief.json limits: synthetic interface only, no real customer data; the interface is rebuilt from library blocks with the product's own wording" }]
```

## Strongest alternative and product-only proofs

Bad: `strongestAlternative: "other locks"`; a proof "sends you an alert", which a neighbour with a phone also does. Good:

```json
"strongestAlternative": { "name": "a neighbour who watches the bike from a window", "whyConsidered": "free, already there, and on screen looks the same as a phone alert" },
"productOnlyProofs": [
  { "proof": "tamper log, timestamped to the second", "claim": "Logs every tamper attempt with time and force", "looksLike": "a list of lines in the app, one turning red at 02:14:07" },
  { "proof": "the lock tightens itself after a cut attempt", "claim": "Re-locks automatically after a forced attempt", "looksLike": "the shackle snapping shut, close up, after a cutter slips" }
]
```

The `claim` is copied word for word from a `working` claim in the truth.
