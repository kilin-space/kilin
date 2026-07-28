export interface StableSemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly text: string;
}

export const parseStableSemanticVersion = (source: string): StableSemanticVersion | undefined => {
  const matches = [
    ...source.matchAll(
      /(?:^|\s)(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?=\s|$)/gu,
    ),
  ];
  const match = matches[0];
  if (matches.length !== 1 || match === undefined || match[4] !== undefined) {
    return undefined;
  }
  const majorSource = match[1];
  const minorSource = match[2];
  const patchSource = match[3];
  if (
    majorSource === undefined ||
    minorSource === undefined ||
    patchSource === undefined ||
    [majorSource, minorSource, patchSource].some(
      (component) => component.length > 1 && component.startsWith("0"),
    )
  ) {
    return undefined;
  }
  const major = Number(majorSource);
  const minor = Number(minorSource);
  const patch = Number(patchSource);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return undefined;
  }
  return { major, minor, patch, text: `${String(major)}.${String(minor)}.${String(patch)}` };
};

export const isVersionAtLeast = (
  version: StableSemanticVersion,
  minimum: StableSemanticVersion,
): boolean =>
  version.major > minimum.major ||
  (version.major === minimum.major &&
    (version.minor > minimum.minor ||
      (version.minor === minimum.minor && version.patch >= minimum.patch)));
