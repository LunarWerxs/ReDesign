import type { UploadImage } from '@/types';

/** Server defaults, used only by a direct helper caller and older daemons without /limits. */
export const MAX_UPLOAD_BODY_BYTES = 40 * 1024 * 1024;
export const MAX_UPLOAD_IMAGE_BYTES = 20 * 1024 * 1024;
const READ_CONCURRENCY = 2;

export interface UploadLimits {
  bodyLimitBytes: number;
  imageLimitBytes: number;
}

export const UPLOAD_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
]);

/** Keep only files that are an accepted image type (by MIME or extension). */
export function uploadableImageFiles(files: FileList | File[] | null | undefined): File[] {
  return [...(files || [])].filter((file) => {
    const type = String(file.type || '').toLowerCase();
    return UPLOAD_IMAGE_TYPES.has(type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name || '');
  });
}

/** Pull image files out of a clipboard paste event's data. */
export function clipboardImageFiles(data: DataTransfer | null): File[] {
  const out: File[] = [];
  if (data && data.items) {
    for (const item of data.items) {
      if (item.kind === 'file' && String(item.type || '').startsWith('image/')) {
        const file = item.getAsFile();
        if (file) out.push(file);
      }
    }
  }
  return uploadableImageFiles(out.length ? out : data && data.files);
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read image'));
    reader.readAsDataURL(file);
  });
}

function encodedDataUrlBytes(file: File): number {
  const mime = file.type || 'application/octet-stream';
  return `data:${mime};base64,`.length + Math.ceil(file.size / 3) * 4;
}

/** Reject payloads the daemon cannot accept before FileReader allocates a base64 string. */
export function assertUploadFits(files: File[], limits: UploadLimits = {
  bodyLimitBytes: MAX_UPLOAD_BODY_BYTES,
  imageLimitBytes: MAX_UPLOAD_IMAGE_BYTES,
}): void {
  let encodedBytes = 14; // {"images":[]} plus a little JSON punctuation per item below.
  for (const file of files) {
    if (file.size > limits.imageLimitBytes) {
      throw new Error(`${file.name || 'Image'} is too large. Maximum is ${Math.floor(limits.imageLimitBytes / 1024 / 1024)} MiB.`);
    }
    // Name/mime JSON escaping is tiny relative to the binary payload, but include a conservative
    // fixed allowance so an exactly-at-limit request never slips through client preflight.
    encodedBytes += encodedDataUrlBytes(file) + file.name.length * 2 + file.type.length * 2 + 128;
    if (encodedBytes > limits.bodyLimitBytes) {
      throw new Error(`The combined image upload is too large after ${file.name || 'this image'}. Add fewer images at once.`);
    }
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index], index);
    }
  }));
  return results;
}

/** Convert accepted files into the upload payload shape. */
export async function filesToUploadImages(
  files: File[],
  source = 'screenshot',
  limits?: UploadLimits,
): Promise<UploadImage[]> {
  assertUploadFits(files, limits);
  return mapWithConcurrency(files, READ_CONCURRENCY, async (file, i) => ({
      name: file.name || `${source}-${i + 1}.png`,
      mime: file.type || '',
      data: await readFileAsDataURL(file),
    }));
}
