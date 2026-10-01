import test from 'node:test';
import assert from 'node:assert/strict';
import { SIG, makeSignature, signatureTemplates, SignatureAnalyzer } from '../public/dsp.js';
import { gapCorrections } from '../public/sync.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

// Valeur de la signature périodique à une position fractionnaire (interpolation linéaire).
function sigAt(sig, x) {
  const n = sig.length;
  const i = Math.floor(x), f = x - i;
  const a = sig[((i % n) + n) % n], b = sig[(((i + 1) % n) + n) % n];
  return a + f * (b - a);
}

// Micro simulé : « musique » (bruit large bande fort + notes tenues dans la bande utile) et
// signatures retardées. `ppm` fait tourner l'horloge de l'émetteur plus ou moins vite.
function simulate({ periods, emitters, musicRms, seed = 7 }) {
  const rand = rng(seed);
  const pad = SIG.maxLag + 2000;
  const mic = new Float32Array(pad * 2 + periods * SIG.length);
  const sigs = emitters.map((e) => makeSignature(e.code));
  for (let i = 0; i < mic.length; i++) {
    const t = i / SIG.rate;
    let v = musicRms * Math.sqrt(12) * rand();
    v += 0.2 * Math.sin(2 * Math.PI * 2637 * t) + 0.15 * Math.sin(2 * Math.PI * 3520 * t) * (1 + 0.5 * Math.sin(2 * Math.PI * 3 * t));
    emitters.forEach((e, d) => {
      const x = (i - pad) * (1 + (e.ppm ?? 0) * 1e-6) - (e.delayMs / 1000) * SIG.rate;
      v += e.level * sigAt(sigs[d], x);
    });
    mic[i] = v;
  }
  return { mic, pad };
}

function analyze(mic, pad, periods, codes) {
  const analyzer = new SignatureAnalyzer(new Map(codes.map((c) => [c, signatureTemplates(makeSignature(c))])));
  const blocks = SIG.length / SIG.block;
  for (let m = 0; m < periods; m++) {
    for (let j = 0; j < blocks; j++) {
      const expected = pad + m * SIG.length + j * SIG.block;
      analyzer.addBlock(j, mic.subarray(expected - SIG.maxLag, expected + SIG.block + SIG.maxLag), (m * SIG.length + j * SIG.block) / SIG.rate);
    }
  }
  return analyzer.results();
}

test('la signature est normalisée et limitée à sa bande', () => {
  const sig = makeSignature(3);
  let energy = 0, peak = 0;
  for (const v of sig) { energy += v * v; peak = Math.max(peak, Math.abs(v)); }
  assert.ok(Math.abs(Math.sqrt(energy / sig.length) - 1) < 1e-6);
  assert.ok(peak < 6, `facteur de crête ${peak}`);
  assert.notDeepEqual(makeSignature(3).subarray(0, 8), makeSignature(4).subarray(0, 8));
  assert.deepEqual(makeSignature(3).subarray(0, 8), sig.subarray(0, 8));
});

test('deux signatures retrouvées 20 dB sous la musique, une absente rejetée', () => {
  const musicRms = 0.3; // dans la bande 2-6 kHz : 0,3 / sqrt(6) = 0,12, sans compter les notes tenues
  const level = 0.012; // signature 20 dB sous la musique dans la bande, 28 dB en large bande
  const emitters = [
    { code: 0, delayMs: 3.2, level },
    { code: 1, delayMs: -7.9, level, ppm: 150 },
  ];
  const { mic, pad } = simulate({ periods: 4, emitters, musicRms });
  const res = analyze(mic, pad, 4, [0, 1, 2]);
  for (const e of emitters) {
    const r = res.get(e.code);
    const ms = (r.lag / SIG.rate) * 1000;
    // L'émetteur à +150 ppm avance de 0,8 ms pendant la fenêtre : on attend son retard au milieu.
    const tMid = (4 * SIG.length - SIG.block) / 2 / SIG.rate;
    const expected = e.delayMs - (e.ppm ?? 0) * 1e-6 * tMid * 1000;
    console.log(`code ${e.code} : score ${r.score.toFixed(1)}, ${ms.toFixed(2)} ms (attendu ${expected.toFixed(2)}), glissement ${(r.drift * 1e6).toFixed(0)} ppm`);
    assert.ok(r.score > 12, `code ${e.code} : score ${r.score}`);
    assert.ok(Math.abs(ms - expected) < 0.3, `code ${e.code} : ${ms} ms, attendu ${expected}`);
    assert.ok(Math.abs(r.drift * 1e6 + (e.ppm ?? 0)) <= 50, `glissement ${r.drift}`);
  }
  console.log(`signature absente : score ${res.get(2).score.toFixed(1)}`);
  assert.ok(res.get(2).score < 7, `signature absente : score ${res.get(2).score}`);
});

test('en silence, une signature très faible suffit', () => {
  const emitters = [{ code: 5, delayMs: 42, level: 0.001 }];
  const { mic, pad } = simulate({ periods: 2, emitters, musicRms: 0.0005 });
  const res = analyze(mic, pad, 2, [5]);
  const r = res.get(5);
  assert.ok(r.score > 8, `score ${r.score}`);
  assert.ok(Math.abs((r.lag / SIG.rate) * 1000 - 42) < 0.3);
});

test('gapCorrections ramène chaque appareil vers la moyenne, sans toucher aux petits écarts', () => {
  assert.deepEqual(gapCorrections([{ client: 'a', ms: 5 }]), []);
  assert.deepEqual(gapCorrections([{ client: 'a', ms: 150.2 }, { client: 'b', ms: 150.4 }]), []);
  const out = gapCorrections([{ client: 'a', ms: 100 }, { client: 'b', ms: 110 }]);
  assert.deepEqual(out.map((c) => c.client), ['a', 'b']);
  assert.ok(Math.abs(out[0].deltaMs + 3) < 1e-9 && Math.abs(out[1].deltaMs - 3) < 1e-9);
  const big = gapCorrections([{ client: 'a', ms: 0 }, { client: 'b', ms: 200 }]);
  assert.deepEqual(big.map((c) => c.deltaMs), [-15, 15]);
});
