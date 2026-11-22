import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { fetchCliReleaseFeed } from "./cliReleaseFeed";

function release(tagName: string, draft = false) {
  return { tag_name: tagName, draft };
}

function page(releases: ReadonlyArray<ReturnType<typeof release>>, status = 200) {
  return new Response(JSON.stringify(releases), { status });
}

function stubPages(...pages: ReadonlyArray<Response>) {
  const fetchMock = vi.fn<(typeof globalThis)["fetch"]>();
  for (const response of pages) {
    fetchMock.mockResolvedValueOnce(response);
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchCliReleaseFeed", () => {
  it("takes each channel's newest published release and skips drafts and foreign tags", async () => {
    const fetchMock = stubPages(
      page([
        release("v0.0.50-nightly.20261002.1"),
        release("v0.0.50", true), // draft assets are not downloadable
        release("v0.0.49"),
        release("docs-refresh"),
        release("v0.0.50-preview.20261002.7"),
      ]),
    );

    expect(await fetchCliReleaseFeed()).toEqual({
      stable: "0.0.49",
      nightly: "0.0.50-nightly.20261002.1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pages the release index until each channel has a match or the index runs out", async () => {
    const fetchMock = stubPages(
      page(
        Array.from({ length: 100 }, (_, index) => release(`v0.0.${60 - index}-nightly.20261002.1`)),
      ),
      page([release("v0.0.50")]),
    );

    expect(await fetchCliReleaseFeed()).toEqual({
      stable: "0.0.50",
      nightly: "0.0.60-nightly.20261002.1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("page=2");
  });

  it("stops at a short page even when a channel has no published release", async () => {
    const fetchMock = stubPages(page([release("v0.0.50")]));

    expect(await fetchCliReleaseFeed()).toEqual({ stable: "0.0.50" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports nothing when no published release exists", async () => {
    stubPages(page([]));

    expect(await fetchCliReleaseFeed()).toEqual({});
  });

  it("fails when the index cannot be read", async () => {
    stubPages(new Response("nope", { status: 403 }));

    await expect(fetchCliReleaseFeed()).rejects.toThrow("HTTP 403");
  });
});
