// Extract data containers from a hash-verified Microsoft Burn redistributable.
// Windows expand.exe handles decompression; this script never executes the bundle.
const fs = require('node:fs');
const path = require('node:path');
const [input, output] = process.argv.slice(2);
const bytes = fs.readFileSync(input);
fs.mkdirSync(output, { recursive: true });
let count = 0;
for (let offset = 0; (offset = bytes.indexOf('MSCF', offset)) !== -1; offset += 4) {
  if (offset + 36 > bytes.length) continue;
  const size = bytes.readUInt32LE(offset + 8);
  if (size < 36 || offset + size > bytes.length) continue;
  fs.writeFileSync(path.join(output, `container-${count++}.cab`), bytes.subarray(offset, offset + size));
  offset += size - 4;
}
if (count !== 2) throw new Error(`Expected two pinned Burn containers; found ${count}. Review download-lock.json.`);
