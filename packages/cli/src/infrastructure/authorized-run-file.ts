import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const isPathInside = (parent: string, child: string): boolean =>
  child.startsWith(`${parent}${sep}`);

export const openAuthorizedRunFile = async (
  dataDirectory: string,
  path: string,
): Promise<FileHandle | undefined> => {
  const resolvedDataDirectory = resolve(dataDirectory);
  const resolvedPath = resolve(path);
  if (!isPathInside(resolvedDataDirectory, resolvedPath)) {
    return undefined;
  }

  const ancestors: string[] = [];
  let current = dirname(resolvedPath);
  while (current !== resolvedDataDirectory) {
    if (!isPathInside(resolvedDataDirectory, current)) {
      return undefined;
    }
    ancestors.push(current);
    current = dirname(current);
  }
  ancestors.push(resolvedDataDirectory);

  let handle: FileHandle | undefined;
  try {
    for (const directory of ancestors) {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        return undefined;
      }
    }
    const metadata = await lstat(resolvedPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      return undefined;
    }
    const canonicalDataDirectory = await realpath(resolvedDataDirectory);
    const canonicalPath = await realpath(resolvedPath);
    if (!isPathInside(canonicalDataDirectory, canonicalPath)) {
      return undefined;
    }

    handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      openedMetadata.nlink !== 1 ||
      openedMetadata.dev !== metadata.dev ||
      openedMetadata.ino !== metadata.ino
    ) {
      await handle.close();
      return undefined;
    }
    const authorizedHandle = handle;
    handle = undefined;
    return authorizedHandle;
  } catch {
    await handle?.close().catch(() => undefined);
    return undefined;
  }
};
