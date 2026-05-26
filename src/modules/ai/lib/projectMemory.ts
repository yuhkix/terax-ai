import { native } from "./native";

const TERAX_MD_MAX_BYTES = 32 * 1024;
const TTL_MS = 30_000;

type MemoryCacheEntry = { content: string | null; mtime: number };

const cache = new Map<string, MemoryCacheEntry>();

export async function readTeraxMd(workspaceRoot: string | null): Promise<string | null> {
  if (!workspaceRoot) return null;
  const cached = cache.get(workspaceRoot);
  if (cached && Date.now() - cached.mtime < TTL_MS) return cached.content;
  const path = `${workspaceRoot.replace(/\/$/, "")}/TERAX.md`;
  try {
    const r = await native.readFile(path);
    if (r.kind !== "text") {
      cache.set(workspaceRoot, { content: null, mtime: Date.now() });
      return null;
    }
    const content =
      r.content.length > TERAX_MD_MAX_BYTES
        ? r.content.slice(0, TERAX_MD_MAX_BYTES)
        : r.content;
    cache.set(workspaceRoot, { content, mtime: Date.now() });
    return content;
  } catch {
    cache.set(workspaceRoot, { content: null, mtime: Date.now() });
    return null;
  }
}
