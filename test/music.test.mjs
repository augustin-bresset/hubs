import test from 'node:test';
import assert from 'node:assert/strict';
import { PROBE, fft, makeBandstop, MusicAnalyzer, GapTracker } from '../public/dsp.js';
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
    console.log(`emplacement ${d.slot} : score ${r.score.toFixed(1)}, ${ms.toFixed(2)} ms (attendu ${expected.toFixed(2)}), glissement ${(r.drift * 1e6).toFixed(0)} ppm, niveau ${r.level.toFixed(1)} dB`);
    // Estimation grossière (une note tenue dans la bande la fausse de quelques dB) : elle ne sert
    // qu'à écarter une bande presque vide, 50 dB plus bas.
    assert.ok(!r.edge && Math.abs(r.level - 20 * Math.log10(d.gain)) < 6, `niveau ${r.level}`);
    assert.ok(r.score > 20, `emplacement ${d.slot} : score ${r.score}`);
    assert.ok(Math.abs(ms - expected) < 0.5, `emplacement ${d.slot} : ${ms} ms, attendu ${expected}`);
    measured.push({ client: d.slot, ms });
  }
  console.log(`emplacement 2 (muet) : score ${res.get(2).score.toFixed(1)}, niveau ${res.get(2).level.toFixed(1)} dB`);
  assert.ok(res.get(2).score < 8, `appareil muet : score ${res.get(2).score}`);

  // L'écart de 10 ms entre les deux appareils donne deux corrections opposées.
  const fixes = gapCorrections(measured);
  assert.ok(fixes[0].deltaMs > 2.5 && fixes[1].deltaMs < -2.5, JSON.stringify(fixes));
});

test('sans aucun bruit, les restes du filtrage ne passent pas pour un appareil', () => {
  const music = makeMusic(3.5), blocks = 12, pad = PROBE.maxLag + 3000;
  // Un seul appareil audible (emplacement 0), qui se tait dans la bande de l'emplacement 1.
  const signal = convolve(music, makeBandstop(SR, [PROBE.bands[1]]));
  const mic = Float32Array.from({ length: pad * 2 + blocks * PROBE.block }, (_, i) => at(signal, i - pad + DELAY));
  const analyzer = new MusicAnalyzer(SR, new Map([0, 1].map((s) => [s, PROBE.bands[s]])));
  for (let b = 0; b < blocks; b++) {
    const e = pad + b * PROBE.block;
    analyzer.addBlock(music.subarray(b * PROBE.block, (b + 1) * PROBE.block), mic.subarray(e - PROBE.maxLag, e + PROBE.block + PROBE.maxLag), (b * PROBE.block) / SR);
  }
  const res = analyzer.results();
  console.log(`audible : score ${res.get(0).score.toFixed(1)}, niveau ${res.get(0).level.toFixed(1)} dB | absent : score ${res.get(1).score.toFixed(1)}, niveau ${res.get(1).level.toFixed(1)} dB, bord ${res.get(1).edge}`);
  assert.ok(res.get(0).score > 20 && Math.abs(res.get(0).level) < 3 && Math.abs(res.get(0).lag) < 10);
  assert.ok(res.get(1).level < -40, `niveau ${res.get(1).level}`);
});

test('un silence dans la musique ne produit pas de mesure', () => {
  const analyzer = new MusicAnalyzer(SR, new Map([[0, PROBE.bands[0]]]));
  analyzer.addBlock(new Float32Array(PROBE.block), new Float32Array(PROBE.block + 2 * PROBE.maxLag), 0);
  assert.deepEqual(analyzer.results().get(0), { lag: 0, drift: 0, score: 0, blocks: 0, level: -Infinity, edge: false, driftIndex: 0, k0: 0 });
});

// Faux analyseur : un appareil net (« fort ») et un appareil dont le pic dépasse à peine le fond
// (« faible »), 40 échantillons après le premier. `shift` déplace les deux ensemble, comme le fait
// le trajet du micro d'une fenêtre à l'autre.
function fakeWindow(seed, shift, weakPeak = 2.5) {
  const rand = rng(seed), n = 2 * PROBE.maxLag + 1, width = 80;
  // Fond lissé sur 80 échantillons, comme l'est une vraie enveloppe de corrélation dans une bande étroite.
  const noisy = (center, height) => {
    const white = Float32Array.from({ length: n + width }, () => rand());
    let acc = 0;
    for (let i = 0; i < width; i++) acc += white[i];
    return Float32Array.from({ length: n }, (_, i) => {
      acc += white[i + width] - white[i];
      return 1 + acc / Math.sqrt(width) + height * Math.exp(-(((i - center) / 40) ** 2));
    });
  };
  const strongAt = PROBE.maxLag + shift;
  const profiles = { fort: noisy(strongAt, 60), faible: noisy(strongAt + 40, weakPeak) };
  return {
    results: () => new Map([
      ['fort', { lag: shift, drift: 0, score: 80, blocks: 32, level: 0, edge: false, driftIndex: 8, k0: shift }],
      ['faible', { lag: 1234, drift: 0, score: 5, blocks: 32, level: -20, edge: false, driftIndex: 3, k0: 1234 }],
    ]),
    profile: (key) => profiles[key],
  };
}

test('GapTracker : un appareil faible est reconnu en cumulant plusieurs fenêtres', () => {
  const tracker = new GapTracker(SR, { scoreMin: 12, levelMin: -30, minBlocks: 16 });
  const seen = [];
  [300, -120, 55, 410, -260, 90].forEach((shift, i) => {
    const r = tracker.update(fakeWindow(i + 1, shift));
    assert.deepEqual([r.get('fort').detected, r.get('fort').lag], [true, shift]);
    seen.push(r.get('faible'));
    if (r.get('faible').detected) assert.ok(Math.abs(r.get('faible').lag - (shift + 40)) <= 25, `retard ${r.get('faible').lag}, attendu ${shift + 40}`);
  });
  console.log(`appareil faible, fenêtre par fenêtre : ${seen.map((r) => `${r.detected ? 'oui' : 'non'} (${r.score.toFixed(1)})`).join(', ')}`);
  assert.deepEqual(seen.slice(0, 2).map((r) => r.detected), [false, false], 'pas avant trois fenêtres');
  assert.ok(seen[5].detected && seen[5].windows === 6);

  tracker.reset();
  assert.equal(tracker.update(fakeWindow(9, 10)).get('faible').detected, false, 'le cumul repart de zéro après reset');
});

test('GapTracker : sans rien dans sa bande, un appareil n’est jamais reconnu', () => {
  const tracker = new GapTracker(SR, { scoreMin: 12, levelMin: -30, minBlocks: 16 });
  for (let i = 0; i < 8; i++) assert.equal(tracker.update(fakeWindow(20 + i, 7 * i, 0)).get('faible').detected, false);
});
