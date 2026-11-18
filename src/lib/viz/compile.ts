import { onVizColour } from "../../motion/viz/colour";
import { scaleLinear, scaleLog } from "d3-scale";
import { line, area, pie, arc, stack } from "d3-shape";
import { stratify, tree } from "d3-hierarchy";
import { sankey, sankeyLinkHorizontal } from "d3-sankey";
import { forceSimulation, forceLink, forceManyBody, forceCenter, type SimulationNodeDatum } from "d3-force";
import { layeredViz } from "./layered";
import { createHash } from "node:crypto";
import { VizPlanSchema, type VizSpec, type VizPlan, type VizFormat } from "../../types/viz";
import { validateViz } from "./validate";

const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v !== null && typeof v === "object"
      ? `{${Object.entries(v)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
          .join(",")}}`
      : JSON.stringify(v);
export const vizHash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const sizes = { landscape: [1920, 1080], vertical: [1080, 1920], square: [1080, 1080] } as const;
export async function compileViz(spec: VizSpec, format: VizFormat): Promise<VizPlan> {
  validateViz(spec);
  const [width, height] = sizes[format];
  const p: VizPlan["primitives"] = [];
  const suppliedIds = new Set([
    ...spec.data.map((d) => d.id),
    ...spec.edges.map((e) => e.id),
    ...(spec.groups ?? []).map((g) => g.id),
    ...spec.data.flatMap((d) => (d.ports ?? []).map((port) => port.id)),
  ]);
  const reserveGenerated = (id: string) => {
    if (suppliedIds.has(id))
      throw new Error(`Generated visualisation ID "${id}" collides with a supplied ID; rename the supplied ID`);
  };
  const left = 110,
    top = 200,
    w = width - 220,
    h = height - 340;
  const colour = spec.theme.accent;
  const seriesColour = (i: number) =>
    (spec.theme.seriesColours ?? [
      colour,
      spec.theme.ink,
      "#65aaff",
      "#f3b84a",
      "#df83ff",
      "#ff826b",
      "#77cbe5",
      "#d9de6b",
      "#cf8dba",
      "#a7b6ed",
      "#c9b18d",
      "#71bfa1",
    ])[i % 12] ?? colour;
  const label = (id: string, text: string, x: number, y: number, fill = spec.theme.ink, generatedTarget = false) => {
    if (generatedTarget) reserveGenerated(id);
    reserveGenerated(`${id}-label`);
    p.push({ id: `${id}-label`, kind: "text", text, x, y, width: 180, fill, datumId: id });
  };
  const recipe = spec.recipe.replace("-3d", "");
  if (["network", "process", "tree", "sankey"].includes(recipe)) {
    if (recipe === "sankey") {
      const graph = sankey<{ id: string; label: string }, { source: string; target: string; value: number }>()
        .nodeId((n) => n.id)
        .nodeWidth(24)
        .nodePadding(24)
        .extent([
          [left, top],
          [left + w, top + h],
        ])({
        nodes: spec.data.map((d) => ({ id: d.id, label: d.label })),
        links: spec.edges.map((e) => ({ source: e.source, target: e.target, value: e.value ?? 1 })),
      });
      for (const n of graph.nodes) {
        p.push({
          id: n.id,
          kind: "rect",
          x: n.x0!,
          y: n.y0!,
          width: n.x1! - n.x0!,
          height: n.y1! - n.y0!,
          fill: colour,
          datumId: n.id,
        });
        label(n.id, n.label, n.x0!, n.y0! - 12);
      }
      for (const [i, e] of graph.links.entries())
        p.push({
          id: spec.edges[i]!.id,
          kind: "path",
          x: 0,
          y: 0,
          d: sankeyLinkHorizontal()(e) ?? "",
          fill: colour,
          strokeWidth: e.width,
        });
    } else {
      let nodeScale = 1;
      const positions = new Map<string, { x: number; y: number }>();
      if (recipe === "tree") {
        const root = stratify<(typeof spec.data)[number]>()
          .id((d) => d.id)
          .parentId((d) => d.parent)(spec.data);
        tree<(typeof spec.data)[number]>().size([w - 180, h - 80])(root);
        for (const n of root.descendants()) positions.set(n.id!, { x: left + 90 + n.x!, y: top + 40 + n.y! });
      } else if (spec.layout === "force") {
        const nodes = spec.data.map((d) => ({ id: d.id }) as SimulationNodeDatum & { id: string });
        const links = spec.edges.map((e) => ({ source: e.source, target: e.target }));
        let seed = Number.parseInt(vizHash(spec.seed).slice(0, 8), 16);
        const random = () => {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          return seed / 4294967296;
        };
        const simulation = forceSimulation(nodes)
          .stop()
          .randomSource(random)
          .force(
            "link",
            forceLink(links)
              .id((n) => (n as { id: string }).id)
              .distance(180),
          )
          .force("charge", forceManyBody().strength(-400))
          .force("centre", forceCenter(width / 2, height / 2));
        simulation.tick(300);
        const xs = nodes.map((n) => n.x!),
          ys = nodes.map((n) => n.y!);
        const sx = scaleLinear()
          .domain([Math.min(...xs) - 1, Math.max(...xs) + 1])
          .range([left + 90, left + w - 90]);
        const sy = scaleLinear()
          .domain([Math.min(...ys) - 1, Math.max(...ys) + 1])
          .range([top + 40, top + h - 40]);
        for (const n of nodes) positions.set(n.id, { x: sx(n.x!), y: sy(n.y!) });
      } else {
        for (const group of spec.groups ?? []) reserveGenerated(`${group.id}-label`);
        const layered = await layeredViz(spec, format, { left, top, width: w, height: h });
        nodeScale = layered.scale;
        for (const [id, position] of layered.positions) positions.set(id, position);
        p.push(...layered.primitives);
      }
      const edges =
        recipe === "tree"
          ? spec.data.filter((d) => d.parent).map((d) => ({ id: `edge-${d.id}`, source: d.parent!, target: d.id }))
          : spec.edges;
      for (const e of recipe === "tree" || spec.layout === "force" ? edges : []) {
        if (recipe === "tree") reserveGenerated(e.id);
        const a = positions.get(e.source)!,
          b = positions.get(e.target)!;
        p.push({ id: e.id, kind: "path", x: 0, y: 0, d: `M${a.x},${a.y} L${b.x},${b.y}`, fill: colour });
      }
      for (const d of spec.data) {
        const pos = positions.get(d.id)!;
        p.push({
          id: d.id,
          kind: recipe === "network" ? "circle" : "rect",
          x: pos.x - (recipe === "network" ? 0 : 90 * nodeScale),
          y: pos.y - (recipe === "network" ? 0 : 36 * nodeScale),
          width: 180 * nodeScale,
          height: 72 * nodeScale,
          radius: 28 * nodeScale,
          fill: d.colour ?? colour,
          datumId: d.id,
        });
        label(
          d.id,
          d.label,
          pos.x,
          recipe === "network" ? pos.y - 50 : pos.y + 8,
          recipe === "network" ? spec.theme.ink : onVizColour(d.colour ?? colour),
        );
      }
    }
  } else if (recipe === "donut") {
    const r = Math.min(w, h) * 0.34;
    const slices = pie<(typeof spec.data)[number]>()
      .sort(null)
      .value((d) => d.value!)(spec.data);
    for (const [i, slice] of slices.entries()) {
      p.push({
        id: slice.data.id,
        kind: "path",
        x: width / 2,
        y: top + h / 2,
        d:
          arc<typeof slice>()
            .innerRadius(r * 0.6)
            .outerRadius(r)(slice) ?? "",
        fill: slice.data.colour ?? seriesColour(i),
        datumId: slice.data.id,
      });
      reserveGenerated(`legend-swatch-${i}`);
      p.push({
        id: `legend-swatch-${i}`,
        kind: "rect",
        x: left,
        y: top + 35 * i - 20,
        width: 20,
        height: 20,
        fill: slice.data.colour ?? seriesColour(i),
      });
      label(slice.data.id, `${slice.data.label}: ${slice.data.value}`, left + 130, top + 35 * i);
    }
  } else {
    const values = spec.data.map((d) => d.value).filter((v): v is number => v !== null && v !== undefined);
    const domainValues =
      recipe === "stacked-bars"
        ? [...new Set(spec.data.map((d) => d.label))].map((label) =>
            spec.data.filter((d) => d.label === label).reduce((sum, d) => sum + (d.value ?? 0), 0),
          )
        : values;
    const min = Math.min(0, ...domainValues),
      max = Math.max(0, ...domainValues);
    const y =
      spec.scale === "log"
        ? scaleLog()
            .domain([Math.min(...values), Math.max(...values) || 1])
            .range([top + h, top])
        : scaleLinear()
            .domain(min === max ? [min - 1, max + 1] : [min, max])
            .nice()
            .range([top + h, top]);
    const x = (i: number, count = spec.data.length) => left + ((i + 0.5) / count) * w;
    const number = (value: number) => new Intl.NumberFormat(spec.locale, { maximumFractionDigits: 6 }).format(value);
    for (const [i, tick] of y.ticks(5).entries()) {
      reserveGenerated(`axis-y-${i}`);
      p.push({
        id: `axis-y-${i}`,
        kind: "path",
        x: 0,
        y: 0,
        d: `M${left},${y(tick)} L${left + w},${y(tick)}`,
        fill: spec.theme.ink,
        strokeWidth: tick === 0 ? 2 : 1,
      });
      label(`tick-${i}`, number(tick), left - 45, y(tick) + 8, spec.theme.ink, true);
    }
    if (spec.unit) label("unit", spec.unit, left, top - 45, spec.theme.ink, true);
    const seriesNames = [...new Set(spec.data.map((d) => d.series).filter((s): s is string => s !== undefined))];
    for (const [i, name] of seriesNames.entries())
      label(`legend-${i}`, name, left + 160 * i, top + h + 65, spec.theme.ink, true);
    if (recipe === "line" || recipe === "area") {
      const numericX = (d: (typeof spec.data)[number]) =>
        spec.xScale === "utc" ? Date.parse(d.date! + "T00:00:00Z") : d.x;
      const xs = spec.data.map(numericX).filter((v): v is number => v !== undefined);
      const sx = scaleLinear()
        .domain(xs.length ? [Math.min(...xs), Math.max(...xs)] : [0, 1])
        .range([left, left + w]);
      const pointX = (d: (typeof spec.data)[number], j: number, n: number) =>
        numericX(d) !== undefined ? sx(numericX(d)!) : x(j, n);
      const series = [...new Set(spec.data.map((d) => d.series ?? "main"))];
      for (const [i, s] of series.entries()) {
        reserveGenerated(`series-${s}`);
        const rows = spec.data.filter((d) => (d.series ?? "main") === s);
        const points = rows.map(
          (d, j) => [pointX(d, j, rows.length), d.value === null ? NaN : y(d.value!)] as [number, number],
        );
        const path =
          recipe === "area"
            ? area<[number, number]>()
                .defined((a) => Number.isFinite(a[1]))
                .x((a) => a[0])
                .y0(y(spec.scale === "log" ? Math.min(...values) : 0))
                .y1((a) => a[1])(points)
            : line<[number, number]>().defined((a) => Number.isFinite(a[1]))(points);
        p.push({ id: `series-${s}`, kind: "path", x: 0, y: 0, d: path ?? "", fill: seriesColour(i) });
        for (const [j, d] of rows.entries())
          if (d.value !== null) label(d.id, `${d.label}: ${d.value}`, pointX(d, j, rows.length), y(d.value!) - 20);
      }
    } else if (recipe === "scatter") {
      const xs = spec.data.map((d) => d.x ?? 0);
      const sx = scaleLinear()
        .domain([Math.min(...xs) - 1, Math.max(...xs) + 1])
        .range([left, left + w]);
      for (const d of spec.data)
        if (d.value !== null) {
          p.push({
            id: d.id,
            kind: "circle",
            x: sx(d.x ?? 0),
            y: y(d.value!),
            radius: 12,
            fill: d.colour ?? colour,
            datumId: d.id,
          });
          label(d.id, d.label, sx(d.x ?? 0), y(d.value!) - 20);
        }
    } else if (recipe === "stacked-bars") {
      const keys = [...new Set(spec.data.map((d) => d.series ?? "main"))];
      const labels = [...new Set(spec.data.map((d) => d.label))];
      const records = labels.map((label) =>
        Object.fromEntries(
          keys.map((key) => [
            key,
            spec.data.find((d) => d.label === label && (d.series ?? "main") === key)?.value ?? 0,
          ]),
        ),
      );
      const layers = stack<Record<string, number>>().keys(keys)(records);
      const sy = y;
      for (const [k, layer] of layers.entries())
        for (const [i, point] of layer.entries()) {
          const datum = spec.data.find((d) => d.label === labels[i] && (d.series ?? "main") === keys[k]);
          if (!datum) continue;
          p.push({
            id: datum.id,
            kind: "rect",
            x: x(i, labels.length) - (w / labels.length) * 0.3,
            y: sy(point[1]),
            width: (w / labels.length) * 0.6,
            height: sy(point[0]) - sy(point[1]),
            fill: seriesColour(k),
            datumId: datum.id,
          });
        }
    } else {
      const rows =
        recipe === "ranked-bars" ? [...spec.data].sort((a, b) => (b.value ?? 0) - (a.value ?? 0)) : spec.data;
      for (const [i, d] of rows.entries())
        if (d.value !== null) {
          const base = y(spec.scale === "log" ? Math.min(...values) : 0);
          p.push({
            id: d.id,
            kind: "rect",
            x: x(i) - (w / rows.length) * 0.32,
            y: Math.min(base, y(d.value!)),
            width: (w / rows.length) * 0.64,
            height: Math.abs(base - y(d.value!)),
            fill: d.colour ?? colour,
            datumId: d.id,
          });
          label(d.id, `${d.label}: ${d.value}`, x(i), y(d.value!) - 20);
        }
    }
  }
  return VizPlanSchema.parse({ version: 1, format, width, height, primitives: p, dataHash: vizHash(spec.data), spec });
}
