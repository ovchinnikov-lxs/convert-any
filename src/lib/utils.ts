import { LocalizedError, t } from '../i18n';

/** Human-readable file size in the current language. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  const units = [t('unit.B'), t('unit.KB'), t('unit.MB'), t('unit.GB')];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** File name without extension. */
export function baseName(name: string) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

/** Decodes an image with the browser (e.g. AVIF/HEIC on Safari) and re-encodes it as PNG. */
export async function browserDecodeToPng(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new LocalizedError('err.decode');
  return new File([blob], `${baseName(file.name)}.png`, { type: 'image/png' });
}

/** Downloads a Blob as a file with the given name. */
export function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
