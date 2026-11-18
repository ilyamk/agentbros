# Creative standards

The bar every creative agent works to. Read it before writing anything. Curated harness lessons are in [creative-lessons.md](creative-lessons.md), the user's own lessons in their local memory (`pnpm memory --query "<topic>" --type lesson`); the chain is in [production-chain.md](../docs/production-chain.md).

A film is judged in this order: **idea, sound and rhythm, motion, frames, type, polish.** Clean frames and zero sensor findings say nothing about the first five.

## Hard rules

Only these are mandatory. Everything else is a choice you justify from the idea and the reference.

- Budget, rights, true claims, requested formats. A claim shows as available only if the product source says so.
- Determinism: every value is a pure function of the frame.
- The user decides the music route. Nobody picks it for them, and silence is their decision too.
- The maker never grades their own film.

## What a strong film has

**An idea made of a picture.** One sentence about what we see, not about the product. It rules things out. If it would fit another product with the name swapped, it isn't an idea. Three candidates must differ in the picture, not in the wording.

**A reference with numbers.** Before the concept, know how the reference moves: median shot, variety, how much is still, how it uses silence. Say what to learn from it and what not to take.

**Sound first.** Music and sound shape the edit, so they're chosen before script and cuts. Every visible action has a sound of the right material. Plan at least one real silence, usually before the turn; the first sound after it is one of the most important in the film. Fewer sounds than events: a beep on every event is cheap.

**A rhythm that changes.** Shot lengths differ by at least four times. One clear acceleration and one breath. A film at one even speed has failed, at any speed. When the music has no reliable grid, cut on phrases and energy, not an imposed beat.

**Something that carries each boundary.** Name what survives every cut and moves on: an object, a shape, a camera move, a sound. If nothing survives, it's a slide change. A hard cut is fine when it means something, and in bursts.

**Motion with cause.** Things move because something caused them: a hand, a collision, a beat. Landing, then an accelerating exit. In a kinetic film nothing important sits dead for long; a stop is an event and is planned. Use a stop only where it's the loudest thing in the film.

**Frames with layers.** A frame is rarely one element on a flat fill. Depth comes from foreground and background, a small persistent detail, light, texture and real material. The subject fills the frame in feature beats: no small card in a large field.

**Type that acts.** Words are performers: they stretch, slam, bend, change weight, get hit by the sound. Treatments vary with meaning. Fast in, then hold long enough to read. If pace forces text off early, use fewer words.

**Real material.** Show the real product: real interface, real output, real footage. A CSS rectangle standing in for a physical object looks like one.

**One signature move.** A moment only this medium can do, at the emotional peak. Viewers describe it afterwards without naming an effect.

## Build from the library

Search `pnpm library:list --query "<what>"` before writing a component, look at the preview, import from `importPath`. Wrap the film in `FilmFinish` by default. Write a custom component only when nothing fits, and propose it for the library. Numbers (holds, easing, type sizes, safe areas) live in `design-reference/craft-rules.md`.

## Blacklist

Reject on sight, in any language:

- Copy that fits anything: «меньше шума, больше ясности», «всё в одном месте», «новый уровень», «будущее уже здесь», «просто и удобно», "streamline your workflow", "unlock the power of".
- A hook picked from a table by tone. A hook comes from the material.
- A big word centred on a flat fill, repeated. One line of text fading or rising over a gradient.
- The same entrance on every text.
- Abstract shapes standing in for a product: blobs, bagels, orbs, particles for "AI".
- A list of effects, each used once, none needed. A brief that mandates techniques produces this.
- An idea chosen because an asset already exists.
- A fade at the end by default. A logo slowly revealed before anything happens.
- A silent film with a "rhythm" on an invented grid.

## Bad and strong

Bad examples are from our own rejected film (`src/motion/showcase`).

| Bad | Why it failed | Strong |
|---|---|---|
| Date on a label ticks over on a flat paper fill for 3 s | One element, no layers, no sound to hit; the idea is told in text | The label is hit, slips, the camera is thrown onto what it was stuck to, and a sound tells us the material before we see it |
| Shelf pan for 6 s with text masked in over a blurred background | Long even move, blur as a way to clear space for text | Short moves between close details, each landing on a beat; words sit in the world, so the shelf itself reads as the sentence |
| ПН, ВТ, СР as cards in sequence | A slide change on every beat; each replaces the last | One object changes through the week, so the days are one continuous action |
| «ЧЕТВЕРГ» held still on orange for 3.5 s | A title card where the turn should be | The turn is the loudest moment: stop the sound, stop the picture, then one sound brings the word in |
| Interface in a floating window on a dark ground for 6.6 s | Small subject, flat, the same zoom repeated | The action fills the frame; the button's press becomes the next scene |
| Stock-looking pour with a line of type beside it | Beautiful and disconnected: the shot exists because it had been rendered | Cut or earn it: the sound of the beans carries in from the previous shot |

Russian copy:

| Bad | Strong | Why |
|---|---|---|
| «Ваш ИИ станет умнее» | «Вашему ИИ один день. У вас — годы.» | A contrast you can picture, true of this product only |
| «Удобный поиск по всем чатам» | Show the person, the quote and the date it was said | Proof beats a claim |
| «Жарят на склад. Не знают, сколько купят.» held over a blur | The same thought shown by a discount sticker landing on a pack | Words shouldn't do what a frame can |

## What to look at

You can't watch at speed or hear. So say what you judged from and what you couldn't, and use every instrument: dense strips at cuts, the frame-difference curve, the audio map, loudness. A contact sheet shows composition and hides motion. Only the user approves quality.

When a problem repeats twice, change the rule or the sensor, not only the film. Record it in the project's `pipeline/spine.md`.
