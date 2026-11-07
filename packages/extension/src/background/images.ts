import type { ImageMediaType } from "@agent-browser/protocol";

export interface StoredImage {
  id: string;
  data: string;
  mediaType: ImageMediaType;
  width: number;
  height: number;
}

const MAX_IMAGES = 40;
const images = new Map<string, StoredImage>();

/** Keep recent screenshots so upload_image can refer to them by ID. */
export function storeImage(img: Omit<StoredImage, "id">): StoredImage {
  const id = `ss_${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`;
  const stored = { ...img, id };
  images.set(id, stored);
  while (images.size > MAX_IMAGES) images.delete(images.keys().next().value!);
  return stored;
}

export function getImage(id: string): StoredImage | undefined {
  return images.get(id);
}
