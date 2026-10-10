// Development adapter only. Production adapters never import this module.
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { StorageObject, StorageObjectInfo } from "./storage.ts";

function location(root: string, visibility: string, key: string): string {
  const base = resolve(root, visibility);
  const path = resolve(base, key);
  if (!path.startsWith(base + sep)) throw new Error("Invalid storage key");
  return path;
}
export async function localPut(root: string, visibility: string, key: string, bytes: Uint8Array, contentType: string, overwrite: boolean): Promise<void> {
  const path = location(root, visibility, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: overwrite ? "w" : "wx" });
  await writeFile(path + ".metadata.json", JSON.stringify({ contentType, size: bytes.byteLength }));
}
export async function localGet(root: string, visibility: string, key: string): Promise<StorageObject | null> {
  const path = location(root, visibility, key);
  try {
    const bytes = new Uint8Array(await readFile(path));
    const meta: { contentType: string } = JSON.parse(await readFile(path + ".metadata.json", "utf8"));
    return { key, contentType: meta.contentType, size: bytes.byteLength, provider: "local", body: new Blob([bytes]).stream() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export async function localDelete(root: string, visibility: string, key: string): Promise<void> {
  const path = location(root, visibility, key);
  await Promise.all([path, path + ".metadata.json"].map(async name => {
    try { await unlink(name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }));
}
export async function localList(root: string, visibility: string, prefix: string): Promise<StorageObjectInfo[]> {
  const base = resolve(root, visibility);
  const items: StorageObjectInfo[] = [];
  async function walk(directory: string, pathPrefix = ""): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const key = pathPrefix + entry.name;
      if (entry.isDirectory()) await walk(resolve(directory, entry.name), key + "/");
      else if (entry.isFile() && !key.endsWith(".metadata.json") && key.startsWith(prefix)) {
        const meta: { contentType: string; size: number } = JSON.parse(await readFile(resolve(directory, entry.name) + ".metadata.json", "utf8"));
        items.push({ key, ...meta, provider: "local" });
      }
    }
  }
  await walk(base);
  return items;
}
