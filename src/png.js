import { PNG } from "pngjs";

/**
 * Decodes a PNG for measurement. Returns {width, height, channels, at(x,y)}
 * where at() yields [r,g,b,a] (a=255 for sources without an alpha channel) and
 * channels counts the source's own channels, 3 without alpha and 4 with it.
 */
export function decodePng(buffer) {
  const png = PNG.sync.read(buffer);
  const stride = png.width * 4;
  const pixels = png.data;
  return {
    width: png.width,
    height: png.height,
    channels: png.alpha ? 4 : 3,
    at(x, y) {
      const i = y * stride + x * 4;
      return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
    },
  };
}
