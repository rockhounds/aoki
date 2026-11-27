// SPDX-FileCopyrightText: 2026 Aoki contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vite-plus/test";
import {
  matchesSource,
  mergeCatalog,
  mergeSourceCatalog,
  retainProductNames,
} from "./resolve-i18n-catalogs.ts";

describe("catalog conflict resolution", () => {
  it("keeps upstream order and adds fork messages without overwriting upstream translations", () => {
    const merged = mergeCatalog(
      { retained: "old", stale: "remove" },
      { retained: "old", added: ["fork", { i: 1 }] },
      { retained: "new", stale: "remove", upstream: "upstream" },
    );
    expect(Object.entries(merged ?? {})).toEqual([
      ["retained", "new"],
      ["upstream", "upstream"],
      ["added", ["fork", { i: 1 }]],
    ]);
  });

  it("leaves competing translations for the same message unresolved", () => {
    expect(mergeCatalog({ key: "old" }, { key: "fork" }, { key: "upstream" })).toBeUndefined();
  });

  it("keeps the referenced product while preserving other translation edits", () => {
    const english = { product: "Open T3 Code", copy: "Help" };
    expect(
      retainProductNames(
        { product: "T3-Code öffnen", copy: "Hilfe" },
        { product: "Aoki-Code öffnen", copy: "Unterstützung" },
        english,
        english,
      ),
    ).toEqual({ product: "T3-Code öffnen", copy: "Unterstützung" });
  });

  it("rejects keys or English values the resolved source does not contain", () => {
    expect(matchesSource({ current: "x" }, { current: "x" })).toBe(true);
    expect(matchesSource({ current: "y" }, { current: "x" })).toBe(false);
    expect(matchesSource({ current: "x", stale: "x" }, { current: "x" })).toBe(false);
  });

  it("uses current source keys and keeps translations supplied by either side", () => {
    expect(
      mergeSourceCatalog(
        { removed: "stale", upstream: "old" },
        { fork: "fork translation", removed: "translated stale", upstream: "old" },
        { upstream: "upstream translation", fork: "Fork source" },
        { upstream: "Upstream source", fork: "Fork source", new: "New source" },
      ),
    ).toEqual({ upstream: "upstream translation", fork: "fork translation", new: "New source" });
  });

  it("keeps conflicting localized edits for review when both differ from the source", () => {
    expect(
      mergeSourceCatalog(
        { key: "old translation" },
        { key: "fork translation" },
        { key: "upstream translation" },
        { key: "English" },
      ),
    ).toBeUndefined();
  });
});
