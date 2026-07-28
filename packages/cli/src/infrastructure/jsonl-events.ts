export type JsonRecord = Record<string, unknown>;

export const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseJsonlEvents = (stdout: string, invalidObjectMessage: string): JsonRecord[] => {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  return lines.map((line) => {
    const event: unknown = JSON.parse(line);
    if (!isJsonRecord(event)) {
      throw new Error(invalidObjectMessage);
    }
    return event;
  });
};
