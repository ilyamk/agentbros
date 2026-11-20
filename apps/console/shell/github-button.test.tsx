import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FixtureApiClient } from "@/api/fixture";
import { fixtureStore, renderWith } from "@/test/utils";
import { GithubButton } from "./github-button";

function setup() {
  const api = new FixtureApiClient({ fixture: "cards" });
  const github = vi.spyOn(api, "github");
  const store = fixtureStore(api);
  renderWith(<GithubButton />, { store });
  return { github, store };
}

describe("GithubButton", () => {
  it("waits for the session before asking for the star count", async () => {
    const { github, store } = setup();
    expect(screen.getByRole("link", { name: /GitHub/ })).toBeTruthy();
    expect(github).not.toHaveBeenCalled();
    expect(screen.queryByText(/1\.3K/)).toBeNull();

    await act(() => store.start());

    await waitFor(() => expect(screen.getByText(/1\.3K/)).toBeTruthy());
    expect(github).toHaveBeenCalledTimes(1);
  });
});
