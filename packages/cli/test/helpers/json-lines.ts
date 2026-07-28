import { readFile } from "node:fs/promises";

export const parseJsonLines = <TValue>(source: string): TValue[] =>
  source
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TValue);

export const parseStrictJsonLines = <TValue>(source: string): TValue[] =>
  source
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as TValue);

export const readJsonLines = async <TValue>(path: string): Promise<TValue[]> =>
  parseJsonLines<TValue>(await readFile(path, "utf8"));

export const readStrictJsonLines = async <TValue>(path: string): Promise<TValue[]> =>
  parseStrictJsonLines<TValue>(await readFile(path, "utf8"));
