/**
 * Create a new video project from template.
 *
 * Usage: pnpm project:new <project-id>
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import type { ProjectConfig } from "../src/types/video";
import { ProjectTitleSchema } from "../src/types/project-display";
import { writeProjectTitle } from "../src/lib/project-display";
import { consoleNextFields } from "../src/lib/console/next-block";

import {
  runScript,
  parseArgs,
  validateProjectId,
  assertPathWithin,
  CliErrorObject,
  emitProgress,
} from "../src/lib/cli";

const PROJECT_BASE = path.join("public", "projects");

runScript(async () => {
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift();
  if (argv[0] && !argv[0].startsWith("-")) argv.splice(0, 1, "--project", argv[0]);
  const args = parseArgs(
    [
      { name: "project", required: true, description: "Project slug" },
      { name: "title", description: "Short display name for Studio Console" },
    ] as const,
    argv,
  );
  const projectId = args.project!;
  validateProjectId(projectId);
  const title = ProjectTitleSchema.optional().parse(args.title);
  const projectDir = path.join(PROJECT_BASE, projectId);
  assertPathWithin(PROJECT_BASE, projectDir);
  if (existsSync(projectDir))
    throw new CliErrorObject({
      code: "FILE_EXISTS",
      message: `Project "${projectId}" already exists at ${projectDir}`,
    });

  // Create directory structure
  const dirs = [
    projectDir,
    path.join(projectDir, "voiceover"),
    path.join(projectDir, "music"),
    path.join(projectDir, "assets", "images"),
    path.join(projectDir, "assets", "videos"),
    path.join(projectDir, "assets", "lottie"),
    path.join(projectDir, "assets", "sfx"),
  ];

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }

  // Create project.json template
  const config: ProjectConfig = {
    name: projectId
      .split("-")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" "),
    formats: ["vertical", "square"],
    productName: "Your Product",
    tagline: "Your tagline here",
    colors: {
      accent: "#6C5CE7",
      background: "#0F0F0F",
      text: "#FFFFFF",
    },
    voice: "rachel",
    musicPrompt: "Modern upbeat electronic background music, energetic and positive, 30 seconds",
    musicVolume: 0.15,
    scenes: [
      {
        id: "hook",
        text: "Your hook voiceover text here.",
        visualType: "title",
        headline: "Your Hook Headline",
        subtext: "Supporting text",
      },
      {
        id: "problem",
        text: "Describe the problem your audience faces.",
        visualType: "feature",
        headline: "The Problem",
        subtext: "Why this matters",
      },
      {
        id: "solution",
        text: "Present your solution.",
        visualType: "product",
        headline: "Your Solution",
        subtext: "How it works",
      },
      {
        id: "cta",
        text: "Call to action text.",
        visualType: "cta",
        headline: "Get Started",
        subtext: "Try it free today",
      },
    ],
  };

  writeFileSync(path.join(projectDir, "project.json"), JSON.stringify(config, null, 2) + "\n");

  emitProgress(`Project "${projectId}" created at ${projectDir}`);
  return {
    outputs: [path.join(projectDir, "project.json"), ...(title ? [writeProjectTitle(projectDir, title)] : [])],
    metadata: { projectId, ...(await consoleNextFields({ rootDir: process.cwd(), project: projectId })) },
  };
});
