import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { formatFinding, lintProject, lintProjectCode, lintProjectSlop } from "../src/lib/verification/lint";
const repo = process.cwd();
const tsx = path.join(repo, "node_modules/tsx/dist/cli.mjs");
function fixture(sources: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "video-lint "));
  for (const dir of ["src/components", "src/templates", "src/lib", "src/mcp", "scripts"])
    mkdirSync(path.join(root, dir), { recursive: true });
  for (const [file, text] of Object.entries(sources)) writeFileSync(path.join(root, file), text);
  return root;
}
test("rejects nondeterministic rendered media and shell execution with source evidence", () => {
  const root = fixture({
    "src/components/Bad.tsx": `import {useFrame as draw} from '@react-three/fiber'; import gsap from 'gsap'; import {setInterval as tick} from 'node:timers';
const badStyle={transition:'all 1s',animationName:'spin'}; export const Bad = () => { draw(()=>{}); tick(()=>{},100); window.requestAnimationFrame(()=>{}); setTimeout(()=>{},100); return <img className="animate-spin" style={badStyle} />; };`,
    "scripts/bad.ts": `import {exec as unsafe,spawn} from 'node:child_process'; unsafe(userInput); const options={shell:true}; spawn('tool',[userInput],options);`,
  });
  try {
    const result = lintProject(root);
    for (const code of [
      "ANIMATION_LIBRARY",
      "WALL_CLOCK_ANIMATION",
      "NATIVE_MEDIA",
      "TAILWIND_ANIMATION",
      "CSS_ANIMATION",
      "SHELL_COMMAND",
      "SHELL_ENABLED",
    ])
      assert.ok(
        result.findings.some((f) => f.code === code),
        code,
      );
    assert.ok(result.findings.every((f) => f.line > 0 && f.column > 0 && !path.isAbsolute(f.file)));
  } finally {
    rmSync(root, { recursive: true });
  }
});
test("accepts frame-driven animation, prose mentioning tags, and safe malicious argv", () => {
  const root = fixture({
    "src/templates/Good.tsx": `import {Img,useCurrentFrame,spring} from 'remotion'; const prose='<img animate-spin setTimeout'; export const Good=()=>{const frame=useCurrentFrame();return <Img src="x" style={{transform:'scale('+spring({frame,fps:30})+')'}} />;};`,
    "scripts/good.ts": `import {spawnSync} from 'node:child_process'; setTimeout(()=>{},100); spawnSync(process.execPath,['-e','process.stdout.write(process.argv[1])','$(touch /tmp/unsafe); spaces'],{shell:false}); const matcher=/word/.exec('word');`,
  });
  try {
    assert.deepEqual(lintProject(root).findings, []);
  } finally {
    rmSync(root, { recursive: true });
  }
  const payload = "$(touch /tmp/unsafe-lint-fixture); spaces";
  const result = spawnSync(process.execPath, ["-e", "process.stdout.write(process.argv[1])", payload], {
    encoding: "utf8",
    shell: false,
  });
  assert.equal(result.stdout, payload);
  assert.equal(result.status, 0);
});
test("project mode warns on emoji and purple-blue gradients in src/projects/<id>, without failing", () => {
  const root = fixture({});
  mkdirSync(path.join(root, "src/projects/demo"), { recursive: true });
  writeFileSync(
    path.join(root, "src/projects/demo/Sloppy.tsx"),
    `export const Sloppy=()=> <div style={{backgroundImage:'linear-gradient(135deg, #6366f1, #8b5cf6)'}}>Launch day 🚀</div>;`,
  );
  writeFileSync(
    path.join(root, "src/projects/demo/Clean.tsx"),
    `export const Clean=()=> <div style={{backgroundImage:'linear-gradient(#0f172a, #f97316)'}}>© 2026 Acme™ → next</div>;`,
  );
  try {
    const result = lintProjectSlop(root, "demo");
    assert.equal(result.filesScanned, 2);
    assert.deepEqual(result.warnings.map((f) => `${f.file} ${f.code}`).sort(), [
      "src/projects/demo/Sloppy.tsx SLOP_EMOJI",
      "src/projects/demo/Sloppy.tsx SLOP_GRADIENT",
    ]);
    assert.deepEqual(lintProject(root).findings, [], "plain lint does not scan projects");
    assert.throws(() => lintProjectSlop(root, "../etc"), /Not a project id/);
    assert.throws(() => lintProjectSlop(root, "missing"), /No project code/);
    const child = spawnSync(
      process.execPath,
      [tsx, path.join(repo, "scripts/lint-project.ts"), "--root", root, "--project", "demo"],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const envelope = JSON.parse(child.stdout.trim());
    assert.equal(envelope.ok, true);
    assert.equal(envelope.metadata.slop.warnings.length, 2);
  } finally {
    rmSync(root, { recursive: true });
  }
});
test("STATIC_PATH flags bare public/ paths on media src; staticFile and block props pass", () => {
  const root = fixture({
    "src/components/Paths.tsx": `import {Img,staticFile} from 'remotion'; import {Video,Audio} from '@remotion/media'; const pic='projects/demo/a.png';
export const Bad=({id}:{id:string})=><>
<Img src={pic}/>
<Video src="/projects/demo/clip.mp4"/>
<Audio src={\`shared/music/\${id}.mp3\`}/>
<Img src="public/images/x.png"/>
</>;`,
    "src/templates/Paths.tsx": `import {Img,staticFile} from 'remotion'; import {ScatterField} from './ScatterField'; const remote='https://example.test/a.png';
export const Good=({id}:{id:string})=><>
<Img src={staticFile('projects/demo/a.png')}/>
<Img src={staticFile(\`projects/\${id}/a.png\`)}/>
<Img src={remote}/>
<ScatterField src="projects/demo/a.png" items={[{src:'projects/demo/b.png'}]}/>
</>;`,
  });
  try {
    const result = lintProject(root);
    const at = (file: string) => result.findings.filter((f) => f.file === file).map((f) => `${f.line} ${f.code}`);
    assert.deepEqual(at("src/components/Paths.tsx"), [
      "3 STATIC_PATH",
      "4 STATIC_PATH",
      "5 STATIC_PATH",
      "6 STATIC_PATH",
    ]);
    assert.deepEqual(
      at("src/templates/Paths.tsx"),
      [],
      "staticFile() and library block props are not bare media paths",
    );
    assert.match(
      formatFinding(result.findings[0]!),
      /^src\/components\/Paths\.tsx:3 STATIC_PATH: .+\. Fix: wrap the path: <Img src=\{staticFile\("projects\/<id>\/…"\)\}>/,
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});
test("CSS_BG_IMAGE flags url() backgrounds in styles and stylesheets, not gradients", () => {
  const root = fixture({
    "src/components/Bg.tsx": `import {staticFile} from 'remotion'; const bg={backgroundImage:\`url(\${staticFile('a.png')})\`};
export const Bad=()=><>
<div style={bg}/>
<div style={{background:'center / cover url("projects/demo/a.png")'}}/>
<style>{'.x{background-image: url(a.png)}'}</style>
</>;`,
    "src/templates/Bg.tsx": `export const Good=({c}:{c:string})=><>
<div style={{backgroundImage:\`linear-gradient(\${c}, transparent)\`}}/>
<div style={{background:'radial-gradient(#000, #fff)',filter:'url(#grain)'}}/>
<div style={{maskImage:'url(#m)'}}/>
</>;`,
    "src/lib/notes.ts": `export const css={backgroundImage:'url(a.png)'};`,
  });
  try {
    const result = lintProject(root);
    const at = (file: string) => result.findings.filter((f) => f.file === file).map((f) => `${f.line} ${f.code}`);
    assert.deepEqual(at("src/components/Bg.tsx"), ["1 CSS_BG_IMAGE", "4 CSS_BG_IMAGE", "5 CSS_BG_IMAGE"]);
    assert.deepEqual(at("src/templates/Bg.tsx"), []);
    assert.deepEqual(at("src/lib/notes.ts"), [], "only rendered code");
  } finally {
    rmSync(root, { recursive: true });
  }
});
test("project mode lints src/projects/<id> with the render rules and fails the CLI", () => {
  const root = fixture({});
  mkdirSync(path.join(root, "src/projects/demo/scenes"), { recursive: true });
  writeFileSync(
    path.join(root, "src/projects/demo/scenes/Hook.tsx"),
    `import {motion} from 'framer-motion'; export const Hook=()=>{const r=Math.random();return <motion.div style={{opacity:r}}><img src="projects/demo/a.png"/></motion.div>;};`,
  );
  writeFileSync(
    path.join(root, "src/projects/demo/Root.tsx"),
    `import {Img,random,staticFile} from 'remotion'; export const Root=()=> <Img src={staticFile('projects/demo/a.png')} style={{opacity:random('demo')}} />;`,
  );
  try {
    const result = lintProjectCode(root, "demo");
    assert.equal(result.filesScanned, 2);
    assert.deepEqual(result.findings.map((f) => `${f.file} ${f.code}`).sort(), [
      "src/projects/demo/scenes/Hook.tsx ANIMATION_LIBRARY",
      "src/projects/demo/scenes/Hook.tsx NATIVE_MEDIA",
      "src/projects/demo/scenes/Hook.tsx STATIC_PATH",
      "src/projects/demo/scenes/Hook.tsx UNSEEDED_RANDOM",
    ]);
    assert.ok(
      result.findings
        .map(formatFinding)
        .every((line) => /^src\/projects\/demo\/scenes\/Hook\.tsx:1 [A-Z_]+: .+\. Fix: .+\.$/.test(line)),
    );
    assert.deepEqual(lintProject(root).findings, [], "plain lint does not scan projects");
    const child = spawnSync(
      process.execPath,
      [tsx, path.join(repo, "scripts/lint-project.ts"), "--root", root, "--project", "demo"],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 1, child.stdout + child.stderr);
    const envelope = JSON.parse(child.stdout.trim());
    assert.equal(envelope.error, "VALIDATION");
    assert.equal(envelope.details.findings.length, 4);
    assert.match(envelope.message, /Hook\.tsx:1 [A-Z_]+: .+ Fix: /);
  } finally {
    rmSync(root, { recursive: true });
  }
});
test("lint CLI emits one envelope and fails invalid rendering source", () => {
  const root = fixture({ "src/components/Bad.tsx": "export const Bad=()=> <video/>;" });
  try {
    const child = spawnSync(process.execPath, [tsx, path.join(repo, "scripts/lint-project.ts"), "--root", root], {
      encoding: "utf8",
    });
    assert.equal(child.status, 1);
    const lines = child.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    const result = JSON.parse(lines[0]);
    assert.equal(result.ok, false);
    assert.equal(result.error, "VALIDATION");
    assert.match(result.message, /lint violation/);
    assert.equal(result.details.findings[0].code, "NATIVE_MEDIA");
  } finally {
    rmSync(root, { recursive: true });
  }
});
test("every production TypeScript entry point has offline one-envelope help", { timeout: 120000 }, () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/KEY|TOKEN|SECRET/.test(key)) delete env[key];
  // MCP is intentionally outside scripts and speaks JSON-RPC. CLI help must never load credentials or submit jobs.
  for (const file of readdirSync(path.join(repo, "scripts")).filter((name) => name.endsWith(".ts"))) {
    const child = spawnSync(process.execPath, [tsx, path.join(repo, "scripts", file), "--help"], {
      encoding: "utf8",
      env,
      timeout: 10000,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(child.status, 0, `${file}: ${child.stderr} ${child.stdout}`);
    const lines = child.stdout.trim().split("\n");
    assert.equal(lines.length, 1, file);
    const result = JSON.parse(lines[0]);
    assert.equal(result.ok, true, file);
    assert.equal(typeof result.elapsedMs, "number", file);
  }
});
test("motion library blocks are rendered source and get the determinism rules", () => {
  const root = fixture({});
  mkdirSync(path.join(root, "src/motion/library/ui"), { recursive: true });
  writeFileSync(
    path.join(root, "src/motion/library/ui/Bad.tsx"),
    `import {motion} from 'framer-motion'; export const Bad=()=>{setTimeout(()=>{},10);return <motion.div style={{animationName:'spin'}} />;};`,
  );
  try {
    const codes = lintProject(root)
      .findings.filter((f) => f.file === "src/motion/library/ui/Bad.tsx")
      .map((f) => f.code);
    for (const code of ["ANIMATION_LIBRARY", "WALL_CLOCK_ANIMATION", "CSS_ANIMATION"])
      assert.ok(codes.includes(code), code);
  } finally {
    rmSync(root, { recursive: true });
  }
});
test("allows bare gsap only in the motion wrapper and bans interactive plugins everywhere", () => {
  const root = fixture({});
  mkdirSync(path.join(root, "src/motion/library"), { recursive: true });
  writeFileSync(
    path.join(root, "src/motion/gsap.ts"),
    `import {gsap} from 'gsap'; import {SplitText} from 'gsap/SplitText'; import {ScrollTrigger} from 'gsap/ScrollTrigger'; export {gsap,SplitText,ScrollTrigger};`,
  );
  writeFileSync(
    path.join(root, "src/motion/library/Good.tsx"),
    `import {useGsapTimeline} from '@remotion/gsap'; import {SplitText} from '../gsap'; export const x=[useGsapTimeline,SplitText];`,
  );
  writeFileSync(
    path.join(root, "src/motion/library/Bad.tsx"),
    `import {gsap} from 'gsap'; import {DrawSVGPlugin} from 'gsap/DrawSVGPlugin'; import {Draggable} from 'gsap/Draggable'; export const x=[gsap,DrawSVGPlugin,Draggable];`,
  );
  try {
    const findings = lintProject(root).findings;
    const at = (file: string) =>
      findings
        .filter((f) => f.file === file)
        .map((f) => f.code)
        .sort();
    assert.deepEqual(at("src/motion/gsap.ts"), ["GSAP_PLUGIN"]);
    assert.deepEqual(at("src/motion/library/Good.tsx"), []);
    assert.deepEqual(at("src/motion/library/Bad.tsx"), ["ANIMATION_LIBRARY", "ANIMATION_LIBRARY", "GSAP_PLUGIN"]);
  } finally {
    rmSync(root, { recursive: true });
  }
});
test("rendered code may not read the wall clock, unseeded randomness or Tailwind transition classes", () => {
  const root = fixture({
    "src/components/Clock.tsx": `import {cn} from './cn'; const fade='opacity-0 transition-opacity'; export const Clock=()=>{const a=Math.random();const b=Date.now();const c=new Date();const d=performance.now();const e=window.performance.now();return <div className={cn('p-4',\`md:duration-300 \${a}\`)}><span className={fade}/><i className="hover:animate-pulse"/><b className="transition"/>{a+b+d+e+String(c)}</div>;};`,
    "src/templates/Fine.tsx": `import {random,useCurrentFrame} from 'remotion'; const parsed=new Date('2026-01-01T00:00:00Z'); export const Fine=()=>{const frame=useCurrentFrame();const r=random('dot-'+frame);return <div className="transition-none animate-none p-2" data-label="transition duration-300">{r}{parsed.getUTCFullYear()}</div>;};`,
    "src/Root.tsx": `export const Root=()=>{const seed=Math.random();return <div>{seed}</div>;};`,
  });
  mkdirSync(path.join(root, "src/types"), { recursive: true });
  writeFileSync(
    path.join(root, "src/types/schema.ts"),
    `export const stamp=()=>new Date().toISOString(); export const id=()=>Math.random();`,
  );
  writeFileSync(path.join(root, "src/lib/clock.ts"), `export const now=()=>Date.now()+Math.random();`);
  try {
    const result = lintProject(root);
    const at = (file: string) =>
      result.findings
        .filter((f) => f.file === file)
        .map((f) => f.code)
        .sort();
    assert.deepEqual(at("src/components/Clock.tsx"), [
      "TAILWIND_ANIMATION",
      "TAILWIND_TRANSITION",
      "TAILWIND_TRANSITION",
      "TAILWIND_TRANSITION",
      "UNSEEDED_RANDOM",
      "WALL_CLOCK_VALUE",
      "WALL_CLOCK_VALUE",
      "WALL_CLOCK_VALUE",
      "WALL_CLOCK_VALUE",
    ]);
    assert.deepEqual(at("src/templates/Fine.tsx"), []);
    assert.deepEqual(at("src/Root.tsx"), ["UNSEEDED_RANDOM"], "Root.tsx is rendered code");
    assert.deepEqual(at("src/types/schema.ts"), [], "schemas are scanned but are not rendered code");
    assert.deepEqual(at("src/lib/clock.ts"), []);
    assert.equal(result.filesScanned, 5);
  } finally {
    rmSync(root, { recursive: true });
  }
});
