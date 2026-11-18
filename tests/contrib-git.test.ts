import assert from "node:assert/strict";
import test from "node:test";
import { contributionBase } from "../src/lib/contrib/git";
import { temporaryRepository } from "./contrib-tools-helpers";

test("base discovery prefers explicit, upstream/main, origin/main, remote HEAD, then main", () => {
  const repo = temporaryRepository();
  try {
    const head = repo.git("rev-parse", "HEAD");
    assert.equal(contributionBase(repo.root), repo.base);
    repo.git("remote", "add", "fork", repo.root);
    repo.git("update-ref", "refs/remotes/fork/trunk", head);
    repo.git("symbolic-ref", "refs/remotes/fork/HEAD", "refs/remotes/fork/trunk");
    assert.equal(contributionBase(repo.root), head);
    repo.git("update-ref", "refs/remotes/origin/main", repo.base);
    assert.equal(contributionBase(repo.root), repo.base);
    repo.git("update-ref", "refs/remotes/upstream/main", head);
    assert.equal(contributionBase(repo.root), head);
    assert.equal(contributionBase(repo.root, repo.base), repo.base);
    assert.throws(() => contributionBase(repo.root, "absent"), /pass --base <commit>/);
  } finally {
    repo.dispose();
  }
});

test("remote-less clones and unrelated refs receive an actionable base hint", () => {
  const repo = temporaryRepository();
  try {
    repo.git("branch", "-D", "main");
    assert.throws(() => contributionBase(repo.root), /pass --base <commit>/);
    assert.equal(contributionBase(repo.root, repo.base), repo.base);
    const unrelated = repo.git("commit-tree", repo.git("rev-parse", "HEAD^{tree}"), "-m", "unrelated root");
    repo.git("update-ref", "refs/remotes/upstream/main", unrelated);
    repo.git("branch", "main", repo.base);
    assert.equal(contributionBase(repo.root), repo.base);
    assert.throws(() => contributionBase(repo.root, unrelated), /pass --base <commit>/);
  } finally {
    repo.dispose();
  }
});
