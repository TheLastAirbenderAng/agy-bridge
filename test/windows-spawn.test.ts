import { describe, expect, it } from "vitest";
import { agySpawnOptions } from "../src/runner.js";

describe("agySpawnOptions", () => {
  it("hides the Windows console while retaining detached execution", () => {
    // Given
    const cwd = "C:/work";

    // When
    const options = agySpawnOptions(cwd);

    // Then
    expect(options).toEqual({ cwd, detached: true, windowsHide: true });
  });
});
