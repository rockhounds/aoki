// SPDX-FileCopyrightText: 2026 Aoki contributors
// SPDX-License-Identifier: MIT

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { aokiVersion } from "./version.ts";

describe("aoki version stamping", () => {
  it.effect("every surface carries the root package.json version", () =>
    aokiVersion().pipe(Effect.provide(NodeServices.layer)),
  );
});
