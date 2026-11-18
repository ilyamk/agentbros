import type { VizSpec } from "../../types/viz";

export function validateViz(spec: VizSpec): void {
  const ids = spec.data.map((d) => d.id);
  const groups = spec.groups ?? [];
  if (
    groups.length ||
    spec.data.some((d) => d.ports?.length || d.group) ||
    spec.edges.some((e) => e.sourcePort || e.targetPort)
  ) {
    if (!/^(network|process)(-3d)?$/.test(spec.recipe) || spec.layout !== "layered")
      throw new Error("Groups and ports require a layered process or network");
    const all = [
      ...ids,
      ...groups.map((g) => g.id),
      ...spec.edges.map((e) => e.id),
      ...spec.data.flatMap((d) => (d.ports ?? []).map((p) => p.id)),
    ];
    if (new Set(all).size !== all.length) throw new Error("Graph, group and port IDs must be globally unique");
    for (const group of groups) {
      const seen = new Set([group.id]);
      let parent = group.parent;
      while (parent) {
        if (seen.has(parent) || seen.size >= 4) throw new Error("Groups must be acyclic with at most four levels");
        seen.add(parent);
        const item = groups.find((g) => g.id === parent);
        if (!item) throw new Error("Unknown group parent");
        parent = item.parent;
      }
    }
    for (const datum of spec.data)
      if (datum.group && !groups.some((g) => g.id === datum.group)) throw new Error("Unknown datum group");
    for (const edge of spec.edges)
      for (const [node, port] of [
        [edge.source, edge.sourcePort],
        [edge.target, edge.targetPort],
      ])
        if (port && !spec.data.find((d) => d.id === node)?.ports?.some((p) => p.id === port))
          throw new Error("Port must belong to its edge endpoint");
    for (const group of groups)
      if (!spec.data.some((d) => d.group === group.id) && !groups.some((g) => g.parent === group.id))
        throw new Error("Groups must contain nodes or groups");
  }
  if (spec.xScale === "utc") {
    for (const d of spec.data) {
      if (
        !d.date ||
        d.x !== undefined ||
        !Number.isFinite(Date.parse(d.date + "T00:00:00Z")) ||
        new Date(d.date + "T00:00:00Z").toISOString().slice(0, 10) !== d.date
      )
        throw new Error("UTC observations require canonical dates and no numeric x");
    }
    const previous = new Map<string, string>();
    for (const d of spec.data) {
      const key = d.series ?? "main";
      if (previous.has(key) && previous.get(key)! >= d.date!)
        throw new Error("UTC dates must increase within each series");
      previous.set(key, d.date!);
    }
  } else if (spec.data.some((d) => d.date !== undefined)) throw new Error("Date values require UTC xScale");
  if (spec.data.some((d) => d.label.length > 48))
    throw new Error("Label exceeds first-version text budget; shorten explicitly");
  if (spec.scale === "log" && !["line", "area", "bars", "ranked-bars", "scatter", "bars-3d"].includes(spec.recipe))
    throw new Error("This recipe does not support logarithmic scale");
  if (spec.recipe === "stacked-bars") {
    const pairs = spec.data.map((d) => `${d.series ?? "main"}\0${d.label}`);
    if (new Set(pairs).size !== pairs.length) throw new Error("Duplicate stack label and series");
    if (spec.data.some((d) => d.value === null || d.value === undefined || d.value < 0))
      throw new Error("Stacked bars require explicit nonnegative values");
    const labels = new Set(spec.data.map((d) => d.label)),
      series = new Set(spec.data.map((d) => d.series ?? "main"));
    if (spec.data.length !== labels.size * series.size) throw new Error("Every stack requires all series explicitly");
  }
  if (["line", "area"].includes(spec.recipe) && spec.data.some((d) => d.x !== undefined)) {
    if (spec.data.some((d) => d.x === undefined)) throw new Error("All observations require x when x is supplied");
    const groups = new Map<string, number>();
    for (const d of spec.data) {
      const key = d.series ?? "main";
      const previous = groups.get(key);
      if (previous !== undefined && d.x! <= previous) throw new Error("Series x must increase strictly");
      groups.set(key, d.x!);
    }
  }
  if (!ids.length) throw new Error("A visualisation requires data");
  if (new Set(ids).size !== ids.length || new Set(spec.edges.map((e) => e.id)).size !== spec.edges.length)
    throw new Error("Duplicate datum or edge IDs");
  if (spec.formats.length !== new Set(spec.formats).size) throw new Error("Duplicate formats");
  const graph = /network|process|tree|sankey/.test(spec.recipe);
  if (graph && spec.data.length > (spec.recipe.endsWith("-3d") ? 40 : 100))
    throw new Error("Node budget exceeded; divide the scene");
  if (!graph && !spec.data.some((d) => typeof d.value === "number"))
    throw new Error("Chart requires at least one numeric observation");
  if (!graph && (spec.data.length > 2000 || new Set(spec.data.map((d) => d.series ?? "main")).size > 12))
    throw new Error("Chart budget exceeded; aggregate explicitly");
  for (const e of spec.edges)
    if (!ids.includes(e.source) || !ids.includes(e.target)) throw new Error(`Unknown edge endpoint: ${e.id}`);
  for (const d of spec.data) {
    if (d.quantity && d.quantity.unit !== spec.unit)
      throw new Error("Displayed unit must match every declared quantity unit");
    if (d.parent && !ids.includes(d.parent)) throw new Error(`Unknown parent: ${d.id}`);
    if (!graph && d.value === undefined) throw new Error(`Missing numeric value: ${d.id}`);
    if (spec.scale === "log" && (d.value === null || (d.value ?? 0) <= 0))
      throw new Error("Log scale requires positive values");
  }
  if (
    spec.recipe === "donut" &&
    (spec.data.some((d) => (d.value ?? -1) < 0) || spec.data.reduce((s, d) => s + (d.value ?? 0), 0) <= 0)
  )
    throw new Error("Donut requires nonnegative values and positive total");
  const visit = (node: string, active: Set<string>, seen: Set<string>): void => {
    if (active.has(node)) throw new Error("Cyclic hierarchy or Sankey");
    if (seen.has(node)) return;
    active.add(node);
    for (const next of spec.recipe === "tree"
      ? spec.data.filter((d) => d.parent === node).map((d) => d.id)
      : spec.edges.filter((e) => e.source === node).map((e) => e.target))
      visit(next, active, seen);
    active.delete(node);
    seen.add(node);
  };
  if (spec.recipe === "tree" || spec.recipe === "sankey") {
    const seen = new Set<string>();
    for (const node of ids) visit(node, new Set(), seen);
  }
  if (
    spec.camera.move !== "static" &&
    ((spec.camera.endFrame ?? spec.durationFrames - 30) <= spec.camera.startFrame ||
      (spec.camera.endFrame ?? spec.durationFrames - 30) > spec.durationFrames - 30)
  )
    throw new Error("Camera motion must end after its start and before the final reading hold");
  for (const event of spec.events) {
    if (
      event.action === "travel" &&
      !spec.edges.some((e) => e.id === event.target) &&
      !event.target?.startsWith("series-")
    )
      throw new Error("Travel target must be a supplied edge or series path");
    if (event.action === "hold") {
      const relevant = spec.events.filter(
        (e) => e !== event && (!e.target || !event.target || e.target === event.target),
      );
      if (relevant.some((e) => e.frame < event.frame + event.duration && e.frame + e.duration > event.frame))
        throw new Error("Hold overlaps a changing event");
      const reveals = relevant.filter(
        (e) => ["reveal", "draw"].includes(e.action) && e.frame + e.duration <= event.frame,
      );
      if (
        event.frame <
        (reveals.length
          ? Math.max(...reveals.map((e) => e.frame + e.duration))
          : Math.min(90, spec.durationFrames - 30))
      )
        throw new Error("Hold must follow the element reveal");
      if (
        !event.target &&
        spec.camera.move !== "static" &&
        event.frame < (spec.camera.endFrame ?? spec.durationFrames - 30)
      )
        throw new Error("Scene reading hold must follow the camera move");
    }
    if (event.frame + event.duration > spec.durationFrames) throw new Error("Event exceeds scene duration");
    const seriesIds = ["line", "area"].includes(spec.recipe)
      ? [...new Set(spec.data.map((d) => `series-${d.series ?? "main"}`))]
      : [];
    if (
      event.target &&
      !seriesIds.includes(event.target) &&
      !ids.includes(event.target) &&
      !spec.edges.some((e) => e.id === event.target)
    )
      throw new Error(`Unknown event target: ${event.target}`);
  }
}
