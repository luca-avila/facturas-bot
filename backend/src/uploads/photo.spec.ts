import { gif, heic, jpeg, png, sha256, webp } from '../../test/photos.js';
import { inspectPhoto } from './photo.js';

describe('inspectPhoto', () => {
  it.each([
    ['a JPEG', jpeg({ width: 1650, height: 2200 }), 'image/jpeg', 'jpg'],
    ['a PNG', png({ width: 1200, height: 900 }), 'image/png', 'png'],
    ['a WebP', webp({ width: 801, height: 1203 }), 'image/webp', 'webp'],
  ])('reads %s', (_, bytes, mimeType, extension) => {
    const sizes: Record<string, [number, number]> = {
      jpg: [1650, 2200],
      png: [1200, 900],
      webp: [801, 1203],
    };
    const [width, height] = sizes[extension];
    expect(inspectPhoto(bytes)).toEqual({
      mimeType,
      extension,
      width,
      height,
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
    });
  });

  it('swaps the sizes for orientation 6', () => {
    const photo = inspectPhoto(
      jpeg({ width: 2200, height: 1650, orientation: 6 }),
    );
    expect(photo).toMatchObject({ width: 1650, height: 2200 });
  });

  it.each([
    ['orientation 1', 1],
    ['orientation 9, which isn’t one', 9],
  ])('keeps the sizes for %s', (_, orientation) => {
    const photo = inspectPhoto(
      jpeg({ width: 2200, height: 1650, orientation }),
    );
    expect(photo).toMatchObject({ width: 2200, height: 1650 });
  });

  it('never changes the bytes', () => {
    const bytes = jpeg();
    const copy = Buffer.from(bytes);
    inspectPhoto(bytes);
    expect(bytes.equals(copy)).toBe(true);
  });

  it.each([
    ['HEIC', heic()],
    ['GIF', gif()],
    ['text', Buffer.from('not a photo at all, just some text')],
    ['empty bytes', Buffer.alloc(0)],
    ['a JPEG without a frame header', Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
    ['a JPEG 0 pixels wide', jpeg({ width: 0 })],
    ['a PNG 0 pixels high', png({ width: 10, height: 0 })],
  ])('returns null for %s', (_, bytes) => {
    expect(inspectPhoto(bytes)).toBeNull();
  });
});
