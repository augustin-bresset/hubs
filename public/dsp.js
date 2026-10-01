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
