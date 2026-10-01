// Traitement du signal partagé entre le navigateur et les tests Node :
// signal de calibration (balayage sinusoïdal) et détection par corrélation croisée.

export const CHIRP = { f0: 1000, f1: 6000, dur: 0.15, taper: 0.1 };

// Valeur du balayage à l'instant t (secondes), 0 en dehors de [0, dur].
export function chirpSample(t, { f0, f1, dur, taper } = CHIRP) {
  if (t < 0 || t > dur) return 0;
  const edge = taper * dur;
  let w = 1;
  if (t < edge) w = 0.5 * (1 - Math.cos((Math.PI * t) / edge));
  else if (t > dur - edge) w = 0.5 * (1 - Math.cos((Math.PI * (dur - t)) / edge));
  const k = (f1 - f0) / dur;
  return w * Math.sin(2 * Math.PI * (f0 * t + 0.5 * k * t * t));
}

export function makeChirp(sampleRate, spec = CHIRP) {
  const out = new Float32Array(Math.round(spec.dur * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = chirpSample(i / sampleRate, spec);
  return out;
}

// FFT radix-2 en place (longueur = puissance de 2).
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

// corr[k] = somme_n signal[k + n] * template[n], pour les décalages où le gabarit tient en entier.
export function crossCorrelate(signal, template) {
  let n = 1;
  while (n < signal.length + template.length) n <<= 1;
  const sr = new Float64Array(n), si = new Float64Array(n);
  const tr = new Float64Array(n), ti = new Float64Array(n);
  sr.set(signal);
  tr.set(template);
  fft(sr, si);
  fft(tr, ti);
  for (let i = 0; i < n; i++) {
    const pr = sr[i] * tr[i] + si[i] * ti[i];
    const pi = si[i] * tr[i] - sr[i] * ti[i];
    sr[i] = pr;
    si[i] = -pi; // conjugué : la FFT directe sert de FFT inverse
  }
  fft(sr, si);
  const out = new Float32Array(signal.length - template.length + 1);
  for (let i = 0; i < out.length; i++) out[i] = sr[i] / n;
  return out;
}

// Cherche le gabarit dans le signal. Renvoie l'indice de la première arrivée (trajet direct)
// et un rapport pic / bruit de fond (psr) qui sert de score de confiance.
export function detectChirp(signal, template, sampleRate) {
  if (signal.length < template.length) return null;
  const corr = crossCorrelate(signal, template);
  let max = 0, kmax = 0, energy = 0;
  for (let i = 0; i < corr.length; i++) {
    const a = Math.abs(corr[i]);
    corr[i] = a;
    energy += a * a;
    if (a > max) { max = a; kmax = i; }
  }
  if (max === 0) return { index: 0, psr: 0 };

  // Bruit de fond : RMS de la corrélation hors voisinage du pic (±20 ms, échos compris).
  const guard = Math.round(0.02 * sampleRate);
  let n = corr.length;
  for (let i = Math.max(0, kmax - guard); i < Math.min(corr.length, kmax + guard); i++) {
    energy -= corr[i] * corr[i];
    n--;
  }
  const rms = n > 0 ? Math.sqrt(Math.max(energy, 0) / n) : 0;

  // Un écho peut être plus fort que le trajet direct : on prend le premier pic local
  // d'amplitude comparable dans les 20 ms qui précèdent le maximum.
  let first = kmax;
  for (let i = Math.max(1, kmax - guard); i < kmax; i++) {
    if (corr[i] >= 0.5 * max && corr[i] >= corr[i - 1] && corr[i] >= corr[i + 1]) { first = i; break; }
  }
  return { index: first, psr: rms > 0 ? max / rms : Infinity };
}

export function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// --- Suivi continu : signature propre à chaque appareil ---------------------
// Chaque appareil joue en boucle, à bas niveau, un bruit à bande limitée qui lui est propre.
// Le micro de référence retrouve chaque signature par corrélation et en déduit son retard.
// La corrélation se fait par blocs courts dont on additionne les énergies : un bloc de 85 ms
// reste cohérent malgré les petites variations de vitesse des horloges, ce qu'une corrélation
// d'un seul tenant sur plusieurs secondes ne tolère pas.

export const SIG = {
  rate: 48000, // fréquence d'échantillonnage de référence de la signature
  length: 65536, // une période : 1,365 s
  f0: 2000,
  f1: 6000,
  block: 4096, // 85 ms
  fftSize: 16384,
  maxLag: 4800, // retard recherché : ±100 ms autour de l'instant attendu
};
const SIG_K0 = Math.ceil((SIG.f0 * SIG.fftSize) / SIG.rate);
const SIG_K1 = Math.floor((SIG.f1 * SIG.fftSize) / SIG.rate);
const SIG_SMOOTH = 12; // lissage du profil sur 0,25 ms : la largeur d'un pic de corrélation
const SIG_GUARD = 960; // 20 ms autour du pic, exclus du calcul du bruit de fond
// Hypothèses de glissement du retard : -400 à +400 ppm par pas de 50.
const SIG_DRIFTS = Array.from({ length: 17 }, (_, i) => (i - 8) * 50e-6);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Signature n° `code` : spectre plat entre f0 et f1, phases pseudo-aléatoires, RMS 1.
// Périodique de période SIG.length à SIG.rate ; le même code donne le même signal partout.
export function makeSignature(code) {
  const n = SIG.length;
  const re = new Float64Array(n), im = new Float64Array(n);
  const rand = mulberry32(Math.imul(code + 1, 0x9e3779b1));
  const k0 = Math.ceil((SIG.f0 * n) / SIG.rate), k1 = Math.floor((SIG.f1 * n) / SIG.rate);
  for (let k = k0; k <= k1; k++) {
    const phase = 2 * Math.PI * rand();
    re[k] = re[n - k] = Math.cos(phase);
    im[k] = -Math.sin(phase); // spectre conjugué : la FFT directe sert de FFT inverse
    im[n - k] = Math.sin(phase);
  }
  fft(re, im);
  let energy = 0;
  for (let i = 0; i < n; i++) energy += re[i] * re[i];
  const scale = 1 / Math.sqrt(energy / n);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = re[i] * scale;
  return out;
}

// Spectre de chaque bloc de la signature, réduit à la bande utile.
export function signatureTemplates(sig) {
  const blocks = [];
  const re = new Float64Array(SIG.fftSize), im = new Float64Array(SIG.fftSize);
  for (let start = 0; start + SIG.block <= sig.length; start += SIG.block) {
    re.fill(0);
    im.fill(0);
    re.set(sig.subarray(start, start + SIG.block));
    fft(re, im);
    blocks.push({ re: Float32Array.from(re.subarray(SIG_K0, SIG_K1 + 1)), im: Float32Array.from(im.subarray(SIG_K0, SIG_K1 + 1)) });
  }
  return blocks;
}

// Accumule, bloc après bloc, le profil de corrélation de chaque signature recherchée.
// Pendant les quelques secondes d'une fenêtre, le retard glisse (horloges qui ne tournent pas à la
// même vitesse) : on accumule un profil par hypothèse de glissement et on garde la meilleure.
export class SignatureAnalyzer {
  // templates : Map clé d'appareil -> signatureTemplates(...)
  constructor(templates) {
    this.templates = templates;
    this.size = 2 * SIG.maxLag + 1;
    this.profiles = new Map([...templates.keys()].map((key) => [key, SIG_DRIFTS.map(() => new Float64Array(this.size))]));
    this.re = new Float64Array(SIG.fftSize);
    this.im = new Float64Array(SIG.fftSize);
    this.cr = new Float64Array(SIG.fftSize);
    this.ci = new Float64Array(SIG.fftSize);
    this.tMin = Infinity;
    this.tMax = -Infinity;
  }

  // slice : SIG.block + 2 * SIG.maxLag échantillons à SIG.rate, qui commencent SIG.maxLag
  // avant l'instant où le bloc n° `block` de la signature est attendu.
  // timeS : instant de ce bloc (s), sur une échelle commune à tous les blocs de la fenêtre.
  addBlock(block, slice, timeS) {
    const { re, im, cr, ci, size } = this;
    re.fill(0);
    im.fill(0);
    re.set(slice);
    fft(re, im);
    // Blanchiment : chaque fréquence pèse autant, quelle que soit l'énergie de la musique.
    let mean = 0;
    for (let k = SIG_K0; k <= SIG_K1; k++) mean += Math.hypot(re[k], im[k]);
    const eps = (1e-3 * mean) / (SIG_K1 - SIG_K0 + 1) + 1e-12;
    for (let k = SIG_K0; k <= SIG_K1; k++) {
      const m = Math.hypot(re[k], im[k]) + eps;
      re[k] /= m;
      im[k] /= m;
    }
    for (const [key, blocks] of this.templates) {
      const t = blocks[block];
      cr.fill(0);
      ci.fill(0);
      for (let k = SIG_K0; k <= SIG_K1; k++) {
        const tr = t.re[k - SIG_K0], ti = t.im[k - SIG_K0];
        cr[k] = re[k] * tr + im[k] * ti;
        ci[k] = -(im[k] * tr - re[k] * ti); // conjugué de X·conj(T) : FFT directe = FFT inverse
      }
      fft(cr, ci);
      for (let i = 0; i < size; i++) cr[i] *= cr[i];
      const profiles = this.profiles.get(key);
      for (let h = 0; h < SIG_DRIFTS.length; h++) {
        // Ramène le retard de ce bloc à ce qu'il vaudrait à l'instant 0 sous cette hypothèse.
        const shift = Math.round(SIG_DRIFTS[h] * timeS * SIG.rate);
        const profile = profiles[h];
        const from = Math.max(0, shift), to = Math.min(size, size + shift);
        for (let i = from; i < to; i++) profile[i - shift] += cr[i];
      }
    }
    this.tMin = Math.min(this.tMin, timeS);
    this.tMax = Math.max(this.tMax, timeS);
  }

  // Par appareil : retard au milieu de la fenêtre (en échantillons à SIG.rate, par rapport à
  // l'instant attendu), glissement retenu et score (hauteur du pic en écarts-types du bruit de fond).
  results() {
    const out = new Map();
    const tMid = (this.tMin + this.tMax) / 2;
    for (const [key, profiles] of this.profiles) {
      let best = null;
      for (let h = 0; h < SIG_DRIFTS.length; h++) {
        const smooth = boxcar(profiles[h], SIG_SMOOTH);
        let max = -Infinity, kmax = 0;
        for (let i = 0; i < smooth.length; i++) if (smooth[i] > max) { max = smooth[i]; kmax = i; }
        if (!best || max > best.max) best = { smooth, max, kmax, drift: SIG_DRIFTS[h] };
      }
      const { smooth, max, kmax, drift } = best;
      let sum = 0, sum2 = 0, count = 0;
      for (let i = 0; i < smooth.length; i++) {
        if (Math.abs(i - kmax) <= SIG_GUARD) continue;
        sum += smooth[i];
        sum2 += smooth[i] * smooth[i];
        count++;
      }
      const mean = sum / count;
      const std = Math.sqrt(Math.max(sum2 / count - mean * mean, 0));
      // Trajet direct : premier pic comparable dans les 20 ms qui précèdent le maximum.
      let first = kmax;
      const floor = mean + 0.5 * (max - mean);
      for (let i = Math.max(1, kmax - SIG_GUARD); i < kmax; i++) {
        if (smooth[i] >= floor && smooth[i] >= smooth[i - 1] && smooth[i] >= smooth[i + 1]) { first = i; break; }
      }
      out.set(key, { lag: first - SIG.maxLag + drift * tMid * SIG.rate, drift, score: std > 0 ? (max - mean) / std : 0 });
    }
    return out;
  }
}

// Moyenne glissante centrée (somme sur `width` points).
function boxcar(values, width) {
  const n = values.length, half = width >> 1;
  const out = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n + half; i++) {
    if (i < n) acc += values[i];
    if (i >= width) acc -= values[i - width];
    if (i >= half) out[i - half] = acc;
  }
  return out;
}
