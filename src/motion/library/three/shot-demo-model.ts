import { Color, CylinderGeometry, SphereGeometry, TorusGeometry, type BufferGeometry } from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

// Original projector fixture. Encode its geometry and animation in a self-contained glTF for offline, asset-free previews.
export function projectorDemoSource(studio = false) {
  const data: Uint8Array[] = [];
  const bufferViews: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  const accessors: {
    bufferView: number;
    componentType: number;
    count: number;
    type: string;
    min?: number[];
    max?: number[];
  }[] = [];
  let byteLength = 0;
  const accessor = (
    values: Float32Array | Uint16Array,
    type: string,
    count: number,
    min?: number[],
    max?: number[],
  ) => {
    const view = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
    const padded = new Uint8Array(Math.ceil(view.length / 4) * 4);
    padded.set(view);
    data.push(padded);
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: view.length });
    byteLength += padded.length;
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: values instanceof Float32Array ? 5126 : 5123,
      count,
      type,
      ...(min ? { min } : {}),
      ...(max ? { max } : {}),
    });
    return accessors.length - 1;
  };
  const geometry = (mesh: BufferGeometry) => {
    mesh.computeBoundingBox();
    const box = mesh.boundingBox!;
    const { position, normal } = mesh.attributes;
    const index = mesh.getIndex();
    const result = {
      attributes: {
        POSITION: accessor(
          new Float32Array(position!.array),
          "VEC3",
          position!.count,
          box.min.toArray(),
          box.max.toArray(),
        ),
        NORMAL: accessor(new Float32Array(normal!.array), "VEC3", normal!.count),
      },
      ...(index ? { indices: accessor(new Uint16Array(index.array), "SCALAR", index.count) } : {}),
    };
    mesh.dispose();
    return result;
  };
  const cube = geometry(new RoundedBoxGeometry(1, 1, 1, studio ? 4 : 2, 0.075));
  const cylinder = geometry(new CylinderGeometry(0.5, 0.5, 1, 56).rotateX(Math.PI / 2));
  const fixtureMaterials = [
    { name: "Ceramic", base: [0.22, 0.3, 0.35, 1], metal: 0.38, rough: 0.32 },
    { name: "Machined alloy", base: [0.43, 0.55, 0.6, 1], metal: 0.76, rough: 0.29 },
    { name: "Optics", base: [0.03, 0.27, 0.24, 1], metal: 0.58, rough: 0.18 },
    { name: "Insulator", base: [0.017, 0.027, 0.042, 1], metal: 0.04, rough: 0.52 },
    { name: "Status", base: [0.17, 0.95, 0.68, 1], metal: 0.16, rough: 0.3 },
  ];
  const studioMaterials = [
    ["Satin graphite", "#444443", 0.65, 0.29],
    ["Champagne alloy", "#c6a280", 0.83, 0.25],
    ["Optical coating", "#179794", 0.52, 0.1],
    ["Ceramic black", "#101619", 0.14, 0.38],
    ["Status", "#ff8e47", 0.27, 0.29],
    ["Bead-blasted titanium", "#858985", 0.78, 0.39],
    ["Deep anodised blue", "#10484d", 0.65, 0.22],
  ].map(([name, colour, metal, rough]) => ({
    name,
    base: [...new Color(String(colour)).toArray(), 1],
    metal,
    rough,
  }));
  const materials = (studio ? studioMaterials : fixtureMaterials).map(({ name, base, metal, rough }) => ({
    name,
    pbrMetallicRoughness: { baseColorFactor: base, metallicFactor: metal, roughnessFactor: rough },
    ...(name === "Status" ? { emissiveFactor: studio ? [0.25, 0.075, 0.014] : [0.025, 0.32, 0.15] } : {}),
  }));
  const shapes = studio
    ? [cube, cylinder, geometry(new TorusGeometry(0.45, 0.036, 12, 96)), geometry(new SphereGeometry(0.5, 48, 24))]
    : [cube, cylinder];
  const meshes = shapes.flatMap((shape) => materials.map((_, material) => ({ primitives: [{ ...shape, material }] })));
  const nodes: {
    name: string;
    mesh?: number;
    translation?: number[];
    scale?: number[];
    children?: number[];
  }[] = [];
  const part = (
    name: string,
    material: number,
    translation: number[],
    scale: number[],
    shape: boolean | "ring" | "lens" = false,
  ) => {
    const geometryId = shape === "ring" ? 2 : shape === "lens" ? 3 : shape ? 1 : 0;
    nodes.push({ name, mesh: geometryId * materials.length + material, translation, scale });
    return nodes.length - 1;
  };
  let latch: number;
  let battery: number;
  if (studio) {
    part("Lower chassis", 0, [0, -0.19, 0], [2.55, 0.62, 1.62]);
    part("Upper housing", 5, [0, 0.23, -0.03], [2.58, 0.37, 1.64]);
    part("Perimeter seam", 3, [0, 0.063, -0.01], [2.54, 0.037, 1.64]);
    part("Satin lid", 5, [0, 0.42, -0.03], [2.57, 0.09, 1.63]);
    part("Glass fascia", 3, [0, -0.005, 0.812], [2.44, 0.82, 0.055]);
    part("Optical barrel", 0, [-0.62, 0.055, 0.858], [0.88, 0.88, 0.165], true);
    part("Bezel rim", 1, [-0.62, 0.055, 0.944], [0.87, 0.87, 0.31], "ring");
    part("Machined rim", 5, [-0.62, 0.055, 0.975], [0.76, 0.76, 0.51], "ring");
    part("Aperture gasket", 3, [-0.62, 0.055, 0.989], [0.68, 0.68, 0.295], "ring");
    part("Lens", 6, [-0.62, 0.055, 0.943], [0.65, 0.65, 0.105], "lens");
    part("Inner optical element", 2, [-0.62, 0.055, 0.993], [0.49, 0.49, 0.052], "lens");
    part("Optical retaining ring", 0, [-0.62, 0.055, 1.014], [0.51, 0.51, 0.25], "ring");
    const vents = Array.from({ length: 10 }, (_, i) =>
      part(`Inlet vane ${i + 1}`, 5, [0.035 + i * 0.082, 0.175, 0.841], [0.038, 0.25, 0.023]),
    );
    nodes.push({ name: "Air Intake", children: vents });
    part("USB C collar", 1, [0.96, -0.19, 0.837], [0.27, 0.137, 0.028]);
    part("Connector", 3, [0.96, -0.19, 0.852], [0.2, 0.069, 0.028]);
    part("Connector tongue", 5, [0.96, -0.19, 0.868], [0.122, 0.015, 0.012]);
    part("Status LED", 4, [0.96, -0.323, 0.844], [0.07, 0.017, 0.009]);
    part("Control inset", 3, [0.72, 0.468, 0.34], [0.34, 0.028, 0.24]);
    part("Power button", 1, [0.72, 0.49, 0.34], [0.25, 0.024, 0.17]);
    part("Control LED", 4, [0.45, 0.474, 0.36], [0.04, 0.012, 0.025]);
    for (const x of [-0.91, 0.91]) part(`Foot ${x}`, 3, [x, -0.517, 0], [0.34, 0.1, 0.72]);
    part("Fan recess", 3, [0.57, -0.03, -0.854], [0.7, 0.7, 0.035], true);
    const ring = part("Fan shroud", 5, [0.57, -0.03, -0.87], [0.68, 0.68, 0.39], "ring");
    const fan = part("Fan hub", 1, [0.57, -0.03, -0.882], [0.2, 0.2, 0.05], true);
    const fins = Array.from({ length: 8 }, (_, i) => {
      const a = (Math.PI * i) / 4;
      return part(
        `Fan vane ${i + 1}`,
        0,
        [0.57 + 0.22 * Math.cos(a), -0.03 + 0.22 * Math.sin(a), -0.88],
        [0.111, 0.095, 0.028],
      );
    });
    nodes.push({ name: "Fan", children: [ring, fan, ...fins] });
    const exhaust = Array.from({ length: 6 }, (_, i) =>
      part(`Exhaust vane ${i + 1}`, 5, [-0.52, -0.255 + i * 0.095, -0.854], [0.78, 0.037, 0.04]),
    );
    nodes.push({ name: "Exhaust", children: exhaust });
    part("Battery recess", 3, [0.41, -0.249, 0.846], [0.81, 0.3, 0.054]);
    for (const y of [-0.378, -0.125]) part(`Battery guide ${y}`, 1, [0.41, y, 0.92], [0.74, 0.022, 0.19]);
    latch = part("Latch", 4, [0.41, -0.396, 0.918], [0.3, 0.04, 0.049]);
    const cartridge = part("Cartridge shell", 0, [0, 0, 0], [0.72, 0.225, 0.34]);
    const lip = part("Cartridge endcap", 1, [0, 0, 0.174], [0.73, 0.235, 0.042]);
    const grip = part("Cartridge grip", 3, [0, 0, 0.202], [0.56, 0.124, 0.04]);
    battery = nodes.push({ name: "Battery", translation: [0.41, -0.249, 0.77], children: [cartridge, lip, grip] }) - 1;
  } else {
    part("Chassis", 0, [0, 0, 0], [2.36, 1.05, 1.39]);
    part("Top plate", 1, [0, 0.55, 0], [2.38, 0.09, 1.41]);
    part("Front fascia", 3, [0, 0, 0.713], [2.27, 0.91, 0.08]);
    part("Lens collar", 1, [-0.55, 0.02, 0.79], [0.86, 0.86, 0.23], true);
    part("Lens gasket", 3, [-0.55, 0.02, 0.921], [0.71, 0.71, 0.055], true);
    part("Lens", 2, [-0.55, 0.02, 0.953], [0.58, 0.58, 0.035], true);
    part("Optical aperture", 2, [-0.55, 0.02, 0.98], [0.44, 0.44, 0.027], true);
    part("Air Intake", 1, [0.54, 0.14, 0.774], [0.78, 0.51, 0.052]);
    for (let index = 0; index < 6; index++) {
      part(`Inlet fin ${index + 1}`, 3, [0.54, -0.058 + index * 0.079, 0.805], [0.65, 0.029, 0.013]);
    }
    part("Fan", 2, [0.56, 0.12, -0.72], [0.66, 0.66, 0.094], true);
    part("Exhaust", 1, [-0.52, 0.1, -0.728], [0.76, 0.53, 0.1]);
    part("Port bezel", 1, [0.98, -0.18, 0.766], [0.24, 0.15, 0.049]);
    part("Connector", 3, [0.98, -0.18, 0.798], [0.177, 0.08, 0.031]);
    part("Diagnostic LED", 4, [0.97, -0.31, 0.785], [0.087, 0.033, 0.026]);
    part("Power button", 3, [0.78, 0.606, 0.3], [0.27, 0.028, 0.19]);
    part("Status LED", 4, [0.55, 0.609, 0.31], [0.045, 0.022, 0.045]);
    part("Foot L", 3, [-0.82, -0.56, 0], [0.32, 0.11, 0.74]);
    part("Foot R", 3, [0.82, -0.56, 0], [0.32, 0.11, 0.74]);
    latch = part("Latch", 4, [0.57, -0.4, 0.783], [0.37, 0.073, 0.068]);
    battery = part("Battery", 1, [0.52, -0.3, 0.752], [0.71, 0.22, 0.15]);
  }
  const time = accessor(new Float32Array([0, 0.32, 1]), "SCALAR", 3, [0], [1]);
  const keys = [
    accessor(
      new Float32Array(
        studio
          ? [0.41, -0.396, 0.918, 0.41, -0.45, 0.963, 0.41, -0.45, 0.963]
          : [0.57, -0.4, 0.783, 0.57, -0.49, 0.85, 0.57, -0.49, 0.85],
      ),
      "VEC3",
      3,
    ),
    accessor(
      new Float32Array(
        studio
          ? [0.41, -0.249, 0.77, 0.41, -0.249, 0.77, 0.41, -0.249, 1.62]
          : [0.52, -0.3, 0.752, 0.52, -0.3, 0.752, 0.52, -0.3, 1.52],
      ),
      "VEC3",
      3,
    ),
  ];
  let bytes = "";
  for (const buffer of data) {
    for (let offset = 0; offset < buffer.length; offset += 8192) {
      bytes += String.fromCharCode(...buffer.subarray(offset, offset + 8192));
    }
  }
  const children = new Set(nodes.flatMap((node) => node.children ?? []));
  const gltf = {
    asset: { version: "2.0", generator: "Agent Bros. Pictures - projector fixture" },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, index) => index).filter((index) => !children.has(index)) }],
    nodes,
    meshes,
    materials,
    bufferViews,
    accessors,
    buffers: [{ byteLength, uri: `data:application/octet-stream;base64,${btoa(bytes)}` }],
    animations: [
      {
        name: "release-battery",
        samplers: keys.map((output) => ({ input: time, output, interpolation: "LINEAR" })),
        channels: [latch, battery].map((node, sampler) => ({ sampler, target: { node, path: "translation" } })),
      },
    ],
  };
  return `data:model/gltf+json;base64,${btoa(JSON.stringify(gltf))}`;
}
