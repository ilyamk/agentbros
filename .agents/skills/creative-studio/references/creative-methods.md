# Creativity methods

Scripted procedures for concept teams. Each takes a seeded stimulus sheet, so a run can be repeated and compared:

```bash
pnpm creative:stimuli --project <id> --method <kill-first-10|zwicky|random-entry|scamper|triz|synectics|all> --seed <s> --count <n>
```

It writes `pipeline/stimuli/<method>-<seed>.json`: `stimuli[] {method, seed, prompt, detail}`. Use the sheet you were given; never reroll a seed to get an easier prompt.

**Citation rule.** Every idea built with a method carries `stimulus: {method, seed, prompt}`, copied from the sheet. An idea with no stimulus is marked `stimulus: null`. The director can then see which method produced what.

## kill-first-10

1. For each of the 10 banned archetypes on the sheet, write the category's own version in one line: the idea anyone in this category would make first.
2. Add any obvious idea of your own that the sheet missed, until you have 10 in total.
3. Ban all of them. Any idea of yours that shares a picture with one is rewritten or dropped.

Output: `banned[]` (10 lines), kept beside your ideas. It is not an idea.

## zwicky (morphological box)

The box has five dimensions: `picture`, `conflict`, `pointOfView`, `timeStructure`, `productRole`. Each has six values. The seed picks one value per dimension; the strategy's audience moment fills the point of view where it fits.

1. Take one combination from the sheet as given. Do not swap a value you dislike.
2. Write the one picture in which all five values hold at once, then the turn.
3. If no true picture exists, change one dimension only, name it, and say why.

Output: one idea per combination, with the combination in `stimulus.prompt`.

## random-entry (de Bono) and PO

1. Random word: list five properties of it (shape, use, sound, what breaks it, where it lives).
2. Carry one property into the film's picture. The word itself need not appear.
3. PO provocation: treat the sheet's PO statement as true for one minute. Write what follows from it, then move to the nearest idea that can be filmed and is true to the product.

Output: an idea naming the property it carries.

## scamper

1. Name the category's own form of the sheet's convention (for example, the product on a clean ground).
2. Apply the sheet's operation to it: substitute, combine, adapt, modify, put to other use, eliminate or reverse.
3. Keep the result only if a viewer who knows the convention would notice it was broken.

Output: an idea naming the convention and the operation.

## triz (contradiction)

1. State the contradiction as "the film must X, but must also be not-X", from the sheet or from the strategy.
2. Resolve it with the separation on the sheet:
   - time: X in one part of the film, not-X in another, with the frame where it flips;
   - space: X in one part of the frame, not-X in the other;
   - scale: X up close, not-X from far away.
3. Compromise ("a bit of X") is not a resolution.

Output: an idea naming the contradiction, the separation and the flip frame.

## synectics (direct analogy)

1. Ask how the remote domain on the sheet solves the problem the product solves.
2. Find the one object or gesture in that domain that carries the solution.
3. Film that object or gesture, then let the product appear at the turn, as the thing the analogy was about.

A shallow analogy counts as a failure: one any product could use, such as a key or a bridge.

Output: an idea naming the domain and the object or gesture.

## In a concept team, with a category scan

When the brief lists the scan's clichés:

1. Run kill-first-10 with the clichés counted among the 10, and write them as `killedObvious` at the top of the team file.
2. Build at least two ideas from the assigned method's sheet, each with its `stimulus`.
3. Hold every idea against each cliché. A match is refused unless the idea subverts it in the picture, as stated in `subverts {cliche, how}`.
   - A subversion: the "counter of saved hours" counts down to a missed train.
   - Not a subversion: the same counter in a new colour.

## After any method

Run the team's usual tests: the swap test, the mute test, truth, and material. A method gives an idea a starting point; it does not make the idea good.
