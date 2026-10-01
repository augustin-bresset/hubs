import test from 'node:test';
import assert from 'node:assert/strict';
import { chirpSample, makeChirp, crossCorrelate, detectChirp } from '../public/dsp.js';

// Bruit pseudo-aléatoire reproductible.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

// Enregistrement synthétique : chirp émis avec un retard continu (donc indépendant
// de la fréquence d'échantillonnage de l'émetteur), échos et bruit.
function record({ sr, seconds, arrivals, noise = 0, seed = 1 }) {
  const rand = rng(seed);
  const out = new Float32Array(Math.round(seconds * sr));
  for (let i = 0; i < out.length; i++) {
    let v = noise * 2 * rand();
    for (const [delay, gain] of arrivals) v += gain * chirpSample(i / sr - delay);
    out[i] = v;
  }
  return out;
}

test('crossCorrelate correspond à la définition directe', () => {
  const s = Float32Array.from([1, 2, 3, 4, 5, 6]);
  const t = Float32Array.from([1, 0, -1]);
  const c = crossCorrelate(s, t);
  assert.equal(c.length, 4);
  for (const v of c) assert.ok(Math.abs(v - -2) < 1e-6);
});

for (const sr of [44100, 48000]) {
  test(`retard retrouvé à ${sr} Hz (polarité inversée, bruit)`, () => {
    const delay = 0.23417;
    const rec = record({ sr, seconds: 1.2, arrivals: [[delay, -0.3]], noise: 0.05 });
    const det = detectChirp(rec, makeChirp(sr), sr);
    assert.ok(Math.abs(det.index / sr - delay) < 0.0003, `mesuré ${det.index / sr}`);
    assert.ok(det.psr > 30, `psr ${det.psr}`);
  });
}

test('trajet direct retenu même si un écho est plus fort', () => {
  const sr = 48000, delay = 0.4;
  const rec = record({ sr, seconds: 1.2, arrivals: [[delay, 0.2], [delay + 0.007, 0.3], [delay + 0.031, 0.15]], noise: 0.02 });
  const det = detectChirp(rec, makeChirp(sr), sr);
  assert.ok(Math.abs(det.index / sr - delay) < 0.0003, `mesuré ${det.index / sr}`);
});

test('chirp détecté sous le bruit (signal 4x plus faible que le bruit)', () => {
  const sr = 48000, delay = 0.61;
  const rec = record({ sr, seconds: 1.2, arrivals: [[delay, 0.1]], noise: 0.4 });
  const det = detectChirp(rec, makeChirp(sr), sr);
  assert.ok(Math.abs(det.index / sr - delay) < 0.0003, `mesuré ${det.index / sr}`);
  assert.ok(det.psr > 10, `psr ${det.psr}`);
});

test('bruit seul : score sous le seuil de détection', () => {
  const sr = 48000;
  for (let seed = 1; seed <= 5; seed++) {
    const rec = record({ sr, seconds: 1.2, arrivals: [], noise: 0.3, seed });
    const det = detectChirp(rec, makeChirp(sr), sr);
    assert.ok(det.psr < 10, `psr ${det.psr}`);
  }
});
