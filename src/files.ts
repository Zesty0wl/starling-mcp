import { constants } from "node:fs";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";

const UPLOAD_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
};

const EXTENSION_FOR_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "application/pdf": ".pdf",
  "text/csv": ".csv",
};

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function expand(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * Reads a local file for upload to Starling. Only receipt-like files
 * (images and PDFs) are allowed, so the tool cannot be used to send
 * arbitrary local files (keys, configs) off the machine.
 */
export async function readUploadFile(
  path: string,
  allowPdf = true,
): Promise<{ data: Buffer; contentType: string; name: string }> {
  const full = resolve(expand(path));
  const contentType = UPLOAD_TYPES[extname(full).toLowerCase()];
  if (!contentType || (!allowPdf && contentType === "application/pdf")) {
    const allowed = Object.keys(UPLOAD_TYPES).filter((e) => allowPdf || e !== ".pdf");
    throw new Error(`Only ${allowed.join(", ")} files can be uploaded`);
  }
  const st = await stat(full);
  if (!st.isFile()) throw new Error(`${full} is not a regular file`);
  if (st.size > MAX_UPLOAD_BYTES) throw new Error(`${full} is larger than 10 MB`);
  return { data: await readFile(full), contentType, name: basename(full) };
}

export function extensionFor(contentType: string): string {
  return EXTENSION_FOR_TYPE[contentType] ?? ".bin";
}

/**
 * Writes downloaded bank data with owner-only permissions and never
 * overwrites an existing file. Relative paths resolve inside downloadDir.
 */
export async function saveDownload(downloadDir: string, fileName: string, data: Buffer | string): Promise<string> {
  const target = isAbsolute(expand(fileName)) ? expand(fileName) : join(downloadDir, fileName);
  const dir = resolve(target, "..");
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const ext = extname(target);
  const stem = target.slice(0, target.length - ext.length);
  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? target : `${stem} (${n})${ext}`;
    try {
      const handle = await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        await handle.writeFile(data);
      } finally {
        await handle.close();
      }
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`Could not find a free file name for ${target}`);
}
