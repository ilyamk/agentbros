import { parseArgs, runScript } from "../src/lib/cli";
import { fetchCity } from "../src/lib/blender-arsenal/city";

void runScript(async () => {
  const args = parseArgs([
    { name: "lat", type: "number", required: true, description: "Latitude in degrees (−85 to 85)" },
    { name: "lon", type: "number", required: true, description: "Longitude in degrees" },
    { name: "radius", type: "number", default: 250, description: "Fetch radius in metres (50–1500)" },
    { name: "consent", required: true, description: "Acquisition consent: who/when/why" },
  ] as const);
  const result = await fetchCity({ lat: args.lat!, lon: args.lon!, radius: args.radius! }, args.consent!);
  return { outputs: [result.file, result.receipt], metadata: result };
});
