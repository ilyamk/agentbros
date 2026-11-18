# Creative teams and script variants

The orchestrator briefs each concept team with `film:brief --step ideas --team <stance>` and each script writer with `film:brief --step script-variants --variant <v>`. The stances and variants are deliberately different starting points, so that the pool is wide before the creative director narrows it. Ids are fixed in `src/types/studio.ts` (`TEAM_STANCES`, `SCRIPT_VARIANTS`); a test keeps this file and the code in step. `strategy.json` `creativeTeams` picks two to four stances; the default is metaphor, product-in-use and provocation.

## Concept teams

**Every stance: a product-only proof in the drama.** When the product's visible output looks the same as a person's (messages, replies, documents), a key frame must show something only the product produces; otherwise the film advertises the category. Each idea therefore puts one of the strategy's `productOnlyProofs` in its hook or its turn, not only in the last frame, and records `proofFrame {proof, where: hook|turn}`, its `proof` copied verbatim from the strategy (the pool waits on a mismatch). The proof must be what the drama turns on: it is the turn's payoff, not a replacement for the hook, which still has to stop the viewer on its own. A settings card bolted on to explain is not a proof, and an idea whose only distinct frame is a static settings screen is weak. Write every idea, titles included, in the brief's language.

**Every stance: platform behaviour is a claim.** An idea that relies on how a platform's interface behaves (status lines, typing indicators, read marks) needs that behaviour as a claim in product truth; otherwise it is unverified, and the truth axis scores it so.

**Every stance, when the brief has "Category conventions and clichés"** (from the discovery scan): first write `killedObvious`, the 10 obvious ideas with the listed clichés among them, and ban them. Then build at least two ideas from the stimulus sheet of the method your brief assigns, each citing `stimulus {method, seed, prompt}`. An idea that matches a cliché stays only if it visibly subverts it, and says how in `subverts {cliche, how}`. Procedures: `creative-methods.md`.

### metaphor

Find one picture from another world that behaves like the product's truth: a lock that is a held breath, a memory that is a pressed flower. The metaphor must be filmable in one frame and must break when another product is swapped in; a metaphor any category could use (a key, a bridge, a lightbulb) is refused. The product appears at the turn, as the thing the metaphor was about.

### product-in-use

The product working, on screen, in a real moment of use, at reading scale: a real UI capture, a real object in a hand. The idea is the moment of use itself, chosen so the turn is something the product does that the viewer did not expect. Never a feature tour: one action, one result, seen whole.

### provocation

Start from what the audience believes and the film contradicts: a claim, a scene or a question that makes them stop, then a turn that the product's truth earns. Provocation is not shock: it must stay true to the product and the strategy's forbidden list, and the turn must resolve it in the film rather than in the caption.

### human-moment

One person in the strategy's audience, at the moment named in the strategy, before and after. The picture is their behaviour, not their face reacting to a screen. The product changes one small concrete thing in that moment; the film is about that thing.

## Script variants

Each variant is written to the same idea, music and audio map; they differ in the hook line and in how many words the film carries.

### a

Image-led and sparse. The hook line is three words or fewer, or a deliberate silence over the opening frame. Most beats are wordless; on-screen copy only where the picture cannot say it. `density: "sparse"`.

### b

Claim-led and medium. The hook line states the strategy's proposition as a tension in one short sentence; each later line is one working claim, said once. `density: "medium"`.

### c

Question-led and denser, within the reading floor. The hook line is a question the audience asks in the strategy's moment; the script answers it across the turn. Words sit in low-density sections of the music and never under a drop. `density: "dense"`.
