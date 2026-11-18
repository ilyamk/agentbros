import { compileViz } from "../src/lib/viz/compile";
import { exampleViz } from "../src/lib/viz/store";
export async function eventFixture() {
  const spec = exampleViz("process");
  delete spec.groups;
  spec.data = [
    { id: "a", label: "Input", colour: "#65aaff" },
    { id: "b", label: "Output" },
  ];
  spec.edges = [{ id: "edge", source: "a", target: "b" }];
  spec.events = [
    { action: "reveal", target: "a", frame: 0, duration: 20 },
    { action: "draw", target: "edge", frame: 20, duration: 20 },
    { action: "travel", target: "edge", frame: 40, duration: 20 },
    { action: "highlight", target: "a", frame: 60, duration: 20 },
    { action: "dim", target: "b", frame: 90, duration: 20 },
    { action: "annotate", target: "a", text: "Measured input", frame: 100, duration: 15 },
    { action: "hold", target: "a", frame: 120, duration: 30 },
  ];
  const plan = await compileViz(spec, "landscape");
  return plan;
}
