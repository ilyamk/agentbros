# Style apart from content

Tiers and dates: [legend](../SKILL.md#references). Profile limits: `pnpm refs:profiles --action show --family F`.

## Prepare

- A style board (`style-board`) that shows the look only: palette, texture, grain, light quality, line. It never contains the hero, the product or the location of the film.
- A palette swatch (`palette`) when colour is the point; colours also as hex in the style card's `fixedSentence`.
- Identity, product and location references without a strong style of their own: neutral light and background, so the style comes from one place.
- A role sentence that limits the board: "the look only: palette, texture and light, not its subjects".
- One style per shot. Two style references with different looks blend into neither.

## Specs and sources

- Most models separate style from content only by role sentences in the prompt, for example "subject from image 1, style from image 2, background from image 3" — [O] [BFL FLUX.2 prompting guide](https://docs.eu.bfl.ai/guides/prompting_guide_flux2), checked 2026-11-17. In a pack the compiler writes those bindings from each attachment's `roleSentence`; you never type the image numbers.
- One role per asset; keep the set small and coherent rather than filling every slot — [O] [Dreamina reference inputs FAQ](https://dreamina.capcut.com/ai-video/ai-video-reference-inputs-faq), checked 2026-11-17.
- Midjourney separates them by parameter: `--sref` for style and `--oref` with `--ow` from 1 to 1000 for identity (V7) — [O] [Midjourney docs](https://docs.midjourney.com/hc/en-us/articles/36285124473997), checked 2026-11-17. No Midjourney profile exists here, so it cannot be packed.
- References from the same scene entangle identity with lighting and background — [P] [Phantom-Data, arXiv 2506.18851](https://arxiv.org/html/2506.18851v1), checked 2026-11-17.

## In our system

| Need | Card view role | Requirement role | Derivative |
|---|---|---|---|
| The look | `style-board` on a style card | `style` | `contact-sheet` to make one board from several frames |
| Colour | `palette` | `style` | none |

- Coverage warns on `styleWithoutSubject`; declare `styleNeutral: false` on an identity view that carries a strong look, so the conflict shows on the board.
- `refs:plan` draft attaches a style board as an optional requirement, dropped first when the profile's slots are full.

## Failure modes

- A style image containing the hero: the hero's pose, framing or face is copied from the style board.
- Identity references in a strong style: style and identity cannot be separated; the subject changes when the style changes.
- Naming a living artist, film or brand to get a look: forbidden by the playbooks; describe the look and attach a board you may use.
