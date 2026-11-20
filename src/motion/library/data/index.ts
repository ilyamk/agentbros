import { UnitTray } from "./UnitTray";
import { unitTrayCues, unitTrayDefaults, unitTraySchema } from "./unit-tray-plan";
import { VizScene, vizSceneSchema, vizSceneDefaults } from "./VizScene";
import { iconVisualItem } from "./IconVisual";
import { defineItem, type LibraryItem } from "../types";
import { BeforeAfterSplit, beforeAfterSplitDefaults, beforeAfterSplitSchema } from "./BeforeAfterSplit";
import { DonutBreakdown, donutBreakdownDefaults, donutBreakdownSchema } from "./DonutBreakdown";
import { HeroStat, heroStatDefaults, heroStatSchema } from "./HeroStat";
import { NetworkLightUp, networkLightUpDefaults, networkLightUpSchema } from "./NetworkLightUp";
import { RankedBars, rankedBarsDefaults, rankedBarsSchema } from "./RankedBars";
import { TICKER_CARD_FRAMES, TickerCard, tickerCardCues, tickerCardDefaults, tickerCardSchema } from "./TickerCard";
import { LineChartReveal, lineChartRevealDefaults, lineChartRevealSchema } from "./LineChartReveal";

const importPath = (file: string): string => `src/motion/library/data/${file}`;

export const items: LibraryItem[] = [
  defineItem({
    id: "viz-scene",
    category: "data",
    title: "Prepared visualisation",
    description:
      "A pinned, format-specific data chart or diagram prepared by viz:prepare. Transparent overlay or full scene; revise through commands.",
    tags: ["chart", "diagram", "nodes", "visualisation"],
    component: VizScene,
    schema: vizSceneSchema,
    defaultProps: vizSceneDefaults,
    durationInFrames: 150,
    formats: ["landscape", "vertical", "square"],
    importPath: importPath("VizScene"),
    cues: (props) => {
      const spec = props.plans[0]?.spec;
      return spec
        ? spec.events.length
          ? spec.events.map((e, index) => ({
              frame: e.frame,
              kind: "reveal" as const,
              sfx: "none" as const,
              weight: index === 0 ? ("hero" as const) : ("support" as const),
              label: e.action,
            }))
          : [
              {
                frame: Math.min(90, spec.durationFrames - 30),
                kind: "land" as const,
                sfx: "none" as const,
                weight: "hero" as const,
                label: "reading hold",
              },
            ]
        : [];
    },
  }),
  iconVisualItem,
  defineItem({
    id: "data-unit-tray",
    category: "data",
    title: "Physical unit tray",
    description:
      "Equal-sized objects enter or leave a fixed arrangement while the number follows the actual count. For comparisons where one object represents a declared real unit.",
    tags: ["count", "quantity", "material", "tile", "physical data"],
    component: UnitTray,
    schema: unitTraySchema,
    defaultProps: unitTrayDefaults,
    durationInFrames: 135,
    formats: ["landscape", "vertical", "square"],
    cues: unitTrayCues,
    importPath: importPath("UnitTray"),
    usage:
      "Use verified values in from/to and explain the unit in unitLabel. Keep the same shape and palette across a comparison.",
  }),
  defineItem({
    id: "hero-stat-odometer",
    category: "data",
    title: "Hero stat odometer",
    description:
      "One huge number rolls up on odometer reels while its history draws as a glowing sparkline beneath, then holds dead still as a quiet delta chip rises in. Use for the single headline metric of a launch or results film.",
    tags: ["stat", "counter", "odometer", "kpi", "sparkline", "keynote", "headline number"],
    component: HeroStat,
    schema: heroStatSchema,
    defaultProps: heroStatDefaults,
    durationInFrames: 135,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "hyperframes: registry/blocks/apple-money-count (Apache-2.0, idea only: land punch and flash)",
      "magicui: NumberTicker (MIT, idea only)",
      "Stripe Sessions annual volume stat",
    ],
    importPath: importPath("HeroStat"),
    // The roll itself stays silent (continuous motion); sound marks the landing and the chip.
    cues: ({ at, countFrames }) => [
      { frame: at + countFrames, kind: "land", sfx: "impact", weight: "hero", label: "number lands" },
      { frame: at + countFrames + 4, kind: "reveal", sfx: "pop", weight: "support", label: "delta chip" },
    ],
  }),
  defineItem({
    id: "line-chart-glow-draw",
    category: "data",
    title: "Line chart glow draw",
    description:
      "An area chart draws on in the accent behind a head that carries its live value, over a nice-scaled grid, then a callout card pops on the record point. Use for growth over time with one point worth naming.",
    tags: ["line chart", "area", "growth", "trend", "time series", "callout", "draw on"],
    component: LineChartReveal,
    schema: lineChartRevealSchema,
    defaultProps: lineChartRevealDefaults,
    durationInFrames: 150,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "hyperframes: registry/blocks/mk-line-graph (Apache-2.0, idea only: labels riding the draw front)",
      "Apple keynote growth curves",
    ],
    importPath: importPath("LineChartReveal"),
    cues: ({ at, drawFrames }) => [
      { frame: at + drawFrames + 2, kind: "hit", sfx: "pop", weight: "hero", label: "record point pops" },
      { frame: at + drawFrames + 8, kind: "reveal", sfx: "tick", weight: "support", label: "callout card" },
    ],
  }),
  defineItem({
    id: "ranked-bars-spring",
    category: "data",
    title: "Ranked bars spring",
    description:
      "Sorted horizontal bars spring out one after another with values counting on their tips; when all settle, the leader alone carries the accent while the rest stay in ink. Use to rank markets, features or competitors.",
    tags: ["bar chart", "ranking", "leaderboard", "comparison", "winner", "spring"],
    component: RankedBars,
    schema: rankedBarsSchema,
    defaultProps: rankedBarsDefaults,
    durationInFrames: 135,
    formats: ["landscape", "vertical"],
    inspiredBy: [
      "hyperframes: registry/blocks/bar-chart-race (Apache-2.0, idea only: accent handed to the leader)",
      "hyperframes: registry/blocks/data-chart (Apache-2.0, idea only)",
    ],
    importPath: importPath("RankedBars"),
    cues: ({ at, staggerFrames, data }) => [
      ...data.map((_, i) => ({
        frame: Math.round(at + i * staggerFrames),
        kind: "reveal" as const,
        sfx: "tick" as const,
        weight: "support" as const,
        label: `bar ${i + 1}`,
      })),
      {
        frame: Math.round(at + (data.length - 1) * staggerFrames + 34),
        kind: "hit",
        sfx: "glass",
        weight: "hero",
        label: "leader keeps the accent",
      },
    ],
  }),
  defineItem({
    id: "donut-segment-sweep",
    category: "data",
    title: "Donut segment sweep",
    description:
      "A donut sweeps round segment by segment with rounded gaps while the legend answers each arrival; the focus slice, the only one in the accent, then lifts out as the centre lands on its share. Use for a breakdown where one part is the story.",
    tags: ["donut", "pie", "share", "breakdown", "radial", "progress", "legend"],
    component: DonutBreakdown,
    schema: donutBreakdownSchema,
    defaultProps: donutBreakdownDefaults,
    durationInFrames: 135,
    formats: ["landscape", "vertical"],
    inspiredBy: ["magicui: AnimatedCircularProgressBar (MIT, idea only)", "Apple Watch activity rings"],
    importPath: importPath("DonutBreakdown"),
    cues: ({ at, sweepFrames, data }) => {
      const total = data.reduce((sum, datum) => sum + Math.max(datum.value, 0), 0) || 1;
      let cursor = 0;
      const arrivals = data.map((datum, i) => {
        const frame = Math.round(at + cursor * sweepFrames);
        cursor += Math.max(datum.value, 0) / total;
        return {
          frame,
          kind: "reveal" as const,
          sfx: "tick" as const,
          weight: "support" as const,
          label: `segment ${i + 1}`,
        };
      });
      return [
        ...arrivals,
        { frame: at + sweepFrames + 2, kind: "land", sfx: "pop", weight: "hero", label: "focus slice lifts" },
      ];
    },
  }),
  defineItem({
    id: "before-after-split",
    category: "data",
    title: "Before and after split",
    description:
      "Old metrics sit dimmed on one side; a seam sweeps in and the new side rolls each number from its old value to its new one, landing with a change chip. Use for the payoff of a product: time, errors, cost before and after.",
    tags: ["comparison", "before after", "versus", "metrics", "improvement", "split"],
    component: BeforeAfterSplit,
    schema: beforeAfterSplitSchema,
    defaultProps: beforeAfterSplitDefaults,
    durationInFrames: 135,
    formats: ["landscape", "vertical"],
    inspiredBy: ["Stripe and Linear launch before/after metric slides"],
    importPath: importPath("BeforeAfterSplit"),
    cues: ({ at, metrics }) => [
      { frame: at + 31, kind: "peak", sfx: "whoosh", weight: "support", label: "seam mid-sweep" },
      ...metrics.map((_, i) => ({
        frame: at + 16 + 18 + i * 7 + 18,
        kind: "land" as const,
        sfx: i === metrics.length - 1 ? ("impact" as const) : ("tick" as const),
        weight: i === metrics.length - 1 ? ("hero" as const) : ("support" as const),
        label: `metric ${i + 1} lands`,
      })),
    ],
  }),
  defineItem({
    id: "network-light-up",
    category: "data",
    title: "Network light-up",
    description:
      "A hub lights its named nodes one by one along drawn edges, outer nodes branch off them while a counter climbs, then the graph holds. Use for integrations, reach, a growing community or any system of connected parts.",
    tags: ["network", "graph", "nodes", "integrations", "connections", "ecosystem", "reach"],
    component: NetworkLightUp,
    schema: networkLightUpSchema,
    defaultProps: networkLightUpDefaults,
    durationInFrames: 135,
    formats: ["landscape", "vertical"],
    inspiredBy: [
      "hyperframes: registry/blocks/us-map-flow (Apache-2.0, idea only: flows lighting up)",
      "Stripe global network visuals",
    ],
    importPath: importPath("NetworkLightUp"),
    // Outer nodes branch at seeded times and stay silent; the hub and named nodes carry the sound.
    cues: ({ at, nodes }) => [
      { frame: at, kind: "reveal", sfx: "pop", weight: "hero", label: "hub lights" },
      ...nodes.map((_, i) => ({
        frame: at + 10 + i * 5,
        kind: "reveal" as const,
        sfx: "tick" as const,
        weight: "support" as const,
        label: `node ${i + 1}`,
      })),
    ],
  }),
  defineItem({
    id: "ticker-card",
    category: "data",
    title: "Ticker card swap and pull-back",
    description:
      "One market card holds its place while its asset, price, change and line chart swap in place every 6-12 frames, then a soft pull-back (sine.inOut, about 20 frames) shows it as one card of a row of neighbours blurred by depth, the row sliding left. Use for 'every market, one place': many assets, prices or listings shown as one rhythm. Tickers are invented; `ground: \"transparent\"` lays it over footage.",
    tags: [
      "ticker",
      "market",
      "price",
      "card",
      "swap",
      "cycle",
      "line chart",
      "pull back",
      "row",
      "depth of field",
      "finance",
      "listings",
    ],
    component: TickerCard,
    schema: tickerCardSchema,
    defaultProps: tickerCardDefaults,
    durationInFrames: TICKER_CARD_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "design-reference/library/polymarket: card-rotator 7.20-10.53 s (the card holds while its asset swaps every 6-12 frames with its line chart; pull-back F248-F268, about 0.67 s, sine.inOut, from a card about 0.37 W to a row at about 0.27 W, neighbours blurred by depth, the row sliding left)",
    ],
    importPath: importPath("TickerCard"),
    usage:
      '<TickerCard {...tickerCardDefaults} assets={[...]} neighbours={[...]} pullAt={54} ground="light" />; swap frames from tickerCardSwaps(props), pull and drift from tickerPull/tickerDrift in src/motion/library/data/ticker-plan.',
    cues: (props) => tickerCardCues(props as Parameters<typeof tickerCardCues>[0]),
  }),
];
