// Генерирует пиксельные иконки PWA из спрайта: node tools/make-icons.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const SP = require('../sprites.js');

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function icon(size, cells, file) {
  const g = SP.build('squirrel', { eyes: 'normal', mouth: 'tongue' });
  const off = Math.floor((cells - SP.N) / 2);
  const bg = hex(SP.PALETTE[1]);
  const buf = png(size, (x, y) => {
    const cx = Math.floor(x * cells / size) - off, cy = Math.floor(y * cells / size) - off + 1;
    if (cx < 0 || cy < 0 || cx >= SP.N || cy >= SP.N) return bg;
    const c = g.d[cy * SP.N + cx];
    return c ? hex(SP.PALETTE[c]) : bg;
  });
  fs.writeFileSync(path.join(__dirname, '..', 'icons', file), buf);
  console.log(file, buf.length, 'bytes');
}
icon(192, 36, 'icon-192.png');
icon(512, 36, 'icon-512.png');
icon(512, 50, 'maskable-512.png');
