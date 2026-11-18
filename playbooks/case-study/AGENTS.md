# Customer case study playbook

Last updated: 2026-11-13

Choose it when the user has a recorded interview with a client and wants a case study or testimonial film built as a story: situation, problem, why this product, what changed, numbers, a human moment. A recording cleaned up in its own order is [footage-edit](../footage-edit/AGENTS.md); clips only are [shorts-from-long](../shorts-from-long/AGENTS.md); a creator ad is [ugc-ad](../ugc-ad/AGENTS.md); a product film with no customer is [product-promo](../product-promo/AGENTS.md); teaching how it works is [explainer](../explainer/AGENTS.md).

## Start

```bash
pnpm project:new --project <id>      # source project; interview files in public/projects/<id>/assets/footage/
pnpm footage:next --project <id> --playbook case-study --source <file> --goal recut,captions --speakers 2
pnpm footage:next --project <id>     # repeat, doing what it returns, until the transcript exists; then the paper edit (Method 2)
```

Ask the `intake` questions in `playbook.json` first: release, number sign-off and material connection block the start. Two cameras: add `multicam` and `--cameras <files>`. After the paper edit the route forks (Method 3).

## What good looks like

- **One customer, one problem, one change.** The arc runs hero, pain, why this product, resolution (Vidyard); stakes first, resolution last, one specific problem rather than everything the product does (Wistia).
- **Numbers skeptics cannot wave away**: a figure with its period and baseline, prepared with the client before the shoot (Wistia), every one signed off by the client.
- **The customer's words, in context.** An edit may shorten, never shift meaning: an endorsement "may not be presented out of context or reworded so as to distort" the endorser's experience (16 CFR 255.1(b)).
- **A human moment**: one beat where the person, not the metric, carries the film (Vidyard: put a face on the story).
- **Proof on screen**: B-roll of the product in use and the real product screens, not stand-ins ([real-ui](../../docs/real-ui.md)).
- Length: 60 s to 3 min master, cut-downs 15-45 s (house rule, starting point).

## Method

1. **Release, sign-off, connection.** Put the three blocking intake questions to the user in one message. The release goes into the recording-edit request's `source.rights` (`licence` naming the signed release, `commercialAllowed`). Write the client's approved numbers, with period, baseline and source, into the paper edit (step 2). A result the client says is not typical needs the generally expected result next to it (16 CFR 255.2(b)); a discount, free period or payment is disclosed on screen (255.5). The agent never records an approval itself.
2. **Paper edit from the transcript.** After `footage:next` produces the transcript (Scribe with `--speakers` for interviewer and guest; `speech:local` is free but not verbatim), the `footage-editor` agent writes `pipeline/craft/editorial-storytelling.json` per the `editorial-storytelling` skill: each select with its source range, the word ids it quotes, its story beat (situation, problem, why us, change, number, human moment, close) and whether it stays in recording order. It reads the whole transcript first and marks every quotable answer, then orders the beats on paper (the paper edit), then checks the order as sound alone (radio edit) before any picture (Boruff). A select is a whole answer or a whole sentence; caveats and the question it answers stay attached (protected spans in [recording edit](../../docs/workflows/recording-edit.md)). The client and the user approve the paper edit before step 3.
3. **Cut: two routes, chosen by the paper edit.**
   - **Selects in recording order**: run `recut:plan` (interview pace, `--sentence-pause-ms 400`), then edit the `recut-request.json` it wrote: drop the `keepSpans` of off-story stretches and add one `cuts` entry per stretch with its `reason`, each covering whole protected groups; `pnpm video:workflow --scenario recording-edit --action plan --request <file>` validates it and prints the new hash (unverified on a real interview); the user adds the review; then `--action create`.
   - **Selects reordered** (the problem told before the background, the number moved to the end): the reviewed recording edit refuses it (keep spans must be chronological). Use the `talking-head` film route: `film:init --type talking-head --playbook case-study --product <path>`, then `pnpm next --project <id>`. `TalkingHeadVideo` plays any source range by `startSec`/`endSec`, so the motion-engineer builds each select as a scene in the paper edit's order. Joins are the film's own audio edit: listen-check them as below.
4. **Cover the joins.** Multicam angle changes (`multicam:sync`, `multicam:angles`); B-roll of the product in use on the word it illustrates (`media:broll`, [analysis and B-roll](../../.agents/skills/recording-recut/references/analysis-and-broll.md)); real screens recorded with `capture:app` or per [real-ui](../../docs/real-ui.md), imported with `asset:import`.
5. **Lower thirds and numbers.** On the film route (step 3, second branch) the motion-engineer composes number callouts from `type-odometer-stat` or `type-number-race` (one figure), `before-after-split` (a metric before and after) and `scene-stat-moment` (the payoff card), picked with the `motion-library` skill; the lower third is `type-lower-third` (name, role, company exactly as the client approved). Hold each number long enough to read. On the footage route lay typography and data blocks over the recut with `timeline:edit` `add-overlay`, dry run first, ground `transparent` ([overlays](../../docs/timeline-edit.md)).
6. **Captions.** `clean-sentence` or `line-box` (footage-edit step 6); `captions:place` after any reframe; for LinkedIn and YouTube also an SRT from `captions:export`.
7. **Sound and review.** Agents cannot hear: give the user a `render --frames` excerpt around the densest joins. The client approves the final cut and every number in it before delivery.
8. **Cut-downs** go through [shorts-from-long](../shorts-from-long/AGENTS.md) on the source project (`shorts:rank` rejects spans reordered on a timeline), with the same release and sign-off.
9. **Deliver**: render each format, then `delivery` snapshot and check ([delivery](../../docs/delivery.md)).

## Tools

| Tool | Why here |
|---|---|
| `footage:next`, `transcribe`, `speech:local` | Transcript with speakers: the paper edit is written on it |
| Skill `editorial-storytelling` | The paper edit artefact: selects, beats, source ranges |
| `video:workflow --scenario recording-edit` | Reviewed, meaning-protected cut of selects in recording order |
| `recut:plan` | Pause, filler and retake cuts inside the selects |
| `film:init --type talking-head`, `next` | Selects in story order, with overlays |
| Blocks `type-odometer-stat`, `type-number-race`, `before-after-split`, `scene-stat-moment` | Number callouts |
| `multicam:sync`, `multicam:angles`, `media:broll`, `capture:app`, `asset:import` | Angles, B-roll, real product screens |
| `captions:place`, `captions:export`, `timeline:edit` | Captions and SRT sidecars |
| Skill `recording-guide` | When the interview is still to be shot: coverage, room tone, consent |

## Anti-patterns

- Splicing half an answer onto another question so the customer "says" a sentence they never said; a Frankenbite is a distortion under 255.1(b).
- A number the client has not signed off, a number without its period or baseline, a best-case result shown as typical.
- Hiding a discount or payment the customer received.
- A generic dashboard or drawn screen standing in for the product; a generated avatar standing in for the customer.
- Leading with the company history; the problem comes first.
- Reordering clips with `timeline:edit` `move` on a reviewed recut: the IR accepts it, but the joined speech carries crossfades from its old neighbours and the approved edit hash covers the chronological cut.
- Writing any approval or sign-off on the client's behalf; saying the cut sounds good.

## References

- Wistia, video testimonial strategy (stakes then resolution, data before the shoot, one problem, pull quotes): [article](https://wistia.com/learn/production/video-testimonials-and-storytelling)
- Vidyard, How to create highly effective case study videos (hero, problem, solution, resolution; B-roll of the product in use; numbers on screen; practitioner guide): [article](https://www.vidyard.com/?p=292866)
- Todd Boruff, My interview editing process (transcript, selects, paper edit, stringout, radio edit, B-roll; practitioner): [post](https://toddboruff.substack.com/p/my-interview-editing-process)
- 16 CFR 255.1 (honest opinions; not out of context), 255.2 (typical results disclosure), 255.5 (material connections), revised 2023: [255.1](https://www.law.cornell.edu/cfr/text/16/255.1), [255.2](https://www.law.cornell.edu/cfr/text/16/255.2), [255.5](https://www.law.cornell.edu/cfr/text/16/255.5); [FTC FAQ](https://www.ftc.gov/business-guidance/resources/ftcs-endorsement-guides-what-people-are-asking)
- LinkedIn video specs: [help a548372](https://www.linkedin.com/help/linkedin/answer/a548372); captions as SRT on desktop: [help 93997](https://www.linkedin.com/help/linkedin/answer/93997)
- YouTube recommended upload encoding settings: [help 1722171](https://support.google.com/youtube/answer/1722171)

## Done when

- Release recorded in `source.rights`; numbers, typical-result statement and any material connection signed off by the client, not the agent.
- The client and the user approved the paper edit and the final cut; every soundbite was checked against its source context.
- `captions:place` clean; each format rendered fresh; `delivery --action check` passed.

Draft, missing: (1) a reviewed reorder of spans: the recording-edit workflow refuses non-chronological keep spans, and the film route's joins have no join plan or meaning review; (2) a sign-off artefact for the client's numbers and release; (3) a benchmark project.
