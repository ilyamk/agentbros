# Products and objects: packshots and labels

Tiers and dates: [legend](../SKILL.md#references). Profile limits: `pnpm refs:profiles --action show --family F`. Real products come from the user's own photos or a real capture, never invented (root rules on product interfaces apply to screens).

## Prepare

- A front packshot (`packshot-front`) under soft, even light, with no specular highlight crossing the label or text.
- A three-quarter packshot and a label close-up (`packshot-three-quarter`, `label-detail`) when the shot turns the object or reads its text.
- Colours as hex values per component in the card's `fixedSentence` (body, cap, label ground, logo).
- A neutral or flattened background. Transparent cut-outs are flattened onto a neutral colour unless the profile's slot states alpha handling.
- A plan to composite the approved logo, legal text and any small type in the edit, over the generated shot.

## Specs and sources

- FLUX.2: quote exact text with its font and placement; there are no negative prompts, and earlier words weigh more — [O] [BFL FLUX.2 prompting guide](https://docs.eu.bfl.ai/guides/prompting_guide_flux2), checked 2026-11-17.
- The FLUX.2 edit profile takes 1–4 images — [3P] [fal FLUX.2 edit API](https://fal.ai/models/fal-ai/flux-2/edit/api), checked 2026-11-17.
- More angles do not reliably fix label drift; composite the approved logo or legal text in post ([3P], RFC 0003 §3.3; the flux-2 profile's guidance).
- GPT-image `input_fidelity: "high"` is aimed at faces and logos ([3P], RFC 0003 §3.3, no source link recorded). No GPT-image profile exists here, so it cannot be packed.
- No video model documents alpha in reference inputs — [U] RFC 0003 §3.3. Flatten unless the slot says `alpha: supported`.

## In our system

| Need | Card view role | Requirement role | Derivative |
|---|---|---|---|
| Shape and label | `packshot-front`, `packshot-three-quarter`, `packshot-back` | `product` (or `prop` for a held object) | `cutout` then `flatten` with a neutral hex |
| Readable text | `label-detail` | `product` | `crop`; the text itself is composited in the edit |
| Colours | `palette` | `style` only when it is a brand palette board | none |

- Declare `facts`: `background`, `lighting`. Coverage warns on `background:neutral` and `lighting:even`.
- `refs:plan` draft attaches the first of `packshot-front`, `packshot-three-quarter`, `label-detail` as required and the others as optional views, within the profile's slots.
- The `refs:pack` board warns when an attachment has transparency and its slot does not state alpha handling; add a `flatten` derivative.

## Failure modes

- Label text invented or misspelt by the model: never accept it; composite the real label.
- A highlight across the label in the packshot: the model reproduces the glare or loses the text.
- The product shown from an unseen side (an orbit to the back): the model invents the back. Plan the move to stay on the photographed sides, or add `packshot-back`.
- An abstract shape standing in for the product: not acceptable (root design principles).
