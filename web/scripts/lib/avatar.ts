// A seeded driver's photo and car photo: soft two-tone shapes, as small
// PNGs -- the network takes only inline raster images -- so the dev world's
// drivers and their cars look like something on a customer's screen.
// Encoded by hand: the seed runs in Node, with no canvas.
import { deflateSync } from "node:zlib";

type Rgb = [number, number, number];

/// A PNG data URI: a head and shoulders in `figure` on a `background` tint.
export function avatarDataUri(background: Rgb, figure: Rgb): string {
  return pngDataUri(96, 96, (x, y) => {
    const head = (x - 48) ** 2 + (y - 38) ** 2 <= 17 ** 2;
    const shoulders = y >= 62 && (x - 48) ** 2 / 36 ** 2 + (y - 98) ** 2 / 36 ** 2 <= 1;
    return head || shoulders ? figure : background;
  });
}

/// A PNG data URI: a car side-on in `paint`, on a road under a pale sky.
export function carDataUri(paint: Rgb): string {
  const sky: Rgb = [226, 236, 244];
  const road: Rgb = [92, 96, 104];
  const glass: Rgb = [190, 214, 232];
  const tyre: Rgb = [34, 36, 40];
  const hub: Rgb = [170, 174, 180];
  return pngDataUri(128, 96, (x, y) => {
    for (const cx of [36, 92]) {
      const d = (x - cx) ** 2 + (y - 70) ** 2;
      if (d <= 5 ** 2) return hub;
      if (d <= 11 ** 2) return tyre;
    }
    // The body: a long box with rounded ends, and the cabin on top.
    const body = y >= 50 && y <= 70 && x >= 14 && x <= 114 && !(y < 54 && (x < 18 || x > 110));
    const cabin = y >= 34 && y < 50 && x >= 38 + (50 - y) * 0.9 && x <= 92 - (50 - y) * 0.5;
    const window = cabin && y >= 38 && y <= 48 && x >= 42 + (50 - y) * 0.9 && x <= 88 - (50 - y) * 0.5 && Math.abs(x - 64) > 1;
    if (window) return glass;
    if (body || cabin) return paint;
    return y >= 78 ? road : sky;
  });
}

/// A `width` x `height` PNG data URI, each pixel's colour from `pixel`.
function pngDataUri(width: number, height: number, pixel: (x: number, y: number) => Rgb): string {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) row.set(pixel(x, y), 1 + x * 3);
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

function crc32(bytes: Buffer): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
