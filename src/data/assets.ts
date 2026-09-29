import { createStore } from "../lib/store";
import { uid } from "../lib/utils";
import { readAsset, readAllAssets, writeAsset } from "./db";
import type { Asset, Id } from "./types";

/** Object URLs for note images, keyed by asset id. Widgets re-render when this changes. */
export const assetUrlStore = createStore<Record<Id, string>>({});
const inflight = new Map<Id, Promise<string | undefined>>();
const meta = new Map<Id, Asset>();

export const ASSET_SCHEME = "asset://";
const ASSET_RE = /asset:\/\/([A-Za-z0-9-]+)/g;

export function assetUrl(id: Id): string | undefined {
  return assetUrlStore.get()[id];
}

export function assetMeta(id: Id): Asset | undefined {
  return meta.get(id);
}

export function ensureAssetUrl(id: Id): Promise<string | undefined> {
  const cached = assetUrlStore.get()[id];
  if (cached) return Promise.resolve(cached);
  const existing = inflight.get(id);
  if (existing) return existing;
  const task = (async () => {
    try {
      const asset = meta.get(id) ?? (await readAsset(id));
      if (!asset) return undefined;
      meta.set(id, asset);
      const url = URL.createObjectURL(asset.blob);
      assetUrlStore.set((prev) => ({ ...prev, [id]: url }));
      return url;
    } catch (error) {
      console.warn("[opennote] 读取图片失败", id, error);
      return undefined;
    } finally {
      inflight.delete(id);
    }
  })();
  inflight.set(id, task);
  return task;
}

export function collectAssetIds(markdown: string): Id[] {
  const ids = new Set<Id>();
  for (const match of markdown.matchAll(ASSET_RE)) ids.add(match[1]);
  return [...ids];
}

export async function preloadAssets(markdown: string): Promise<void> {
  await Promise.all(collectAssetIds(markdown).map((id) => ensureAssetUrl(id)));
}

export async function putAsset(blob: Blob, name: string): Promise<Asset> {
  const asset: Asset = {
    id: uid(),
    name,
    mime: blob.type || "application/octet-stream",
    size: blob.size,
    createdAt: Date.now(),
    blob,
  };
  await writeAsset(asset);
  meta.set(asset.id, asset);
  const url = URL.createObjectURL(asset.blob);
  assetUrlStore.set((prev) => ({ ...prev, [asset.id]: url }));
  return asset;
}

export async function loadAssetIndex(): Promise<number> {
  try {
    const assets = await readAllAssets();
    for (const asset of assets) meta.set(asset.id, asset);
    return assets.length;
  } catch (error) {
    console.warn("[opennote] 图片索引读取失败", error);
    return 0;
  }
}

export function assetBlobSync(id: Id): Blob | undefined {
  return meta.get(id)?.blob;
}

export function findAssetByName(name: string): Asset | undefined {
  const target = name.toLowerCase();
  for (const asset of meta.values()) {
    if (asset.name.toLowerCase() === target) return asset;
  }
  return undefined;
}

/**
 * Turn whatever sits inside `![]()` into something an `<img>` can load:
 * absolute URLs pass through, `asset://id` and relative paths are resolved
 * against the local asset store (that is how imported notes keep their images).
 */
export async function resolveImageSrc(src: string): Promise<string | null> {
  const value = src.trim().replace(/^<|>$/g, "");
  if (!value) return null;
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  if (value.startsWith(ASSET_SCHEME)) {
    return (await ensureAssetUrl(value.slice(ASSET_SCHEME.length))) ?? null;
  }
  const clean = value.replace(/[?#].*$/, "");
  const base = decodeURIComponent(clean.split("/").pop() ?? clean);
  const asset = findAssetByName(base) ?? findAssetByName(clean) ?? findAssetByName(value);
  if (asset) return (await ensureAssetUrl(asset.id)) ?? null;
  return null;
}

/** Everything the user can attach: images, pdfs, anything a `<img src>` cannot show. */
export function isImage(mime: string, name = ""): boolean {
  if (mime.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(name);
}

export function releaseAssetUrls(): void {
  for (const url of Object.values(assetUrlStore.get())) URL.revokeObjectURL(url);
  assetUrlStore.set({});
}
