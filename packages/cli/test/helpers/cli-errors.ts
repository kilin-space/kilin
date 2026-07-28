import { expect } from "vitest";

import { OptionError } from "../../src/cli/arguments.js";

/**
 * Asserts that a command-line invocation is rejected with the stable `OPTION_INVALID`
 * code. Automation branches on the code, so the message is matched only as a fragment.
 */
export const expectOptionError = (operation: () => unknown, messagePart: string): void => {
  try {
    operation();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(OptionError);
    expect(error).toMatchObject({ code: "OPTION_INVALID" });
    expect((error as OptionError).message).toContain(messagePart);
    return;
  }
  throw new Error(`Expected the invocation to be rejected with ${messagePart}`);
};
