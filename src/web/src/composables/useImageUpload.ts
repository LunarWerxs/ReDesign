import type { UploadImage } from '@/types';

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

/** Convert accepted files into the upload payload shape. */
export async function filesToUploadImages(files: File[], source = 'screenshot'): Promise<UploadImage[]> {
  return Promise.all(
    files.map(async (file, i) => ({
      name: file.name || `${source}-${i + 1}.png`,
      mime: file.type || '',
      data: await readFileAsDataURL(file),
    })),
  );
}
