// Before upload, a large phone photo is scaled down on the phone (longest side 2048 px) so it travels quickly. This is
// only for speed: the engine still decodes, re-encodes and strips ALL metadata itself (engine/src/photos.ts) -- the
// browser is never trusted to have done it.
const MAX = 2048;

const toDataUrl = (b: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('could not read that file'));
    r.readAsDataURL(b);
  });

export async function photoForUpload(file: File): Promise<string> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 4_000_000) return toDataUrl(file);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
    return toDataUrl(blob ?? file);
  } catch {
    return toDataUrl(file); // the engine decides whether it can use it
  }
}
