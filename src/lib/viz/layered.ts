import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import type { VizFormat, VizPlan, VizSpec } from "../../types/viz";

const LAYOUT_ROOT = "__viz_layout_root__";

/** ELK owns compound offsets and port routes; every returned coordinate uses one viewport transform. */
export async function layeredViz(
  spec: VizSpec,
  format: VizFormat,
  box: { left: number; top: number; width: number; height: number },
): Promise<{ positions: Map<string, { x: number; y: number }>; scale: number; primitives: VizPlan["primitives"] }> {
  const groups = spec.groups ?? [];
  const network = spec.recipe.startsWith("network");
  const children = (parent?: string): ElkNode[] => [
    ...groups
      .filter((g) => g.parent === parent)
      .map((g) => ({
        id: g.id,
        children: children(g.id),
        layoutOptions: { "elk.padding": "[top=52,left=24,bottom=24,right=24]" },
      })),
    ...spec.data
      .filter((d) => d.group === parent)
      .map((d) => ({
        id: d.id,
        width: network ? 56 : 180,
        height: network ? 56 : 72,
        layoutOptions: { "org.eclipse.elk.portConstraints": "FIXED_SIDE" },
        ports: d.ports?.map((p) => ({
          id: p.id,
          width: 8,
          height: 8,
          layoutOptions: { "org.eclipse.elk.port.side": p.side },
        })),
      })),
  ];
  const graph = await new ELK().layout<ElkNode>({
    id: LAYOUT_ROOT,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": format === "vertical" ? "DOWN" : "RIGHT",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.spacing.nodeNode": "60",
      "elk.layered.spacing.nodeNodeBetweenLayers": "90",
    },
    children: children(),
    edges: spec.edges.map((e) => ({
      id: e.id,
      sources: [e.sourcePort ?? e.source],
      targets: [e.targetPort ?? e.target],
    })),
  });
  const scale = Math.min(1, box.width / Math.max(1, graph.width!), box.height / Math.max(1, graph.height!));
  if (scale < 0.7) throw new Error("Graph too dense for readable nodes; divide the scene");
  const ox = box.left + (box.width - graph.width! * scale) / 2,
    oy = box.top + (box.height - graph.height! * scale) / 2;
  const offsets = new Map<string, { x: number; y: number }>(),
    routes: Array<{ edge: NonNullable<ElkNode["edges"]>[number]; x: number; y: number }> = [];
  const positions = new Map<string, { x: number; y: number }>(),
    primitives: VizPlan["primitives"] = [];
  const walk = (node: ElkNode, x: number, y: number): void => {
    const nx = x + (node.x ?? 0),
      ny = y + (node.y ?? 0),
      group = groups.find((g) => g.id === node.id);
    offsets.set(node.id, { x: nx, y: ny });
    if (group) {
      primitives.push({
        id: group.id,
        kind: "rect",
        x: ox + nx * scale,
        y: oy + ny * scale,
        width: node.width! * scale,
        height: node.height! * scale,
        fill: spec.theme.background === "transparent" ? "#10121a" : spec.theme.background,
      });
      primitives.push({
        id: `${group.id}-label`,
        kind: "text",
        x: ox + (nx + node.width! / 2) * scale,
        y: oy + (ny + 30) * scale,
        width: Math.max(1, (node.width! - 30) * scale),
        text: group.label,
        fill: spec.theme.ink,
      });
    } else if (node.id !== LAYOUT_ROOT) {
      positions.set(node.id, { x: ox + (nx + node.width! / 2) * scale, y: oy + (ny + node.height! / 2) * scale });
      for (const port of node.ports ?? [])
        primitives.push({
          id: port.id,
          kind: "circle",
          x: ox + (nx + port.x! + 4) * scale,
          y: oy + (ny + port.y! + 4) * scale,
          radius: 4 * scale,
          fill: spec.theme.ink,
        });
    }
    for (const edge of node.edges ?? []) routes.push({ edge, x: nx, y: ny });
    for (const child of node.children ?? []) walk(child, nx, ny);
  };
  walk(graph, 0, 0);
  for (const { edge, x, y } of routes) {
    const container = offsets.get(edge.container ?? "") ?? { x, y };
    const paths = (edge.sections ?? []).map((section) =>
      [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
        .map(
          (point, i) =>
            `${i ? "L" : "M"}${ox + (container.x + point.x) * scale},${oy + (container.y + point.y) * scale}`,
        )
        .join(" "),
    );
    if (!paths.length) throw new Error(`ELK did not route edge ${edge.id}`);
    primitives.push({ id: edge.id, kind: "path", x: 0, y: 0, d: paths.join(" "), fill: spec.theme.accent });
  }
  primitives.sort((a, b) => Number(!groups.some((g) => g.id === a.id)) - Number(!groups.some((g) => g.id === b.id)));
  return { positions, scale, primitives };
}
