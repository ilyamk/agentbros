# Film style cards

Last updated: 2026-11-20

A style card defines how a film uses material, type, camera, motion and sound. The playbook owns the viewer's task and the production route. The brief and concept own the story, performance, sequence and signature moment.

## First collection

| Card | Use |
|---|---|
| Paper Signal | Technology launches, feature proof and typographic explanations |
| Pale Tint App | Crisp product screens against quiet environmental colour |
| Warm Editorial | Patient teaching and sourced explanations |
| Editorial Paper | Quotations, case studies and visual arguments |
| Keynote Dark | Deliberate reveals and spatial product lighting |
| Luxury Serif | Premium objects and material detail |
| Brutalist Mono | Hard-edged technical and editorial typography |
| Playful Pop | Elastic social motion with legible captions |
| Product UI Walkthrough | Real controls, voice-led camera and reading holds |
| Archive Evidence | Original documents, attribution and contextual framing |
| Physical Data | Countable units with a fixed scale and explicit legend |
| Tactile Paper Motion | Layers, fibres and hand-led assembly |

## Choose a style

```sh
pnpm film:style --action list --playbook <playbook>
pnpm film:style --action show --style <id>@<revision>
pnpm film:style --action use --project <id> --style <id>@<revision>
pnpm next --project <id>
```

Use a card with a bespoke film before `look` starts. For a new film, `film:init --style <id>@<revision>` pins it during creation. Playbook filters recommend a fit, and the author may choose another card. A plain style ID selects the latest catalogue revision at that moment. The project's `pipeline/film-style.json` pins the card, its library preset values and their hash. `film:style --action status --project <id>` shows the pinned values. To compare styles after the look starts, create two projects from the same brief. The ordinary flow is available by starting without a selection.

For a recipe add `"styleCard":"<id>@<revision>"` to the request. It applies the pinned palette during materialisation. The recipe's narrative beats, chosen scene templates, caption profile and durations retain their roles. The recipe metadata records the exact card revision, and the render receipt binds the pinned card file. The next render and editorial QA steps receive the build and critique rules respectively.

For campaign film members use `adapter.styleCard`. For campaign recipe members use `adapter.request.styleCard`. Campaign plans require an exact revision for either option.

Physical Data recipes can choose `scene.physical-data` on a beat. It uses the project's palette and the same exact-count block as the library. Set sourced integer `from` and `to` values, the cadence in frames and a visible `unitLabel`. The recipe checks that the final count settles before its transition. Set `selfContained: true` on a beat with an explicitly selected typography or data template when its own graphics supply the picture. The Paper Signal pilot places emphasis on the author’s chosen word through `text.word-reveal` and `accentWordIndex`.

## What reaches each role

| Step | Guidance |
|---|---|
| Look | Materials and hierarchy, one preset reference, and decisions the author can vary |
| Beat sheet | Motion, camera or an idea for a medium-specific gesture |
| Build | Practical methods, suggested library blocks and engines |
| Sound | Motifs, material sounds and restraint |
| Look and final critique | Applicable quality criteria |

Each step receives at most three short rules. Agents can look up the exact preset values on demand. Broad search and optional references remain available at the existing discovery and reference steps. Style cards with approved reference images can still be paired with a project `style` entity through [the entity reference workflow](entity-workflow.md). Entity approval is handled by its owning workflow.

## Evolve and test a card

Author original cards in [the style catalogue](../design-reference/style-cards/catalogue.json). Give changed production guidance a new revision. Choose one maintained library preset as a starting point, restrict suggestions to registered blocks, and keep the film's story and project decisions open. Cite sources that supplied techniques or material.

Start with two different briefs for the same card. Use a version with the existing preset and instructions as a control, and a version with the pinned style card as the candidate. Keep the product facts, source media, model and recipe or playbook fixed within each pair. Compare the same scene across two card versions when assessing a style revision. Review the intended material, legibility, camera, sound and fitness to the script at full size and phone scale. Evaluate the original concept and signature moment separately. The standard reading, originality and final delivery checks still apply. Render evidence and human editorial judgement establish different parts of the result.


Run the production-renderer pilot with two synthetic briefs per card for Paper Signal and Physical Data.

```sh
RUN_RENDER_TESTS=1 FILM_STYLE_ARTIFACTS="$PWD/out/qa/style-pilot" pnpm exec tsx --test tests/film-styles-browser.test.ts
```

The pilot renders both treatments at the same frame range in landscape and portrait. It checks source binding, resolution, frame count and distinct picture hashes. It keeps the renders and stills for editorial comparison.
