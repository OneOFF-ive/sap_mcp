const fs = require('node:fs');

// A deterministic code-drawn icon: the same connected-node motif as the Web UI.
// ICO DIB entries avoid adding an image-processing dependency to the build.
const sizes = [16, 32, 48, 256];
const entries = sizes.map(size => {
  const maskStride = Math.ceil(size / 32) * 4;
  const dib = Buffer.alloc(40 + size * size * 4 + maskStride * size);
  dib.writeUInt32LE(40, 0); dib.writeInt32LE(size, 4); dib.writeInt32LE(size * 2, 8);
  dib.writeUInt16LE(1, 12); dib.writeUInt16LE(32, 14);
  const inBox = (x, y, left, top, width, height) => x >= left && x <= left + width && y >= top && y <= top + height;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const boxes = [[.38, .17], [.16, .61], [.60, .61]];
    const border = boxes.some(([a, b]) => inBox(u, v, a, b, .23, .22) && !inBox(u, v, a + .045, b + .045, .14, .13));
    const link = inBox(u, v, .47, .38, .055, .15) || inBox(u, v, .26, .50, .47, .05) ||
      inBox(u, v, .26, .50, .045, .12) || inBox(u, v, .69, .50, .045, .12);
    const offset = 40 + ((size - y - 1) * size + x) * 4;
    const color = border || link ? [255, 255, 255] : [128, 126, 0];
    dib[offset] = color[0]; dib[offset + 1] = color[1]; dib[offset + 2] = color[2]; dib[offset + 3] = 255;
  }
  return { size, dib };
});
const header = Buffer.alloc(6 + entries.length * 16);
header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
let offset = header.length;
entries.forEach(({ size, dib }, index) => {
  const entry = 6 + index * 16;
  header[entry] = size === 256 ? 0 : size; header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(dib.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
  offset += dib.length;
});
fs.writeFileSync(process.argv[2], Buffer.concat([header, ...entries.map(entry => entry.dib)]));
