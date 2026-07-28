import { describe, expect, it } from "vitest";

import { parseJsonLines, parseStrictJsonLines } from "./json-lines.js";

describe("JSON Lines test helpers", () => {
  it("preserves tolerant and strict blank-line behavior for CRLF input", () => {
    const source = '{"value":1}\r\n\r\n{"value":2}\r\n';

    expect(parseJsonLines<{ readonly value: number }>(source)).toEqual([
      { value: 1 },
      { value: 2 },
    ]);
    expect(() => parseStrictJsonLines(source)).toThrow(SyntaxError);
  });
});
