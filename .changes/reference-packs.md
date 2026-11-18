---
category: command
bump: minor
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Reference packs (RFC 0003) prepare the images, videos and audio a generation model receives instead of leaving them to hand-written prompts. `pnpm refs:plan` drafts each generated shot's reference inputs from approved entity cards and the target model's reference profile (`pnpm refs:profiles`), and checks them against that model's slots, limits and real-face policy; `pnpm entity:card --action coverage` reports which views a card still lacks. When an input is outside a model's limits, the plan proposes a reproducible derivative (trim, crop, scale, snap, frame extraction, flatten, audio trim and more) that `pnpm refs:derive` makes with a receipt, locally or through a durable paid job. `pnpm refs:pack` compiles an immutable pack with the model's own markers, a board for review, the user's rights and approval, and the exact request; `generate:model` verifies a bound pack and warns when reference fields are sent without one (`AGENTBROS_REFERENCE_PACKS=enforce` refuses them). The film chain's material step now requires planned references before approval and approved packs after it, and three new instruction benchmark tasks check that agents plan references, prefer derivatives and never type markers by hand.
