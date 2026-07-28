import { describe, expect, it } from "vitest";

import { KilinError } from "../../src/domain/errors.js";
import {
  maximumHostTriggerRequestBytes,
  parseCronTriggerSource,
  parseHostTriggerRequestBytes,
  parseStoredCronTriggerSource,
} from "../../src/domain/workflow-trigger.js";
import type { CronTriggerSource, HostTriggerRequest } from "../../src/domain/workflow-trigger.js";

const encoder = new TextEncoder();

const validSource = (): CronTriggerSource => ({
  kind: "cron",
  schedule: "0 9 * * 1-5",
  timezone: "America/Los_Angeles",
});

const validRequest = (): HostTriggerRequest => ({
  triggerVersion: 1,
  workflow: "change-review",
  cwd: "/absolute/project",
  source: validSource(),
});

const omitField = (value: object, field: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== field));

const requestBytes = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));

const expectInvalidBytes = (bytes: Uint8Array, path?: string, sourcePath?: string): KilinError => {
  try {
    parseHostTriggerRequestBytes(bytes, sourcePath);
    throw new Error("Expected host trigger request parsing to fail");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(KilinError);
    if (!(error instanceof KilinError)) {
      throw error;
    }
    expect(error.code).toBe("OPTION_INVALID");
    if (path !== undefined) {
      expect(error.path).toBe(path);
    }
    return error;
  }
};

const expectInvalidRequest = (value: unknown, path?: string): KilinError =>
  expectInvalidBytes(requestBytes(value), path);

const expectInvalidSource = (value: unknown, path?: string): KilinError => {
  try {
    parseCronTriggerSource(value);
    throw new Error("Expected cron trigger source parsing to fail");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(KilinError);
    if (!(error instanceof KilinError)) {
      throw error;
    }
    expect(error.code).toBe("OPTION_INVALID");
    if (path !== undefined) {
      expect(error.path).toBe(path);
    }
    return error;
  }
};

describe("parseHostTriggerRequestBytes", () => {
  it("accepts the closed v1 contract and normalizes cron whitespace", () => {
    const request = {
      ...validRequest(),
      source: {
        ...validSource(),
        schedule: "\t0   9\t*  *  1-5  ",
      },
    };

    expect(parseHostTriggerRequestBytes(requestBytes(request))).toEqual(validRequest());
  });

  it.each(["triggerVersion", "workflow", "cwd", "source"] as const)(
    "rejects a missing root field %s",
    (field) => {
      expectInvalidRequest(omitField(validRequest(), field), field);
    },
  );

  it.each(["kind", "schedule", "timezone"] as const)(
    "rejects a missing source field %s",
    (field) => {
      expectInvalidRequest(
        {
          ...validRequest(),
          source: omitField(validSource(), field),
        },
        `source.${field}`,
      );
    },
  );

  it("rejects unknown root and source fields", () => {
    expectInvalidRequest({ ...validRequest(), unexpected: true }, "unexpected");
    expectInvalidRequest(
      {
        ...validRequest(),
        source: { ...validSource(), unexpected: true },
      },
      "source.unexpected",
    );
  });

  it.each([
    ["non-object root", null, undefined],
    ["array root", [], undefined],
    ["wrong version", { ...validRequest(), triggerVersion: 2 }, "triggerVersion"],
    ["string version", { ...validRequest(), triggerVersion: "1" }, "triggerVersion"],
    ["uppercase workflow", { ...validRequest(), workflow: "Change-Review" }, "workflow"],
    ["dotted workflow", { ...validRequest(), workflow: "change.review" }, "workflow"],
    ["relative cwd", { ...validRequest(), cwd: "relative/project" }, "cwd"],
    ["cwd with NUL", { ...validRequest(), cwd: "/project\u0000other" }, "cwd"],
    ["non-string cwd", { ...validRequest(), cwd: 42 }, "cwd"],
    [
      "wrong source kind",
      { ...validRequest(), source: { ...validSource(), kind: "timer" } },
      "source.kind",
    ],
  ] as const)("rejects a %s", (_name, value, path) => {
    expectInvalidRequest(value, path);
  });

  it("rejects malformed JSON and identifies the source file", () => {
    const error = expectInvalidBytes(encoder.encode("{"), undefined, "/tmp/trigger.json");
    expect(error.message).toContain("/tmp/trigger.json");
  });

  it.each([
    [
      "duplicate root fields",
      `{"triggerVersion":1,"workflow":"change-review","workflow":"other","cwd":"/absolute/project","source":{"kind":"cron","schedule":"0 9 * * 1-5","timezone":"America/Los_Angeles"}}`,
    ],
    [
      "escaped-equivalent root fields",
      `{"triggerVersion":1,"workflow":"change-review","\\u0077orkflow":"other","cwd":"/absolute/project","source":{"kind":"cron","schedule":"0 9 * * 1-5","timezone":"America/Los_Angeles"}}`,
    ],
    [
      "duplicate nested fields",
      `{"triggerVersion":1,"workflow":"change-review","cwd":"/absolute/project","source":{"kind":"cron","kind":"cron","schedule":"0 9 * * 1-5","timezone":"America/Los_Angeles"}}`,
    ],
  ])("rejects %s", (_name, request) => {
    const error = expectInvalidBytes(encoder.encode(request));
    expect(error.message).toContain("duplicate object fields");
  });

  it("rejects malformed UTF-8 instead of replacing invalid bytes", () => {
    const error = expectInvalidBytes(Uint8Array.of(0xc3, 0x28));
    expect(error.message).toContain("UTF-8");
  });

  it("enforces the inclusive raw 64 KiB limit", () => {
    const source = JSON.stringify(validRequest());
    const padding = " ".repeat(maximumHostTriggerRequestBytes - encoder.encode(source).byteLength);
    const atLimit = encoder.encode(source + padding);
    expect(atLimit.byteLength).toBe(maximumHostTriggerRequestBytes);
    expect(parseHostTriggerRequestBytes(atLimit)).toEqual(validRequest());

    const error = expectInvalidBytes(encoder.encode(`${source}${padding} `));
    expect(error.message).toContain("65536");
  });
});

describe("parseCronTriggerSource", () => {
  it.each(["* * * * *", "59 23 31 12 7", "0,15,30,45 0-23/2 1,15 1-12/3 0,7", "*/5 */2 * * 1-5"])(
    "accepts standard numeric five-field schedule %s",
    (schedule) => {
      expect(parseCronTriggerSource({ ...validSource(), schedule })).toEqual({
        ...validSource(),
        schedule,
      });
    },
  );

  it.each([
    ["four fields", "0 9 * *"],
    ["six fields", "0 9 * * * *"],
    ["macro", "@daily"],
    ["named day", "0 9 * * MON"],
    ["embedded newline", "0 9 *\n* 1"],
    ["minute above range", "60 9 * * *"],
    ["hour above range", "0 24 * * *"],
    ["day-of-month below range", "0 9 0 * *"],
    ["month above range", "0 9 * 13 *"],
    ["day-of-week above range", "0 9 * * 8"],
    ["descending range", "10-5 9 * * *"],
    ["malformed range", "1-2-3 9 * * *"],
    ["empty list member", "0,,5 9 * * *"],
    ["zero step", "*/0 9 * * *"],
    ["step above field range", "*/60 9 * * *"],
    ["step after single value", "5/2 9 * * *"],
    ["missing step", "*/ 9 * * *"],
    ["multiple steps", "*/2/3 9 * * *"],
    ["wildcard in list", "*,15 9 * * *"],
    ["stepped wildcard in list", "*/5,17 9 * * *"],
  ] as const)("rejects %s", (_name, schedule) => {
    expectInvalidSource({ ...validSource(), schedule }, "schedule");
  });

  it.each(["UTC", "America/Los_Angeles", "Asia/Kolkata", "US/Pacific", "Etc/UTC", "Etc/GMT+5"])(
    "accepts and runtime-normalizes recognized IANA timezone %s",
    (timezone) => {
      const normalized = new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions()
        .timeZone;
      expect(parseCronTriggerSource({ ...validSource(), timezone }).timezone).toBe(normalized);
    },
  );

  // The runtime resolves an abbreviation (EST to America/Panama, PST to America/Los_Angeles) as
  // readily as a single-label alias (Japan to Asia/Tokyo), and neither Intl.DateTimeFormat nor
  // Intl.supportedValuesOf can tell them apart, so the request takes Area/Location plus UTC only.
  it.each(["PST", "EST", "Japan", "+05:30", "Mars/Olympus_Mons"])(
    "rejects invalid timezone %s",
    (timezone) => {
      expectInvalidSource({ ...validSource(), timezone }, "timezone");
    },
  );

  it("preserves a stored IANA identifier across runtime canonicalization changes", () => {
    expect(
      parseStoredCronTriggerSource({ ...validSource(), timezone: "Asia/Kolkata" }).timezone,
    ).toBe("Asia/Kolkata");
    expect(
      parseStoredCronTriggerSource({ ...validSource(), timezone: "Europe/Kyiv" }).timezone,
    ).toBe("Europe/Kyiv");
  });

  it("rejects an unrecognized IANA-shaped stored timezone", () => {
    try {
      parseStoredCronTriggerSource({ ...validSource(), timezone: "Mars/Olympus_Mons" });
      throw new Error("Expected stored cron source parsing to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(KilinError);
      expect(error).toMatchObject({ code: "OPTION_INVALID", path: "timezone" });
    }
  });

  it("rejects unknown and missing source fields", () => {
    expectInvalidSource({ ...validSource(), extra: "value" }, "extra");
    expectInvalidSource(omitField(validSource(), "schedule"), "schedule");
    expectInvalidSource(null);
  });

  it("uses a caller-provided subject in errors", () => {
    const error = expectInvalidSource({ ...validSource(), timezone: "PST" }, "timezone");
    expect(error.message).toContain("Trigger source");

    try {
      parseCronTriggerSource({ ...validSource(), timezone: "PST" }, "Stored trigger source");
      throw new Error("Expected stored cron source parsing to fail");
    } catch (storedError: unknown) {
      expect(storedError).toBeInstanceOf(KilinError);
      expect(storedError).toMatchObject({ code: "OPTION_INVALID", path: "timezone" });
      expect((storedError as Error).message).toContain("Stored trigger source");
    }
  });
});
