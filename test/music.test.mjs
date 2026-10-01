import test from 'node:test';
import assert from 'node:assert/strict';
import { PROBE, fft, makeBandstop, MusicAnalyzer } from '../public/dsp.js';
import { gapCorrections } from '../public/sync.js';

const SR = 48000;
const DELAY = (PROBE.taps - 1) / 2;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

// |H(f)| en dB d'une réponse impulsionnelle.
function response(h) {
  const n = 65536, re = new Float64Array(n), im = new Float64Array(n);
  re.set(h);
  fft(re, im);
  return (f) => 20 * Math.log10(Math.hypot(re[Math.round((f * n) / SR)], im[Math.round((f * n) / SR)]) + 1e-12);
}

// Convolution par FFT (signal long, filtre court), sortie de même longueur que l'entrée.
function convolve(x, h) {
  let n = 1;
  while (n < x.length + h.length) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(x);
  br.set(h);
  fft(ar, ai);
  fft(br, bi);
  for (let k = 0; k < n; k++) {
    const r = ar[k] * br[k] - ai[k] * bi[k], i = ar[k] * bi[k] + ai[k] * br[k];
    ar[k] = r;
    ai[k] = -i;
  }
  fft(ar, ai);
  return Float32Array.from({ length: x.length }, (_, i) => ar[i] / n);
}

// « Musique » : bruit large bande à l'enveloppe changeante, plus fort dans le grave, et notes tenues.
function makeMusic(seconds, seed = 3) {
  const rand = rng(seed);
  const out = new Float32Array(Math.round(seconds * SR));
  let low = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR, white = rand();
    low += 0.05 * (white - low);
    const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 1.7 * t);
    out[i] = env * (0.25 * white + 1.5 * low) + 0.1 * Math.sin(2 * Math.PI * 440 * t) + 0.05 * Math.sin(2 * Math.PI * 3700 * t);
  }
  return out;
}

const at = (x, pos) => {
  const i = Math.floor(pos), f = pos - i;
  return i < 0 || i + 1 >= x.length ? 0 : x[i] + f * (x[i + 1] - x[i]);
};

test('makeBandstop : bandes retirées, reste intact, retard pur sans bande', () => {
  const delta = makeBandstop(SR, []);
  assert.equal(delta[DELAY], 1);
  assert.equal(delta.reduce((sum, v) => sum + Math.abs(v), 0), 1);

  const H = response(makeBandstop(SR, [PROBE.bands[0], PROBE.bands[2]]));
  for (const [f1, f2] of [PROBE.bands[0], PROBE.bands[2]]) {
    for (let f = f1 + PROBE.margin; f <= f2 - PROBE.margin; f += 20) assert.ok(H(f) < -45, `${f} Hz : ${H(f).toFixed(1)} dB`);
  }
  for (const f of [100, 1000, 3200, 4150, 4600, 5150, 6100, 6600, 12000]) assert.ok(Math.abs(H(f)) < 0.1, `${f} Hz : ${H(f).toFixed(2)} dB`);
});

test('chaque appareil est retrouvé dans sa bande, même 15 dB plus faible que l’autre', () => {
  const music = makeMusic(7.5);
  const blocks = 32, pad = PROBE.maxLag + 3000;
  // Trois emplacements occupés : 0 (fort), 1 (15 dB plus faible, horloge à +100 ppm), 2 (muet).
  const played = [
    { slot: 0, gain: 1, delayMs: 4.1, ppm: 0 },
    { slot: 1, gain: 0.18, delayMs: -6.3, ppm: 100 },
  ].map((d) => ({ ...d, signal: convolve(music, makeBandstop(SR, PROBE.bands.filter((_, s) => s !== d.slot && s < 3))) }));
  const rand = rng(11);
  const mic = new Float32Array(pad * 2 + blocks * PROBE.block);
  for (let i = 0; i < mic.length; i++) {
    let v = 0.02 * rand(); // bruit de pièce : environ 40 dB sous la musique
    for (const d of played) {
      // Le filtre retarde de DELAY : on l'ôte ici, comme le fait l'appareil en lançant sa lecture plus tôt.
      const pos = (i - pad) * (1 + d.ppm * 1e-6) - (d.delayMs / 1000) * SR + DELAY;
      v += d.gain * at(d.signal, pos) + 0.4 * d.gain * at(d.signal, pos - 0.0031 * SR); // trajet direct + écho
    }
    mic[i] = v;
  }
  const analyzer = new MusicAnalyzer(SR, new Map([0, 1, 2].map((s) => [s, PROBE.bands[s]])));
  for (let b = 0; b < blocks; b++) {
    const e = pad + b * PROBE.block;
    analyzer.addBlock(music.subarray(b * PROBE.block, (b + 1) * PROBE.block), mic.subarray(e - PROBE.maxLag, e + PROBE.block + PROBE.maxLag), (b * PROBE.block) / SR);
  }
  const res = analyzer.results();
  const tMid = ((blocks - 1) * PROBE.block) / 2 / SR;
  const measured = [];
  for (const d of played) {
    const r = res.get(d.slot);
    const ms = (r.lag / SR) * 1000;
    const expected = d.delayMs - d.ppm * 1e-6 * tMid * 1000;
    console.log(`emplacement ${d.slot} : score ${r.score.toFixed(1)}, ${ms.toFixed(2)} ms (attendu ${expected.toFixed(2)}), glissement ${(r.drift * 1e6).toFixed(0)} ppm`);
    assert.ok(r.score > 20, `emplacement ${d.slot} : score ${r.score}`);
    assert.ok(Math.abs(ms - expected) < 0.5, `emplacement ${d.slot} : ${ms} ms, attendu ${expected}`);
    measured.push({ client: d.slot, ms });
  }
  console.log(`emplacement 2 (muet) : score ${res.get(2).score.toFixed(1)}`);
  assert.ok(res.get(2).score < 8, `appareil muet : score ${res.get(2).score}`);

  // L'écart de 10 ms entre les deux appareils donne deux corrections opposées.
  const fixes = gapCorrections(measured);
  assert.ok(fixes[0].deltaMs > 2.5 && fixes[1].deltaMs < -2.5, JSON.stringify(fixes));
});

test('un silence dans la musique ne produit pas de mesure', () => {
  const analyzer = new MusicAnalyzer(SR, new Map([[0, PROBE.bands[0]]]));
  analyzer.addBlock(new Float32Array(PROBE.block), new Float32Array(PROBE.block + 2 * PROBE.maxLag), 0);
  assert.deepEqual(analyzer.results().get(0), { lag: 0, drift: 0, score: 0, blocks: 0 });
});
