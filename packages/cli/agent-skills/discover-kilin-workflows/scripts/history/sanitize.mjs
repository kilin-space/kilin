export const maximumStringCharacters = 8_192;
export const maximumArrayItems = 128;
export const maximumObjectFields = 128;
export const maximumNestingDepth = 6;
export const maximumEventBytes = 256 * 1_024;

const exactSensitiveFields = new Set([
  "auth",
  "authentication",
  "authorization",
  "base64",
  "binary",
  "bytes",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "env",
  "environment",
  "header",
  "headers",
  "imagedata",
  "key",
  "privatekey",
  "providerinternal",
  "providermetadata",
  "providerpayload",
  "rawevent",
  "rawpayload",
  "rawprovider",
  "signingkey",
  "sshprivatekey",
]);

export const createSanitizationCounters = () => ({
  excludedFields: 0,
  redactedValues: 0,
  truncatedValues: 0,
});

export const isSensitiveField = (field) => {
  const normalized = field.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return (
    exactSensitiveFields.has(normalized) ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("accesskey") ||
    normalized.endsWith("password") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("signingkey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("headers")
  );
};

const isSensitiveUrlSegment = (segment, previousSegment) => {
  const previous = previousSegment?.toLowerCase() ?? "";
  return (
    /^(?:auth|invite|key|reset|secret|session|token)$/u.test(previous) ||
    /^[A-Za-z0-9_-]{24,}$/u.test(segment)
  );
};

const sanitizeUrl = (source) => {
  try {
    const url = new URL(source);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const segments = url.pathname.split("/");
    url.pathname = segments
      .map((segment, index) =>
        isSensitiveUrlSegment(segment, segments[index - 1]) ? "[redacted]" : segment,
      )
      .join("/");
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
};

export const redactString = (value, projectPath = "") =>
  value
    .slice(0, maximumStringCharacters)
    .replaceAll(projectPath, projectPath.length > 0 ? "[project]" : projectPath)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_-]{8,})\b/giu,
      "[secret]",
    )
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu, "[secret]")
    .replace(/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*/gu, "[private-key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, "Bearer [secret]")
    .replace(
      /\b(password|passwd|secret|token|api[_-]?key|credential)\s*(?::|=|\s)\s*[^\s,;]+/giu,
      "$1=[secret]",
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[email]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/gu, "[personal-id]")
    .replace(
      /(?<!\d)(?:\+\d{1,3}[-. ]?)?(?:\(\d{2,4}\)|\d{2,4})[-. ]\d{3,4}(?:[-. ]\d{3,4})?(?!\d)/gu,
      "[phone]",
    )
    .replace(/\/Users\/[^/\s]+/gu, "[home]")
    .replace(/https?:\/\/[^\s]+/giu, sanitizeUrl);

export const sanitizeValue = (value, projectPath, depth, counters) => {
  if (depth > maximumNestingDepth) {
    counters.truncatedValues += 1;
    return "[depth-limit]";
  }
  if (typeof value === "string") {
    if (value.length > maximumStringCharacters) {
      counters.truncatedValues += 1;
    }
    const bounded = value.slice(0, maximumStringCharacters);
    const sanitized = redactString(value, projectPath);
    if (sanitized !== bounded) {
      counters.redactedValues += 1;
    }
    return sanitized;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > maximumArrayItems) {
      counters.truncatedValues += 1;
    }
    return value
      .slice(0, maximumArrayItems)
      .map((item) => sanitizeValue(item, projectPath, depth + 1, counters))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== "object") {
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length > maximumObjectFields) {
    counters.truncatedValues += 1;
  }
  const sanitized = Object.create(null);
  for (const [key, child] of entries.slice(0, maximumObjectFields)) {
    if (isSensitiveField(key)) {
      counters.excludedFields += 1;
      continue;
    }
    const result = sanitizeValue(child, projectPath, depth + 1, counters);
    if (result !== undefined) {
      sanitized[key] = result;
    }
  }
  return sanitized;
};

const firstText = (value) => {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = firstText(item);
      if (text !== undefined) {
        return text;
      }
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  for (const field of ["text", "message", "value", "content", "result", "output"]) {
    const text = firstText(value[field]);
    if (text !== undefined) {
      return text;
    }
  }
  return undefined;
};

export const sanitizeEvidenceValue = (value, projectPath, counters) => {
  const sanitized = sanitizeValue(value, projectPath, 0, counters);
  if (
    sanitized === undefined ||
    Buffer.byteLength(JSON.stringify(sanitized), "utf8") <= maximumEventBytes
  ) {
    return sanitized;
  }
  counters.truncatedValues += 1;
  return {
    truncated: "[event-size-limit]",
    preview: boundedPreview(firstText(sanitized), maximumStringCharacters),
  };
};

export const boundedPreview = (value, maximumCharacters = 1_024) => {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.slice(0, maximumCharacters);
};
