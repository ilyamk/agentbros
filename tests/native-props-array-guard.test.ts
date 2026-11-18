import test from "node:test";
import assert from "node:assert/strict";
import { serializedNativeProps } from "../src/lib/delivery/service";
import { ProjectVideoSchema, type ProjectVideoProps } from "../src/lib/project-props";
const props = ProjectVideoSchema.parse({
  projectId: "array-cpu",
  format: "landscape",
  productName: "CPU",
  tagline: "",
  accentColor: "#000000",
  bgColor: "#ffffff",
  textColor: "#000000",
  voiceoverEnabled: false,
  musicVolume: 0,
  scenes: [],
});
for (const mode of [
  "own-method",
  "own-accessor",
  "inherited-method",
  "inherited-accessor",
  "unknown-key",
  "nonenumerable-key",
  "null-prototype",
  "subclass",
  "own-symbol",
])
  test(`actual native consumer rejects ${mode} before JSON hook or getter`, () => {
    let calls = 0;
    const values: any[] = [];
    if (mode === "own-method")
      (values as any).toJSON = () => {
        calls++;
        return ["changed"];
      };
    if (mode === "own-accessor")
      Object.defineProperty(values, "toJSON", {
        get() {
          calls++;
          return () => ["changed"];
        },
      });
    if (mode === "inherited-method")
      Object.setPrototypeOf(values, {
        toJSON() {
          calls++;
          return ["changed"];
        },
      });
    if (mode === "inherited-accessor")
      Object.setPrototypeOf(
        values,
        Object.defineProperty({}, "toJSON", {
          get() {
            calls++;
            return () => ["changed"];
          },
        }),
      );
    if (mode === "unknown-key") (values as any).unknown = 1;
    if (mode === "nonenumerable-key") Object.defineProperty(values, "unknown", { value: 1 });
    if (mode === "null-prototype") Object.setPrototypeOf(values, null);
    if (mode === "subclass") Object.setPrototypeOf(values, class extends Array {}.prototype);
    if (mode === "own-symbol")
      Object.defineProperty(values, Symbol.toStringTag, {
        get() {
          calls++;
          return "Array";
        },
      });
    assert.throws(
      () => serializedNativeProps({ ...props, scenes: values } as ProjectVideoProps),
      /Invalid native render props/,
    );
    assert.equal(calls, 0);
  });
test("ordinary dense JSON arrays preserve exact values; sparse/undefined/index accessor and extra canonical-looking key refuse", () => {
  const dense = {
    ...props,
    scenes: [{ id: "scene", text: "", headline: "CPU", visualType: "title" as const, durationInFrames: 30 }],
  };
  assert.deepEqual(serializedNativeProps(dense), JSON.parse(JSON.stringify(dense)));
  for (const values of [Array(1), [undefined], Object.assign([], { ["01"]: 0 })])
    assert.throws(() => serializedNativeProps({ ...props, scenes: values } as ProjectVideoProps));
  let reads = 0;
  const accessor = Array(1);
  Object.defineProperty(accessor, "0", {
    get() {
      reads++;
      return {};
    },
  });
  assert.throws(() => serializedNativeProps({ ...props, scenes: accessor }));
  assert.equal(reads, 0);
});
