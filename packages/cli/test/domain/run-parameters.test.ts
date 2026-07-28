import { describe, expect, it } from "vitest";

import { parsedStoredParameters, runParameterValue } from "../../src/domain/run-parameters.js";

describe("stored run parameters", () => {
  it("preserves an own __proto__ parameter without changing the snapshot prototype", () => {
    const parameters = parsedStoredParameters(JSON.parse('{"__proto__":"fenced value"}'));

    expect(parameters).toBeDefined();
    expect(Object.getPrototypeOf(parameters)).toBeNull();
    expect(Object.hasOwn(parameters ?? {}, "__proto__")).toBe(true);
    expect(runParameterValue(parameters ?? {}, "__proto__")).toBe("fenced value");
  });
});
