import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const isPathInside = (parent: string, child: string): boolean => {
  const remainder = relative(parent, child);
  return (
    remainder.length > 0 &&
    remainder !== ".." &&
    !remainder.startsWith(`..${sep}`) &&
    !isAbsolute(remainder)
  );
};

export const isWorkspaceArtifactValid = async (
  canonicalWorkingDirectory: string,
  artifactPath: string,
): Promise<boolean> => {
  const resolvedWorkingDirectory = resolve(canonicalWorkingDirectory);
  const resolvedArtifactPath = resolve(resolvedWorkingDirectory, artifactPath);
  if (!isPathInside(resolvedWorkingDirectory, resolvedArtifactPath)) {
    return false;
  }

  try {
    const canonicalWorkspace = await realpath(resolvedWorkingDirectory);
    const metadata = await lstat(resolvedArtifactPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      return false;
    }
    const canonicalArtifactPath = await realpath(resolvedArtifactPath);
    if (!isPathInside(canonicalWorkspace, canonicalArtifactPath)) {
      return false;
    }

    const currentMetadata = await lstat(resolvedArtifactPath);
    return (
      currentMetadata.isFile() &&
      !currentMetadata.isSymbolicLink() &&
      currentMetadata.nlink === 1 &&
      currentMetadata.dev === metadata.dev &&
      currentMetadata.ino === metadata.ino
    );
  } catch {
    return false;
  }
};
