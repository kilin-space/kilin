import { isAbsolute } from "node:path";

import { parseDocument } from "yaml";

import { KilinError } from "./errors.js";
import { isWorkflowKebabId } from "./workflow-package.js";

export const maximumHostTriggerRequestBytes = 65_536;

export interface CronTriggerSource {
  readonly kind: "cron";
  readonly schedule: string;
  readonly timezone: string;
}

export interface HostTriggerRequest {
  readonly triggerVersion: 1;
  readonly workflow: string;
  readonly cwd: string;
  readonly source: CronTriggerSource;
}

interface CronField {
  readonly name: string;
  readonly minimum: number;
  readonly maximum: number;
}

const requestFields = new Set(["triggerVersion", "workflow", "cwd", "source"]);
const cronSourceFields = new Set(["kind", "schedule", "timezone"]);
const cronFields: readonly CronField[] = [
  { name: "minute", minimum: 0, maximum: 59 },
  { name: "hour", minimum: 0, maximum: 23 },
  { name: "day-of-month", minimum: 1, maximum: 31 },
  { name: "month", minimum: 1, maximum: 12 },
  { name: "day-of-week", minimum: 0, maximum: 7 },
];
const decimalPattern = /^\d+$/u;
const ianaTimezonePattern = /^[A-Za-z._+-]+(?:\/[A-Za-z0-9._+-]+)+$/u;
const decoder = new TextDecoder("utf-8", { fatal: true });

const invalid = (message: string, path?: string): never => {
  throw new KilinError(
    "OPTION_INVALID",
    `${message} Correct the trigger request and try again.`,
    path,
  );
};

const childPath = (path: string, field: string): string =>
  path.length === 0 ? field : `${path}.${field}`;

const recordAt = (
  value: unknown,
  subject: string,
  path: string,
): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`${subject} must be an object.`, path.length === 0 ? undefined : path);
  }
  return value as Readonly<Record<string, unknown>>;
};

const closedRecordAt = (
  value: unknown,
  allowedFields: ReadonlySet<string>,
  subject: string,
  path: string,
): Readonly<Record<string, unknown>> => {
  const record = recordAt(value, subject, path);
  const unknownField = Object.keys(record).find((field) => !allowedFields.has(field));
  if (unknownField !== undefined) {
    invalid(
      `${subject} declares unsupported field "${unknownField}". Remove that field.`,
      childPath(path, unknownField),
    );
  }
  return record;
};

const required = (
  record: Readonly<Record<string, unknown>>,
  field: string,
  subject: string,
  path: string,
): unknown => {
  if (!Object.hasOwn(record, field)) {
    invalid(`${subject} is missing required field "${field}".`, childPath(path, field));
  }
  return record[field];
};

const rejectDuplicateJsonFields = (text: string, subject: string): void => {
  let duplicate = false;
  try {
    duplicate = parseDocument(text, {
      schema: "json",
      strict: true,
      uniqueKeys: true,
    }).errors.some(({ code }) => code === "DUPLICATE_KEY");
  } catch {
    return invalid(`${subject} could not be checked for duplicate object fields.`);
  }
  if (duplicate) {
    invalid(`${subject} must not contain duplicate object fields.`);
  }
};

const cronNumber = (
  value: string,
  field: CronField,
  subject: string,
  schedulePath: string,
): number => {
  if (!decimalPattern.test(value)) {
    return invalid(`${subject} ${field.name} values must use decimal integers.`, schedulePath);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < field.minimum || number > field.maximum) {
    return invalid(
      `${subject} ${field.name} values must be from ${String(field.minimum)} through ${String(field.maximum)}.`,
      schedulePath,
    );
  }
  return number;
};

const validateCronBase = (
  value: string,
  field: CronField,
  subject: string,
  schedulePath: string,
): void => {
  if (value === "*") {
    return;
  }
  const range = value.split("-");
  const [startText, endText] = range;
  if (range.length === 1 && startText !== undefined) {
    cronNumber(startText, field, subject, schedulePath);
    return;
  }
  if (range.length !== 2 || startText === undefined || endText === undefined) {
    return invalid(`${subject} ${field.name} range is malformed.`, schedulePath);
  }
  const start = cronNumber(startText, field, subject, schedulePath);
  const end = cronNumber(endText, field, subject, schedulePath);
  if (start > end) {
    invalid(`${subject} ${field.name} ranges must start at or before their end.`, schedulePath);
  }
};

const validateCronItem = (
  value: string,
  field: CronField,
  subject: string,
  schedulePath: string,
): void => {
  const [base, stepText, ...extraSteps] = value.split("/");
  if (base === undefined || base.length === 0 || extraSteps.length > 0 || stepText?.length === 0) {
    return invalid(`${subject} ${field.name} step is malformed.`, schedulePath);
  }
  validateCronBase(base, field, subject, schedulePath);
  if (stepText === undefined) {
    return;
  }
  if (base !== "*" && !base.includes("-")) {
    invalid(`${subject} ${field.name} steps may follow only a wildcard or range.`, schedulePath);
  }
  if (!decimalPattern.test(stepText)) {
    invalid(`${subject} ${field.name} step must be a decimal integer.`, schedulePath);
  }
  const step = Number(stepText);
  if (!Number.isSafeInteger(step) || step < 1 || step > field.maximum) {
    invalid(
      `${subject} ${field.name} step must be from 1 through ${String(field.maximum)}.`,
      schedulePath,
    );
  }
};

const normalizeCronSchedule = (value: unknown, subject: string, schedulePath: string): string => {
  if (typeof value !== "string" || /[^0-9*,/ \t-]/u.test(value)) {
    return invalid(`${subject} schedule must contain only five numeric cron fields.`, schedulePath);
  }
  const trimmed = value.replace(/^[ \t]+|[ \t]+$/gu, "");
  const values = trimmed.length === 0 ? [] : trimmed.split(/[ \t]+/u);
  if (values.length !== cronFields.length) {
    return invalid(
      `${subject} schedule must contain exactly five numeric cron fields.`,
      schedulePath,
    );
  }

  values.forEach((fieldValue, index) => {
    const field = cronFields[index];
    if (field === undefined) {
      return invalid(`${subject} schedule contains an unexpected field.`, schedulePath);
    }
    const items = fieldValue.split(",");
    if (items.some((item) => item.length === 0)) {
      invalid(`${subject} ${field.name} list is malformed.`, schedulePath);
    }
    if (items.length > 1 && items.some((item) => item === "*" || item.startsWith("*/"))) {
      invalid(
        `${subject} ${field.name} list cannot combine a wildcard with other entries.`,
        schedulePath,
      );
    }
    items.forEach((item) => validateCronItem(item, field, subject, schedulePath));
  });
  return values.join(" ");
};

const timezoneIdentifier = (
  value: unknown,
  subject: string,
  timezonePath: string,
  normalize: boolean,
): string => {
  if (
    typeof value !== "string" ||
    (value !== "UTC" &&
      (!ianaTimezonePattern.test(value) ||
        value.split("/").some((component) => component === "." || component === "..")))
  ) {
    return invalid(
      `${subject} timezone must be an Area/Location IANA timezone identifier such as "Asia/Tokyo", or "UTC".`,
      timezonePath,
    );
  }
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return invalid(
      `${subject} timezone must be an IANA timezone identifier recognized by this runtime.`,
      timezonePath,
    );
  }
  return normalize ? canonical : value;
};

const parseCronTriggerSourceAt = (
  value: unknown,
  subject: string,
  path: string,
  normalizeTimezone: boolean,
): CronTriggerSource => {
  const source = closedRecordAt(value, cronSourceFields, subject, path);
  if (required(source, "kind", subject, path) !== "cron") {
    invalid(`${subject} kind must be "cron".`, childPath(path, "kind"));
  }
  return {
    kind: "cron",
    schedule: normalizeCronSchedule(
      required(source, "schedule", subject, path),
      subject,
      childPath(path, "schedule"),
    ),
    timezone: timezoneIdentifier(
      required(source, "timezone", subject, path),
      subject,
      childPath(path, "timezone"),
      normalizeTimezone,
    ),
  };
};

export const parseCronTriggerSource = (
  value: unknown,
  subject = "Trigger source",
): CronTriggerSource => parseCronTriggerSourceAt(value, subject, "", true);

export const parseStoredCronTriggerSource = (
  value: unknown,
  subject = "Stored trigger source",
): CronTriggerSource => parseCronTriggerSourceAt(value, subject, "", false);

export const parseHostTriggerRequestBytes = (
  bytes: Uint8Array,
  sourcePath?: string,
): HostTriggerRequest => {
  const subject =
    sourcePath === undefined ? "Host trigger request" : `Host trigger request "${sourcePath}"`;
  if (bytes.byteLength > maximumHostTriggerRequestBytes) {
    return invalid(`${subject} exceeds the ${String(maximumHostTriggerRequestBytes)} byte limit.`);
  }

  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return invalid(`${subject} is not valid UTF-8.`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return invalid(`${subject} must contain exactly one valid JSON object.`);
  }
  rejectDuplicateJsonFields(text, subject);

  const request = closedRecordAt(value, requestFields, subject, "");
  if (required(request, "triggerVersion", subject, "") !== 1) {
    invalid(`${subject} triggerVersion must be 1.`, "triggerVersion");
  }
  const workflow = required(request, "workflow", subject, "");
  if (typeof workflow !== "string" || !isWorkflowKebabId(workflow)) {
    return invalid(
      `${subject} workflow must contain 1 through 64 lowercase ASCII letters, digits, or single hyphen-separated segments.`,
      "workflow",
    );
  }
  const cwd = required(request, "cwd", subject, "");
  if (typeof cwd !== "string" || cwd.includes("\u0000") || !isAbsolute(cwd)) {
    return invalid(`${subject} cwd must be an absolute path.`, "cwd");
  }

  return {
    triggerVersion: 1,
    workflow,
    cwd,
    source: parseCronTriggerSourceAt(
      required(request, "source", subject, ""),
      `${subject} source`,
      "source",
      true,
    ),
  };
};
