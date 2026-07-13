// Small helper for reading dropped/picked/pasted TEXT files (brand style guide
// attachments). Kept deliberately simple per the ticket: text files are read and
// inlined as plain text client-side, no binary/base64 path is needed here (that's
// what useImageUpload.ts is for).

/** A cap per file so one huge text dump can't blow past a model's context. */
export const MAX_ATTACHMENT_CHARS = 20000;

const TEXT_EXTENSIONS = /\.(txt|md|markdown|mdx|csv|json|yaml|yml|xml|html?)$/i;

/** Keep only files that look like plain text (by MIME or extension). */
export function textAttachableFiles(files: FileList | File[] | null | undefined): File[] {
  return [...(files || [])].filter((file) => {
    const type = String(file.type || '').toLowerCase();
    if (type.startsWith('text/')) return true;
    if (!type && TEXT_EXTENSIONS.test(file.name || '')) return true;
    return TEXT_EXTENSIONS.test(file.name || '');
  });
}

/** Pull text files out of a clipboard paste event's data. */
export function clipboardTextFiles(data: DataTransfer | null): File[] {
  const out: File[] = [];
  if (data && data.items) {
    for (const item of data.items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) out.push(file);
      }
    }
  }
  return textAttachableFiles(out.length ? out : data && data.files);
}

export interface TextAttachment {
  name: string;
  text: string;
  truncated: boolean;
}

/** Read a File as plain text, capped to MAX_ATTACHMENT_CHARS. */
export function readTextAttachment(file: File): Promise<TextAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const full = String(reader.result || '');
      const truncated = full.length > MAX_ATTACHMENT_CHARS;
      resolve({ name: file.name || 'attachment.txt', text: truncated ? full.slice(0, MAX_ATTACHMENT_CHARS) : full, truncated });
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read attachment'));
    reader.readAsText(file);
  });
}
