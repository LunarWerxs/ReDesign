import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  filesToUploadImages,
  MAX_UPLOAD_BODY_BYTES,
  MAX_UPLOAD_IMAGE_BYTES,
} from '@/composables/useImageUpload';
import { MAX_ATTACHMENT_CHARS, readTextAttachment } from '@/composables/useTextAttachments';

describe('image attachment preflight', () => {
  const originalFileReader = globalThis.FileReader;

  afterEach(() => {
    globalThis.FileReader = originalFileReader;
  });

  it('rejects an oversized image before allocating a FileReader', async () => {
    const readAsDataURL = vi.fn();
    // The test intentionally throws if construction happens: size checks must run before a
    // base64 buffer is allocated.
    globalThis.FileReader = class {
      constructor() { throw new Error('FileReader must not be allocated'); }
      readAsDataURL = readAsDataURL;
    } as unknown as typeof FileReader;
    const file = new File([new Uint8Array(MAX_UPLOAD_IMAGE_BYTES + 1)], 'large.png', { type: 'image/png' });

    await expect(filesToUploadImages([file])).rejects.toThrow(/too large/i);
    expect(readAsDataURL).not.toHaveBeenCalled();
  });

  it('rejects an aggregate encoded payload before reading any file', async () => {
    globalThis.FileReader = class {
      constructor() { throw new Error('FileReader must not be allocated'); }
    } as unknown as typeof FileReader;
    const rawBytes = MAX_UPLOAD_IMAGE_BYTES - 1;
    const files = [
      new File([new Uint8Array(rawBytes)], 'first.png', { type: 'image/png' }),
      new File([new Uint8Array(rawBytes)], 'second.png', { type: 'image/png' }),
    ];

    await expect(filesToUploadImages(files)).rejects.toThrow(/combined/i);
  });
});

describe('text attachment prefix reads', () => {
  it('reads only the bounded prefix and reports truncation from byte size', async () => {
    const value = 'x'.repeat(MAX_ATTACHMENT_CHARS + 100);
    const file = new File([value], 'large.txt', { type: 'text/plain' });
    const attachment = await readTextAttachment(file);

    expect(attachment.text).toHaveLength(MAX_ATTACHMENT_CHARS);
    expect(attachment.truncated).toBe(true);
  });
});
