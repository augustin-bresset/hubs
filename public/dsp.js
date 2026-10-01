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

// --- Suivi continu par la musique -------------------------------------------
// La musique sert elle-même de signal de mesure : elle est connue de tous et bien plus forte que
// n'importe quel bruit caché. Pour savoir quelle copie vient de quel appareil, chacun dispose d'une
// bande de fréquences où il est le seul à la jouer (les autres l'y retirent). Dans cette bande, le
// micro n'entend que lui, même s'il est beaucoup moins fort que les autres.

export const PROBE = {
  block: 8192,
  fftSize: 16384,
  maxLag: 4096, // retard recherché : ±85 ms à 48 kHz autour de l'instant attendu
  // Une bande (Hz) par emplacement d'appareil.
  bands: [[3400, 4000], [4300, 4900], [5300, 5900], [6300, 6900]],
  // Entre ces bandes, tout le monde joue : sert de référence de niveau.
  shared: [[4050, 4250], [4950, 5250], [5950, 6250]],
  edge: 256, // retards trop près du bord de la plage de recherche : non fiables
  margin: 70, // Hz écartés de chaque bord pour la mesure : zone de transition du filtre
  taps: 4097, // longueur du filtre coupe-bande ; il retarde le son de (taps - 1) / 2 échantillons
};
// Hypothèses de glissement du retard pendant la fenêtre : -400 à +400 ppm par pas de 50.
const DRIFTS = Array.from({ length: 17 }, (_, i) => (i - 8) * 50e-6);

const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

// Réponse impulsionnelle d'un filtre à phase linéaire qui retire les bandes [f1, f2] données et
// laisse le reste intact. Sans bande, c'est un simple retard : tous les appareils gardent ainsi
// le même délai, qu'ils filtrent ou non.
export function makeBandstop(sampleRate, bands, taps = PROBE.taps) {
  const h = new Float32Array(taps);
  const mid = (taps - 1) / 2;
  h[mid] = 1;
  for (const [f1, f2] of bands) {
    for (let n = 0; n < taps; n++) {
      const m = n - mid;
      const blackman = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (taps - 1));
      const a = (2 * f1) / sampleRate, b = (2 * f2) / sampleRate;
      h[n] -= blackman * (b * sinc(b * m) - a * sinc(a * m));
    }
  }
  return h;
}

// Mesure, bande par bande, le retard entre la musique de référence et ce que le micro a entendu.
// La corrélation se fait par blocs de 171 ms dont on additionne les énergies, en essayant plusieurs
// glissements d'horloge : un bloc reste cohérent malgré les petites variations de vitesse, ce
// qu'une corrélation d'un seul tenant sur plusieurs secondes ne tolère pas.
export class MusicAnalyzer {
  // bands : Map clé d'appareil -> [f1, f2], la bande où cet appareil est seul à jouer.
  constructor(sampleRate, bands) {
    this.sampleRate = sampleRate;
    this.size = 2 * PROBE.maxLag + 1;
    this.bands = new Map();
    for (const [key, [f1, f2]] of bands) {
      const k0 = Math.ceil(((f1 + PROBE.margin) * PROBE.fftSize) / sampleRate);
      const k1 = Math.floor(((f2 - PROBE.margin) * PROBE.fftSize) / sampleRate);
      // Fenêtre de Hann sur la bande : évite les rebonds de la corrélation de part et d'autre du pic.
      const taper = Float32Array.from({ length: k1 - k0 + 1 }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 1)) / (k1 - k0 + 2)));
      this.bands.set(key, { k0, k1, taper, blocks: 0, heard: 0, played: 0, profiles: DRIFTS.map(() => new Float64Array(this.size)) });
    }
    this.shared = PROBE.shared.map(([f1, f2]) => [Math.ceil((f1 * PROBE.fftSize) / sampleRate), Math.floor((f2 * PROBE.fftSize) / sampleRate)]);
    this.sharedHeard = 0;
    this.sharedPlayed = 0;
    // Fenêtres appliquées avant la FFT : sans elles, la coupure nette du bloc étale un peu de la
    // musique voisine dans une bande vide et y fait apparaître de faux pics en bord de plage.
    this.refWindow = Float32Array.from({ length: PROBE.block }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / PROBE.block));
    const ramp = 512, len = PROBE.block + 2 * PROBE.maxLag;
    this.sliceWindow = Float32Array.from({ length: len }, (_, i) => {
      const d = Math.min(i, len - 1 - i);
      return d >= ramp ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * (d + 0.5)) / ramp);
    });
    const n = PROBE.fftSize;
    Object.assign(this, { rr: new Float64Array(n), ri: new Float64Array(n), xr: new Float64Array(n), xi: new Float64Array(n), cr: new Float64Array(n), ci: new Float64Array(n) });
    this.tMin = Infinity;
    this.tMax = -Infinity;
  }

  // ref : PROBE.block échantillons de la musique de référence.
  // slice : PROBE.block + 2 * PROBE.maxLag échantillons du micro, qui commencent PROBE.maxLag
  // avant l'instant où ce bloc de musique est attendu.
  // timeS : instant du bloc (s), sur une échelle commune à tous les blocs de la fenêtre.
  addBlock(ref, slice, timeS) {
    const { rr, ri, xr, xi, cr, ci, size } = this;
    rr.fill(0); ri.fill(0); xr.fill(0); xi.fill(0);
    for (let i = 0; i < ref.length; i++) rr[i] = ref[i] * this.refWindow[i];
    for (let i = 0; i < slice.length; i++) xr[i] = slice[i] * this.sliceWindow[i];
    fft(rr, ri);
    fft(xr, xi);
    for (const [k0, k1] of this.shared) {
      for (let k = k0; k <= k1; k++) {
        this.sharedPlayed += rr[k] * rr[k] + ri[k] * ri[k];
        this.sharedHeard += xr[k] * xr[k] + xi[k] * xi[k];
      }
    }
    for (const band of this.bands.values()) {
      const { k0, k1, taper } = band;
      let energy = 0, heard = 0, mean = 0;
      for (let k = k0; k <= k1; k++) {
        energy += rr[k] * rr[k] + ri[k] * ri[k];
        heard += xr[k] * xr[k] + xi[k] * xi[k];
        mean += Math.hypot(rr[k], ri[k]) * Math.hypot(xr[k], xi[k]);
      }
      if (energy < 1e-12) continue; // silence dans cette bande : rien à mesurer
      band.played += energy;
      band.heard += heard;
      const eps = (1e-3 * mean) / (k1 - k0 + 1) + 1e-20;
      cr.fill(0);
      ci.fill(0);
      for (let k = k0; k <= k1; k++) {
        // Spectre croisé normalisé : seule la phase compte, chaque fréquence pèse autant.
        const gr = xr[k] * rr[k] + xi[k] * ri[k], gi = xi[k] * rr[k] - xr[k] * ri[k];
        const w = taper[k - k0] / (Math.hypot(xr[k], xi[k]) * Math.hypot(rr[k], ri[k]) + eps);
        cr[k] = gr * w;
        ci[k] = -gi * w; // conjugué : la FFT directe sert de FFT inverse
      }
      fft(cr, ci);
      // Fréquences positives seules : le module est l'enveloppe de la corrélation.
      for (let i = 0; i < size; i++) cr[i] = cr[i] * cr[i] + ci[i] * ci[i];
      for (let h = 0; h < DRIFTS.length; h++) {
        // Ramène le retard de ce bloc à ce qu'il vaudrait à l'instant 0 sous cette hypothèse.
        const shift = Math.round(DRIFTS[h] * timeS * this.sampleRate);
        const profile = band.profiles[h];
        const from = Math.max(0, shift), to = Math.min(size, size + shift);
        for (let i = from; i < to; i++) profile[i - shift] += cr[i];
      }
      band.blocks++;
    }
    this.tMin = Math.min(this.tMin, timeS);
    this.tMax = Math.max(this.tMax, timeS);
  }

  // Par appareil : retard au milieu de la fenêtre (en échantillons, par rapport à l'instant
  // attendu), glissement retenu, score (hauteur du pic en écarts-types du bruit de fond), nombre
  // de blocs utilisés, et niveau : ce que le micro reçoit dans la bande de l'appareil, rapporté à
  // ce qu'il reçoit là où tout le monde joue (dB). Un niveau très bas signale un appareil muet,
  // dont la bande ne contient que les restes du filtrage des autres. `edge` : pic en bord de plage.
  results() {
    const out = new Map();
    const tMid = (this.tMin + this.tMax) / 2;
    const guard = Math.round(0.006 * this.sampleRate);
    for (const [key, band] of this.bands) {
      if (band.blocks === 0) {
        out.set(key, { lag: 0, drift: 0, score: 0, blocks: 0, level: -Infinity, edge: false });
        continue;
      }
      const gain = band.heard / band.played, sharedGain = this.sharedHeard / this.sharedPlayed;
      const level = 10 * Math.log10(gain / sharedGain);
      let best = null;
      for (let h = 0; h < DRIFTS.length; h++) {
        const profile = band.profiles[h];
        let max = -Infinity, kmax = 0;
        for (let i = 0; i < profile.length; i++) if (profile[i] > max) { max = profile[i]; kmax = i; }
        if (!best || max > best.max) best = { profile, max, kmax, drift: DRIFTS[h] };
      }
      const { profile, max, kmax, drift } = best;
      let sum = 0, sum2 = 0, count = 0;
      for (let i = 0; i < profile.length; i++) {
        if (Math.abs(i - kmax) <= guard) continue;
        sum += profile[i];
        sum2 += profile[i] * profile[i];
        count++;
      }
      const mean = sum / count;
      const std = Math.sqrt(Math.max(sum2 / count - mean * mean, 0));
      // Sommet de la parabole passant par le maximum et ses deux voisins.
      let peak = kmax;
      if (kmax > 0 && kmax < profile.length - 1) {
        const a = profile[kmax - 1], b = profile[kmax], c = profile[kmax + 1];
        if (a - 2 * b + c < 0) peak += (0.5 * (a - c)) / (a - 2 * b + c);
      }
      const edge = kmax < PROBE.edge || kmax > profile.length - 1 - PROBE.edge;
      out.set(key, { lag: peak - PROBE.maxLag + drift * tMid * this.sampleRate, drift, score: std > 0 ? (max - mean) / std : 0, blocks: band.blocks, level, edge });
    }
    return out;
  }
}
