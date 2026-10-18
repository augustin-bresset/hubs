// Code QR (ISO/IEC 18004) sans dépendance, pour ouvrir une salle depuis l'appareil photo d'un
// téléphone : mode octets, correction de niveau M (15 % du code peut être abîmé), versions 1 à 10,
// soit jusqu'à 213 octets. Les tables et la disposition suivent la norme ; la vérification se fait
// en décodant les codes produits (test/qr.test.mjs).

// Par version : octets de correction par bloc, puis groupes [nombre de blocs, octets de données par bloc].
const BLOCKS = [
  null,
  { ec: 10, groups: [[1, 16]] },
  { ec: 16, groups: [[1, 28]] },
  { ec: 26, groups: [[1, 44]] },
  { ec: 18, groups: [[2, 32]] },
  { ec: 24, groups: [[2, 43]] },
  { ec: 16, groups: [[4, 27]] },
  { ec: 18, groups: [[4, 31]] },
  { ec: 22, groups: [[2, 38], [2, 39]] },
  { ec: 22, groups: [[3, 36], [2, 37]] },
  { ec: 26, groups: [[4, 43], [1, 44]] },
];
// Centres des motifs d'alignement, en lignes comme en colonnes.
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const FORMAT_M = 0; // bits du niveau de correction M dans l'information de format

// Corps de Galois à 256 éléments (polynôme x^8 + x^4 + x^3 + x^2 + 1), pour Reed-Solomon.
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

// Octets de correction d'un bloc : reste de la division du message par le polynôme générateur.
function correction(data, n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  const rem = new Array(n).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    for (let j = 0; j < n; j++) rem[j] ^= mul(g[j + 1], factor);
  }
  return rem;
}

const capacity = (version) => BLOCKS[version].groups.reduce((sum, [n, k]) => sum + n * k, 0);

// Suite des octets à placer : en-tête, données, bourrage, puis blocs entrelacés avec leur correction.
function codewords(bytes, version) {
  const { ec, groups } = BLOCKS[version];
  const total = capacity(version);
  const bits = [];
  const put = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4); // mode octets
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, total * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
  for (let pad = 0xec; data.length < total; pad ^= 0xec ^ 0x11) data.push(pad);

  const blocks = [];
  let k = 0;
  for (const [n, size] of groups) {
    for (let i = 0; i < n; i++) {
      const d = data.slice(k, (k += size));
      blocks.push({ d, e: correction(d, ec) });
    }
  }
  const out = [];
  const longest = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// Pénalité d'un masque (règles de la norme) : on garde le masque qui évite les longues plages
// d'une même couleur, les carrés pleins, les faux motifs de repérage et le déséquilibre clair/foncé.
function penalty(m) {
  const n = m.length;
  let score = 0, dark = 0;
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(m[i]);
    lines.push(m.map((row) => row[i]));
  }
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    const s = line.map((v) => (v ? 1 : 0)).join('');
    for (const pattern of ['10111010000', '00001011101']) {
      for (let i = s.indexOf(pattern); i !== -1; i = s.indexOf(pattern, i + 1)) score += 40;
    }
  }
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const v = m[y][x];
      if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) score += 3;
    }
  }
  for (const row of m) for (const v of row) dark += v;
  return score + 10 * Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5);
}

// Matrice du code (tableau de lignes de booléens, vrai = module foncé), sans la marge blanche.
export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 1;
  while (version <= 10 && 4 + (version < 10 ? 8 : 16) + 8 * bytes.length > 8 * capacity(version)) version++;
  if (version > 10) throw new Error('texte trop long pour un code QR');
  const size = 17 + 4 * version;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    m[y][x] = dark;
    fixed[y][x] = true;
  };

  // Motifs de repérage et leur liseré clair, rythme, alignement.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const centers = ALIGN[version], last = centers.length - 1;
  centers.forEach((cy, i) => centers.forEach((cx, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return; // sur un repère
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));

  // Information de format (réservée ici, écrite une fois le masque choisi) et de version.
  const drawFormat = (mask) => {
    const data = (FORMAT_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true); // module toujours foncé
  };
  drawFormat(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1, a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  // Données, en zigzag par paires de colonnes depuis le coin inférieur droit.
  const data = codewords(bytes, version);
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // la colonne de rythme est sautée
    const upward = ((right + 1) & 2) === 0;
    for (let v = 0; v < size; v++) {
      const y = upward ? size - 1 - v : v;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (fixed[y][x] || i >= data.length * 8) continue;
        m[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }

  // Masque le moins pénalisé.
  const apply = (mask) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && MASKS[mask](x, y)) m[y][x] = !m[y][x];
  };
  let best = 0, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    apply(mask);
    drawFormat(mask);
    const score = penalty(m);
    if (score < bestScore) {
      best = mask;
      bestScore = score;
    }
    apply(mask); // annule
  }
  apply(best);
  drawFormat(best);
  return m;
}

// Code QR en SVG, foncé sur fond blanc même en thème sombre (les lecteurs l'exigent), avec la
// marge claire de quatre modules prévue par la norme.
export function qrSvg(text, { margin = 4 } = {}) {
  const m = qrMatrix(text), n = m.length + 2 * margin;
  let path = '';
  m.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) path += `M${x + margin} ${y + margin}h1v1h-1z`;
  }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
