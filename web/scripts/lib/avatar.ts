// A seeded driver's photo: a soft two-tone portrait silhouette, as a small
// PNG -- the network takes only inline raster images -- so the dev world's
// drivers look like people on a customer's screen. Encoded by hand: the seed
// runs in Node, with no canvas.
import { deflateSync } from "node:zlib";

const SIZE = 96;

/// A PNG data URI: a head and shoulders in `figure` on a `background` tint.
export function avatarDataUri(background: [number, number, number], figure: [number, number, number]): string {
  const rows: Buffer[] = [];
  for (let y = 0; y < SIZE; y++) {
    const row = Buffer.alloc(1 + SIZE * 3);
    for (let x = 0; x < SIZE; x++) {
      const head = (x - 48) ** 2 + (y - 38) ** 2 <= 17 ** 2;
      const shoulders = y >= 62 && (x - 48) ** 2 / 36 ** 2 + (y - 98) ** 2 / 36 ** 2 <= 1;
      const [r, g, b] = head || shoulders ? figure : background;
      row.set([r, g, b], 1 + x * 3);
    }
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
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
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
