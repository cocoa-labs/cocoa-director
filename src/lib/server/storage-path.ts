import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Treat persisted storage keys as untrusted too: old records may predate validation. */
export function storagePath(root: string, key: string) {
  let decoded: string;
  try { decoded = decodeURIComponent(key); } catch { throw new Error("Invalid storage path."); }
  if (!decoded || decoded.length > 2048 || isAbsolute(decoded) || /[\\\x00-\x1f%]/.test(decoded) ||
      decoded.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid storage path.");
  }
  const base = resolve(root);
  const path = resolve(base, decoded);
  const suffix = relative(base, path);
  if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error("Storage path escapes its directory.");
  }
  return path;
}

export async function checkedStoragePath(root: string, key: string) {
  const path = storagePath(root, key);
  const base = resolve(root);
  const parts = relative(base, path).split(sep);
  let current = base;
  for (const part of ["", ...parts]) {
    current = resolve(current, part);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) throw new Error("Storage paths cannot contain symbolic links.");
  }
  return path;
}
