export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export const canonicalizeJsonValue = (value: unknown): JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new TypeError("JSON numbers must be finite, and JSON integers must be safe integers.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (typeof value === "object") {
    const source = value as Readonly<Record<string, unknown>>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key): [string, JsonValue] => [key, canonicalizeJsonValue(source[key])]),
    );
  }
  throw new TypeError("The value is not valid JSON.");
};

export const parseCanonicalJson = (source: string): JsonValue => {
  const parsed: unknown = JSON.parse(source);
  return canonicalizeJsonValue(parsed);
};

const serializeCanonicalJsonValue = (value: JsonValue): string => {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonicalJsonValue).join(",")}]`;
  }
  const entries = Object.entries(value)
    .sort(([left], [right]) => {
      if (left === right) {
        return 0;
      }
      return left < right ? -1 : 1;
    })
    .map(([key, child]) => `${JSON.stringify(key)}:${serializeCanonicalJsonValue(child)}`);
  return `{${entries.join(",")}}`;
};

export const serializeCanonicalJson = (value: unknown): string =>
  serializeCanonicalJsonValue(canonicalizeJsonValue(value));
