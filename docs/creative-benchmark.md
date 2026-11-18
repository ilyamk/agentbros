# Creative benchmark

How to tell whether a change to the creative front (agents, briefs, strategy fields, methods) makes better ideas. Two runs of the same film are compared outside the chain, by fresh judges scoring one blind pool. The command is `pnpm creative:bench`; code in `src/lib/film/bench.ts`.

## Protocol

1. **Freeze the inputs.** Both runs share the brief, the product truth and the targets. They share the strategy too, unless the strategy is what is under test.
2. **Round 1 against round 1.** Later rounds answer a director's notes, so they measure the loop, not the change. A run whose round 1 was not archived (`pipeline/rounds/ideas-1/`) and has moved on cannot be compared.
3. **One merged pool, three fresh judges.** Both runs' ideas go into one pool, shuffled, so each judge scores both runs on one scale in one sitting. Each judge is a new creative-director that has seen neither run.
4. **The judges see the older run's strategy.** The newer run's strategy fields, such as its product-only proofs, stay out of sight, so the ideas are judged as written.

```bash
pnpm creative:bench --action merge --runs <older>,<newer> --kind ideas --seed <seed> --out <dir>
pnpm creative:bench --action brief --project <older> --pool <dir>/pool.json --judges 3
# dispatch one fresh creative-director per <dir>/judge-<n>.md, passing it unchanged
pnpm creative:bench --action analyse --dir <dir>
```

- **merge**
  - Takes each run's round-1 pool: `rounds/ideas-1/pool.json`, else `pools/ideas.json`. A pool past round 1 is refused.
  - Strips whatever tells the judges how an idea was made: the keys `stimulus`, `subverts`, `killedObvious`, `proofFrame`, `method`, `benchmark`, `trizResolution`, `swapTest` and `lifeWithout`, plus any content key only one run has.
  - Drops list entries that start with "swap:" or mention a cliché, "Swap test: …" tails, and sentences that mention a cliché.
  - Reports any method words left in the text (zwicky, scamper, triz, synectics, random entry, kill-first, stimulus, cliché, white space) as `residualMethodWords`. Read them, and rewrite the merge if a judge could tell the runs apart by them.
  - Writes `pool.json` (ids M1…Mn) and a separate `key.json`. It refuses a directory that already holds a pool.
- **brief**
  - Writes `judge-<n>.md` beside the pool. Each is the older run's director brief exactly as it was issued for round 1 (`pipeline/briefs/idea-review-critic.md`), with the merged pool in place of its own.
  - The benchmark's exceptions are appended:
    - write only `judge-<n>.json`, nothing under `public/projects/`;
    - run no rank or done;
    - do not open the key, the authors' files, pools, rounds, stimuli or the category scan;
    - keep the pool's ids;
    - give `swapPasses` and `swapNote` for every item.
  - `swapPasses` is true only if the older strategy's `strongestAlternative` could not produce the film's key frames. Without one, the stand-in is "a hired human doing the job in the owner's account".
- **analyse**
  - Per judge:
    - the axis means per run and their delta (newer minus older), and the item mean;
    - `swapPasses` counts;
    - threshold passes by the rubric v1 rule: every axis 3 or more, truth 4 or more, mean 3.6 or more;
    - each run's share of the top six by mean;
    - `sameImage` groups, split into within-run and cross-run twins.
  - Then, across judges, the sign of each delta (up, down, flat or mixed) with its minimum and maximum.
  - Writes `analysis.json` beside the pool.

## Noise floor

Measured with three independent directors on one round-2 pool:

| Measure | Value |
|---|---|
| Per-item mean spread | median 0.21, max 0.57 |
| Mean \|diff\| per axis | distinctiveness 0.56, truth 0.67, ambition 0.33, hook 0.28, picture 0.22, feasibility 0.17, native 0.11 |

A delta inside these numbers in one judge is noise; a direction shared by every judge is not.

## Success

A change succeeds when all three hold:

- the axis it targets is up in every judge;
- hook and picture are not down;
- cross-run twins (`sameImage` across runs) are not up.

## Caveat

The creative-director definition changed in 15146a7, when it learnt to score with the version its brief names. Later judgements, even under rubric v1, are not strictly comparable with numbers from before that commit.
