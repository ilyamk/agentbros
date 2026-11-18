# Creative rubric v1 (frozen)

The creative-director scores the pooled ideas and the script variants with this rubric, and nothing else. It is frozen: a benchmark is scored with it, so a change is a new version (`RUBRIC_VERSION` in `src/lib/film/creative-rubric.ts`), never an edit. `tests/creative-rubric.test.ts` pins this file's hash.

Every axis is an integer 1–5. Start each at 2 and argue it up with what is written in the idea; a word you had to imagine does not count. Score what the text makes you see, not what a good team could make of it.

## Idea rubric (step `idea-review`)

### picture: picture strength

1. No picture: a benefit, a slogan or a feature list.
2. A picture any product could own: a screen, a glowing graph, a person smiling at a phone.
3. A concrete picture with a subject, but it illustrates the line instead of carrying the film.
4. One image a viewer would retell in a sentence, with a subject and a turn.
5. An image that is the argument: remove the words and the film still says the proposition.

### hook: the first 2 seconds

1. Frame 0 is a logo, a title card or empty space.
2. Frame 0 is a finished composition that asks nothing.
3. A clear question or tension, explained by words rather than the picture.
4. The picture alone sets a question within 2 s, with sound-off legibility when the strategy says sound off.
5. The strategy's hook mechanic, executed so that leaving at 2 s feels like losing something.

### distinctiveness: the swap-the-product test

1. Swap in any rival named in `alternatives` and nothing breaks.
2. Swap breaks only the logo and the copy.
3. Swap breaks one frame.
4. Swap breaks the turn: the idea depends on what only this product does.
5. Swap breaks every frame: the world is built from this product's truth.

### truth: claims against product truth

1. Shows or implies a capability marked `horizon` or `unverified` as available.
2. Leans on an `in-development` claim as if it shipped.
3. A non-working claim is present but can be cut without losing the idea.
4. Every claim and every implied claim is `working`; limits on showing are respected.
5. As 4, and the idea dramatises the product's own limits honestly (what it does not do is part of the film).

### feasibility: with the library and the material

1. Needs footage, actors or generation that the brief rules out, with no route.
2. Needs material in state `missing` and a paid route nobody authorised.
3. Buildable, but the core image needs custom code or material in state `needs-capture`.
4. Core image and turn map to library blocks or material that `exists`; the rest is ordinary build work.
5. As 4, and the idea uses what is already strong in the library or the material (a real UI capture, a 3D plate) as its centre.

### ambition: against the reference and the targets

1. Pace and density far below the targets, and the idea cannot reach them.
2. Reaches the targets only by adding shots that mean nothing.
3. Meets the targets as written, with no moment the reference would envy.
4. Meets the targets and has one moment that stands next to the reference's best.
5. Sets a new bar for the reference on one named dimension (a turn, a transition, a silence) without missing the others.

### native: native to moving picture with sound

1. Would work as a poster or a slide.
2. Motion decorates; sound is a bed.
3. One move needs time (a reveal, a reversal) but sound plays no part.
4. The turn needs motion and a sound event together.
5. The idea is a sound-and-picture event: on mute or as stills it is a different, weaker idea.

## Script rubric (step `script-review`)

### hookLine: the first line or the first silence

1. The opening line names the product or a benefit.
2. A generic question or statistic.
3. A line that fits the picture but repeats it.
4. A line, or a deliberate silence, that turns the opening frame into a question.
5. As 4, and the hook line is the shortest possible: removing a word breaks it.

### truth: claims against product truth

Same anchors as the idea rubric's truth axis, applied to every line and every `claim`.

### reading: words per screen

Measured first: `creative:pool` checks every beat's on-screen `read` copy against `plan:check`'s reading floor (0.8 s for 2 words or fewer, 0.3 s a word above, Cyrillic × 1.25, plus about 0.3 s of entrance). Any overrun caps this axis at 2, whatever is written.

1. Most screens cannot be read at playback speed.
2. One or more screens overrun the floor.
3. Every screen meets the floor, with words that repeat the picture.
4. Every screen meets the floor and at least one beat is rightly wordless.
5. As 4, and the density follows the music: fewer words in dense sections, none under a drop.

### musicFit: fit to the music's sections

1. Beats ignore the audio map.
2. Beats map to sections, but the turn lands nowhere in particular.
3. The turn sits on a key moment or after a silence.
4. As 3, and speech or reading sits in low-density sections.
5. As 4, and the last line or last silence lands on the music's ending.

### oneMessage: one message

1. Several messages compete.
2. One message with a second claim tacked on.
3. One message, said twice in different words.
4. One message, said once, and every other line serves it.
5. One message the viewer can repeat without having read a word, because the picture said it.

## Threshold

An item **passes** when every axis is 3 or more, `truth` is 4 or more, and the mean of its axes is 3.6 or more.

A round **passes** when at least one item passes. Otherwise it goes back to the teams (ideas) or the writers (scripts) with the director's `notes`, at most twice; after the third round the user decides. The user never sees a round that has not passed unless the round limit sent it to them.

## Pairwise comparison, in both orders

1. Rank every item by mean, then by its lowest axis, then by pool order.
2. Take the top 6 (or all, when fewer). For every pair, judge twice: once with A shown first, once with B shown first. Write each judgement as `{first, second, winner}`, where `winner` is either id or `tie`.
3. A pair counts only when both orders name the same winner. A pair whose orders disagree is position bias and is dropped, not averaged.
4. Within the top 6, order by agreed wins minus agreed losses, then by mean. The rest keep their mean order. Then every passing item moves ahead of every item that does not pass, keeping that order.
5. The top 3 go to the user (ideas); the winner becomes the script and the runner-up is shown as its alternative (scripts).

`creative:rank` does steps 1, 3 and 4 and computes the verdict. The director writes scores, notes, pairs and an argument against each of the top 3; it never writes the ranking or the verdict by hand.

## What the director reads

The pool (anonymised and shuffled by `creative:pool`), the strategy, the brief, the product truth, the targets, this rubric and `design-reference/creative-lessons.md`. A lesson moves a score only when it names a rubric axis; cite it in that axis's note.
