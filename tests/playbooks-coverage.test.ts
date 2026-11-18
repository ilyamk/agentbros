import test from "node:test";
import assert from "node:assert/strict";
import { COMMAND_REGISTRY } from "../src/lib/cli/commands";
import { FILM_TYPES } from "../src/lib/film/routes";
import { RECIPES } from "../src/lib/templates/recipes";
import { WORKFLOWS } from "../src/lib/workflows/dispatch";
import {
  FILM_TYPE_COVERAGE,
  FOOTAGE_GOAL_COVERAGE,
  GENERAL_CATEGORIES,
  GENERAL_COMMANDS,
  knownNames,
  listPlaybookIds,
  NON_PRODUCTION_SECTIONS,
  ownerlessEntries,
  ownerPlaybooks,
  productionCommands,
  RECIPE_COVERAGE,
  WORKFLOW_COVERAGE,
  type CoverageOwner,
} from "../src/lib/playbooks";

const ALL: [string, Record<string, CoverageOwner[]>][] = [
  ["film type", FILM_TYPE_COVERAGE],
  ["recipe", RECIPE_COVERAGE],
  ["workflow", WORKFLOW_COVERAGE],
];

test("coverage: every film type, recipe and workflow has an owner, and nothing else does", () => {
  assert.deepEqual(Object.keys(FILM_TYPE_COVERAGE).sort(), [...FILM_TYPES].sort());
  assert.deepEqual(Object.keys(RECIPE_COVERAGE).sort(), RECIPES.map((recipe) => recipe.id).sort());
  assert.deepEqual(Object.keys(WORKFLOW_COVERAGE).sort(), WORKFLOWS.map((workflow) => workflow.id).sort());
  for (const [kind, map] of ALL)
    for (const [entry, owners] of Object.entries(map)) assert.ok(owners.length > 0, `${kind} ${entry}`);
});

test("coverage: every owner exists unless marked pending", () => {
  const ids = listPlaybookIds();
  const owners = [
    ...ALL.flatMap(([, map]) => Object.values(map).flat()),
    ...FOOTAGE_GOAL_COVERAGE.map((entry) => entry.owner),
  ];
  for (const id of ownerPlaybooks(owners))
    assert.ok(ids.includes(id), `${id} owns a registry entry but has no playbook folder`);
  const pending = owners.flatMap((owner) => ("playbook" in owner && owner.pending ? [owner.playbook] : []));
  for (const id of pending) assert.match(id, /^[a-z][a-z0-9-]*$/, id);
});

test("coverage: GENERAL names real commands and categories, each with a reason", () => {
  const known = knownNames();
  const aliases = new Set(COMMAND_REGISTRY.map((entry) => entry.alias));
  for (const [alias, reason] of Object.entries(GENERAL_COMMANDS)) {
    assert.ok(aliases.has(alias) && alias in known.scripts, `GENERAL command ${alias} is not a registry alias`);
    assert.ok(reason.length >= 10, alias);
  }
  for (const [category, reason] of Object.entries(GENERAL_CATEGORIES))
    assert.ok(known.categories.has(category) && reason.length >= 10, category);
  for (const reason of Object.values(NON_PRODUCTION_SECTIONS)) assert.ok(reason.length >= 10);
  const production = productionCommands();
  assert.ok(production.includes("footage:next") && production.includes("film:next"));
  assert.ok(
    !production.includes("test:fast") && !production.includes("fetch:lottie") && !production.includes("test:render"),
    "dev, legacy and development tools are not production",
  );
  assert.equal(new Set(production).size, production.length, "one entry per alias");
});

test("coverage: every production command and library category is named by a playbook or listed in GENERAL", () => {
  assert.deepEqual(ownerlessEntries(), { commands: [], categories: [] });
});
