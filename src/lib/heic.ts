import { LocalizedError } from '../i18n';
import { baseName } from './utils';

/** File extensions used for HEIC/HEIF images (iPhone photos and other HEIF cameras). */
export const HEIC_EXTENSIONS = ['heic', 'heif', 'hif'];

/** ISO-BMFF brands of HEIF images (AVIF uses its own brands and is not included). */
const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'];

/**
 * Detects HEIC/HEIF by content, not only by name: files from some apps or
 * messengers keep the HEIC data under a .jpg name or without an extension.
 */
export async function isHeic(file: Blob & { name?: string }): Promise<boolean> {
  const ext = file.name?.split('.').pop()?.toLowerCase() ?? '';
  if (HEIC_EXTENSIONS.includes(ext)) return true;
  if (file.type === 'image/heic' || file.type === 'image/heif') return true;
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const ascii = String.fromCharCode(...head);
  if (ascii.slice(4, 8) !== 'ftyp') return false;
  // Major brand plus the compatible brands that follow it.
  for (let i = 8; i + 4 <= head.length; i += 4) {
    if (i === 12) continue; // minor version, not a brand
    if (HEIF_BRANDS.includes(ascii.slice(i, i + 4))) return true;
  }
  return false;
}

/**
 * Decodes a HEIC/HEIF image into a lossless PNG with libheif (WebAssembly),
 * so it works in every browser, not only Safari. Rotation stored in the file
 * is applied. The decoder (~3 MB) is loaded only when a HEIC file shows up.
 */
export async function heicToPng(file: File): Promise<File> {
  const { heicTo } = await import('heic-to/csp');
  try {
    const png = await heicTo({ blob: file, type: 'image/png' });
    return new File([png], `${baseName(file.name)}.png`, { type: 'image/png' });
  } catch (e) {
    throw new LocalizedError('err.heic', { detail: (e as Error)?.message ?? String(e) });
  }
}
