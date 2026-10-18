import test from 'node:test';
import assert from 'node:assert/strict';
import { qrMatrix, qrSvg } from '../public/qr.js';

// Relit une matrice comme le ferait un lecteur une fois l'image redressée : information de format,
// démasquage, lecture en zigzag, contrôle Reed-Solomon de chaque bloc, puis décodage du mode octets.
// Écrit d'après la norme, indépendamment de l'encodeur ; l'encodeur a aussi été vérifié une fois avec
// un décodeur d'images (jsQR) sur toutes les longueurs de 1 à 213 octets.
const BLOCKS = { 1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]], 6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]] };
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

const EXP = [], LOG = [];
for (let i = 0, x = 1; i < 255; i++, x = (x << 1) ^ (x & 0x80 ? 0x11d : 0)) {
  EXP[i] = x;
  LOG[x] = i;
}
const gmul = (a, b) => (a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0);

function decode(m) {
  const size = m.length, version = (size - 17) / 4;
  assert.ok(Number.isInteger(version) && version >= 1 && version <= 10, `taille ${size}`);
  for (const [x0, y0] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        assert.equal(m[y0 + y][x0 + x], ring !== 2, `motif de repérage en ${x0},${y0}`);
      }
    }
  }

  // Format : 15 bits autour du repère du haut à gauche, contrôlés par leur code BCH.
  const at = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  const format = at.reduce((acc, [x, y], i) => acc | (m[y][x] ? 1 << i : 0), 0) ^ 0x5412;
  let rem = format;
  for (let i = 14; i >= 10; i--) if (rem & (1 << i)) rem ^= 0x537 << (i - 10);
  assert.equal(rem, 0, 'information de format valide');
  assert.equal(format >> 13, 0, 'niveau de correction M');
  const mask = (format >> 10) & 7;

  const reserved = (x, y) => {
    if ((x < 9 && y < 9) || (x >= size - 8 && y < 9) || (x < 9 && y >= size - 8)) return true; // repères et format
    if (x === 6 || y === 6) return true; // rythme
    if (version >= 7 && ((x >= size - 11 && y < 6) || (y >= size - 11 && x < 6))) return true; // version
    const c = ALIGN[version];
    return c.some((ay, i) => c.some((ax, j) => {
      const onFinder = (i === 0 && j === 0) || (i === 0 && j === c.length - 1) || (i === c.length - 1 && j === 0);
      return !onFinder && Math.abs(x - ax) <= 2 && Math.abs(y - ay) <= 2;
    }));
  };
  const flip = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0][mask];

  const bits = [];
  for (let right = size - 1, up = true; right >= 1; right -= 2, up = !up) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) {
      const y = up ? size - 1 - v : v;
      for (const x of [right, right - 1]) if (!reserved(x, y)) bits.push(m[y][x] !== flip(x, y));
    }
  }
  const [ec, groups] = BLOCKS[version];
  const sizes = groups.flatMap(([n, k]) => Array(n).fill(k));
  const total = sizes.reduce((s, k) => s + k + ec, 0);
  const bytes = Array.from({ length: total }, (_, i) => bits.slice(8 * i, 8 * i + 8).reduce((acc, b) => (acc << 1) | b, 0));

  // Désentrelacement : données colonne par colonne, puis correction.
  const blocks = sizes.map(() => []);
  let k = 0;
  for (let i = 0; i < Math.max(...sizes); i++) sizes.forEach((len, b) => { if (i < len) blocks[b].push(bytes[k++]); });
  for (let i = 0; i < ec; i++) blocks.forEach((blk) => blk.push(bytes[k++]));
  blocks.forEach((blk, b) => {
    // Un bloc correct s'annule en chacune des racines du polynôme générateur.
    for (let r = 0; r < ec; r++) assert.equal(blk.reduce((acc, c) => gmul(acc, EXP[r]) ^ c, 0), 0, `bloc ${b}, syndrome ${r}`);
  });

  const data = blocks.flatMap((blk, b) => blk.slice(0, sizes[b]));
  const stream = data.flatMap((byte) => Array.from({ length: 8 }, (_, i) => (byte >> (7 - i)) & 1));
  let pos = 0;
  const read = (n) => stream.slice(pos, (pos += n)).reduce((acc, b) => (acc << 1) | b, 0);
  assert.equal(read(4), 0b0100, 'mode octets');
  const length = read(version < 10 ? 8 : 16);
  return new TextDecoder().decode(Uint8Array.from({ length }, () => read(8)));
}

test('code QR : relu à l’identique pour toutes les longueurs, versions 1 à 10', () => {
  const versions = new Set();
  const samples = ['https://192.168.1.12:8443/r/ABC234', 'é€😀', ...Array.from({ length: 213 }, (_, i) => 'x'.repeat(i + 1).replace(/x/g, (_, j) => String.fromCharCode(33 + ((j * 7 + i) % 90))))];
  for (const text of samples) {
    const m = qrMatrix(text);
    versions.add((m.length - 17) / 4);
    assert.equal(decode(m), text);
  }
  assert.deepEqual([...versions].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.throws(() => qrMatrix('x'.repeat(214)), /trop long/);
});

test('code QR : SVG foncé sur blanc avec marge', () => {
  const svg = qrSvg('https://192.168.1.12:8443/r/ABC234');
  assert.match(svg, /^<svg [^>]*viewBox="0 0 37 37"/); // version 3 : 29 modules + 2 × 4 de marge
  assert.match(svg, /<rect width="37" height="37" fill="#fff"\/>/);
});
