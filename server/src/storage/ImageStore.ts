import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ImageInfo } from '@glcm/api';
import { compress, type ContentEncoding } from '../encoding.js';

const ID_PATTERN = /^img_[0-9a-f]{32}$/;

export function newImageId(): string {
  return `img_${randomUUID().replaceAll('-', '')}`;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

interface CachedPixels {
  pixels: Promise<Buffer>;
  /** Size once read; 0 while reading */
  bytes: number;
}

/**
 * Images on local disk (doc/ui-design-plan.md, section 8.2). Each image has a folder images/<id>/ with
 * - original: the uploaded file
 * - pixels.bin: row-major grayscale samples, 16-bit samples little-endian; the slices of a stack one after the other
 * - pixels.bin.<gzip|zstd>: compressed copies, created on first request (pixels.<slice>.bin.<gzip|zstd> for a slice of a stack)
 * - info.json: ImageInfo
 *
 * Pixel buffers of recently used images (or slices of stacks) are kept in memory, up to pixelCacheBytes, so ROI
 * statistics requests sent while ROIs are edited do not read the whole file each time. Requests for the same pixels
 * share one read.
 */
export class ImageStore {
  readonly imagesDir: string;
  readonly uploadsDir: string;
  private readonly pendingCompressions = new Map<string, Promise<Buffer>>();
  /** Least recently used first */
  private readonly cachedPixels = new Map<string, CachedPixels>();
  private cachedBytes = 0;

  /** pixelCacheBytes 0 disables the pixel cache */
  constructor(
    dataDir: string,
    private readonly pixelCacheBytes = 0,
  ) {
    this.imagesDir = path.join(dataDir, 'images');
    this.uploadsDir = path.join(dataDir, 'uploads');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.imagesDir, { recursive: true });
    // Leftovers of interrupted uploads
    await fs.rm(this.uploadsDir, { recursive: true, force: true });
    await fs.mkdir(this.uploadsDir, { recursive: true });
  }

  /** Path for streaming an upload before it is decoded */
  temporaryUploadPath(): string {
    return path.join(this.uploadsDir, `${randomUUID()}.upload`);
  }

  private folder(id: string): string {
    if (!ID_PATTERN.test(id)) {
      throw new Error(`Invalid image id: ${id}`);
    }
    return path.join(this.imagesDir, id);
  }

  async save(info: ImageInfo, pixels: Buffer, uploadPath: string): Promise<void> {
    const folder = this.folder(info.imageId);
    await fs.mkdir(folder);
    await fs.rename(uploadPath, path.join(folder, 'original'));
    await fs.writeFile(path.join(folder, 'pixels.bin'), pixels);
    await fs.writeFile(path.join(folder, 'info.json'), JSON.stringify(info));
  }

  async info(id: string): Promise<ImageInfo | undefined> {
    try {
      const info = JSON.parse(await fs.readFile(path.join(this.folder(id), 'info.json'), 'utf8')) as ImageInfo;
      // Images stored before pixel spacing or stacks were read have no field
      return { ...info, pixelSpacing: info.pixelSpacing ?? null, slices: info.slices ?? 1 };
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * The samples of one slice (from 1) of an image, possibly shared with other requests: callers must not modify the
   * buffer. For a single image, the whole of pixels.bin.
   */
  pixels(image: string | Pick<ImageInfo, 'imageId' | 'width' | 'height' | 'bitDepth' | 'slices'>, slice = 1): Promise<Buffer> {
    // An id stands for a single image
    const info = typeof image === 'string' ? { imageId: image, width: 0, height: 0, bitDepth: 8 as const, slices: 1 } : image;
    const file = path.join(this.folder(info.imageId), 'pixels.bin');
    const stack = (info.slices ?? 1) > 1;
    if (slice < 1 || slice > (info.slices ?? 1)) {
      return Promise.reject(new Error(`Slice ${slice} is outside the image's ${info.slices ?? 1} slices`));
    }
    const read = stack ? () => this.readSlice(file, info, slice) : () => fs.readFile(file);
    if (this.pixelCacheBytes === 0) {
      return read();
    }

    const key = stack ? `${info.imageId}#${slice}` : info.imageId;
    const cached = this.cachedPixels.get(key);
    if (cached) {
      this.cachedPixels.delete(key);
      this.cachedPixels.set(key, cached);
      return cached.pixels;
    }

    const entry: CachedPixels = { pixels: read(), bytes: 0 };
    this.cachedPixels.set(key, entry);
    entry.pixels.then(
      (pixels) => {
        // The image may have been removed while reading
        if (this.cachedPixels.get(key) === entry) {
          entry.bytes = pixels.length;
          this.cachedBytes += pixels.length;
          this.evictPixels();
        }
      },
      () => {
        if (this.cachedPixels.get(key) === entry) {
          this.cachedPixels.delete(key);
        }
      },
    );
    return entry.pixels;
  }

  private async readSlice(file: string, info: Pick<ImageInfo, 'width' | 'height' | 'bitDepth'>, slice: number): Promise<Buffer> {
    const length = info.width * info.height * (info.bitDepth / 8);
    const buffer = Buffer.alloc(length);
    const handle = await fs.open(file, 'r');
    try {
      const { bytesRead } = await handle.read(buffer, 0, length, (slice - 1) * length);
      if (bytesRead !== length) {
        throw new Error(`pixels.bin of image ${(info as ImageInfo).imageId} is shorter than its slices`);
      }
    } finally {
      await handle.close();
    }
    return buffer;
  }

  /** Bytes of pixel buffers held in memory */
  get pixelCacheSize(): number {
    return this.cachedBytes;
  }

  private evictPixels(): void {
    for (const [id, entry] of this.cachedPixels) {
      if (this.cachedBytes <= this.pixelCacheBytes) {
        break;
      }
      // Reads still in progress are not counted yet
      if (entry.bytes > 0) {
        this.forgetPixels(id);
      }
    }
  }

  /** Forgets a cached buffer by key, or every buffer of an image (its slices too) by image id */
  private forgetPixels(key: string): void {
    for (const [cachedKey, entry] of this.cachedPixels) {
      if (cachedKey === key || (!key.includes('#') && cachedKey.startsWith(`${key}#`))) {
        this.cachedBytes -= entry.bytes;
        this.cachedPixels.delete(cachedKey);
      }
    }
  }

  /** One sample of a slice (from 1), read from pixels.bin without loading the whole image */
  async pixelValue(info: ImageInfo, x: number, y: number, slice = 1): Promise<number> {
    const bytesPerSample = info.bitDepth / 8;
    const buffer = Buffer.alloc(bytesPerSample);
    const handle = await fs.open(path.join(this.folder(info.imageId), 'pixels.bin'), 'r');
    try {
      await handle.read(buffer, 0, bytesPerSample, ((slice - 1) * info.width * info.height + y * info.width + x) * bytesPerSample);
    } finally {
      await handle.close();
    }
    return bytesPerSample === 2 ? buffer.readUInt16LE(0) : buffer.readUInt8(0);
  }

  /** The samples of a slice in the given encoding; compressed copies are created once and reused */
  async encodedPixels(info: ImageInfo, encoding: ContentEncoding, slice = 1): Promise<Buffer> {
    const folder = this.folder(info.imageId);
    if (encoding === 'identity') {
      return this.pixels(info, slice);
    }

    const target = path.join(folder, info.slices > 1 ? `pixels.${slice}.bin.${encoding}` : `pixels.bin.${encoding}`);
    try {
      return await fs.readFile(target);
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }

    let pending = this.pendingCompressions.get(target);
    if (!pending) {
      pending = (async () => {
        const compressed = await compress(await this.pixels(info, slice), encoding);
        const temporary = `${target}.${randomUUID()}.tmp`;
        await fs.writeFile(temporary, compressed);
        await fs.rename(temporary, target);
        return compressed;
      })().finally(() => this.pendingCompressions.delete(target));
      this.pendingCompressions.set(target, pending);
    }
    return pending;
  }

  /** Path of the uploaded file */
  originalPath(id: string): string {
    return path.join(this.folder(id), 'original');
  }

  /** Every stored image, newest first */
  async list(): Promise<ImageInfo[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.imagesDir);
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }
    const infos = await Promise.all(names.filter((name) => ID_PATTERN.test(name)).map((name) => this.info(name)));
    return infos.filter((info): info is ImageInfo => info !== undefined).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Removes an image; false if it did not exist */
  async remove(id: string): Promise<boolean> {
    const folder = this.folder(id);
    this.forgetPixels(id);
    try {
      await fs.access(folder);
    } catch {
      return false;
    }
    await fs.rm(folder, { recursive: true, force: true });
    return true;
  }
}
