import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE, encodeFrame, FrameParser, fitStreamClock, StreamRing } from '../public/live.js';

test('les tranches survivent à un découpage quelconque par le réseau', () => {
  const frames = [0, 1, 2].map((k) => ({ n: 4800 * k, t: 1000.5 + 100 * k, channels: 2, pcm: Int16Array.from({ length: 9600 }, (_, i) => ((i * 7 + k * 13) % 2000) - 1000) }));
  const bytes = new Uint8Array(frames.reduce((sum, f) => sum + LIVE.header + f.pcm.byteLength, 0));
  let at = 0;
  for (const f of frames) { const e = encodeFrame(f); bytes.set(e, at); at += e.length; }
  for (const cut of [1, 7, 23, 24, 25, 1000, 19223, bytes.length]) {
    const parser = new FrameParser(), out = [];
    for (let i = 0; i < bytes.length; i += cut) out.push(...parser.push(bytes.subarray(i, i + cut)));
    assert.equal(out.length, 3, `découpe ${cut}`);
    out.forEach((f, k) => {
      assert.deepEqual([f.n, f.t, f.channels], [frames[k].n, frames[k].t, 2]);
      assert.deepEqual(f.pcm, frames[k].pcm);
    });
  }
});

test('l’horloge du flux suit le rythme réel de la carte son de l’hôte', () => {
  const sr = 48000, drift = 1 + 120e-6; // la carte son tourne 120 ppm trop vite
  let seed = 5;
  const noise = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 - 0.5; };
  const points = [];
  for (let k = 0; k < 300; k++) points.push({ n: 4800 * k, t: 5000 + (100 * k) / drift + 1.5 * noise() });
  const clock = fitStreamClock(points, sr);
  assert.ok(Math.abs(clock.rate / (sr / 1000) - drift) < 20e-6, `pente ${clock.rate}`);
  const truth = 5000 + (100 * 299) / drift;
  assert.ok(Math.abs(clock.msAt(4800 * 299) - truth) < 0.3, `erreur ${clock.msAt(4800 * 299) - truth} ms`);
  assert.ok(Math.abs(clock.posAt(clock.msAt(123456)) - 123456) < 1e-6);
  // Avec trop peu de recul, on garde la fréquence nominale.
  assert.equal(fitStreamClock(points.slice(0, 10), sr).rate, sr / 1000);
});

test('le tampon rend la musique reçue, signale ce qui manque et oublie le plus ancien', () => {
  const ring = new StreamRing(1000); // 20 000 échantillons
  const block = (n, len) => Float32Array.from({ length: len }, (_, i) => n + i);
  ring.write(5000, block(5000, 1000));
  ring.write(6000, block(6000, 1000));
  const out = new Float32Array(500);
  assert.equal(ring.read(5750, out), true);
  assert.deepEqual([out[0], out[499]], [5750, 6249]);
  assert.equal(ring.read(4900, out), false, 'avant le début');
  assert.equal(ring.read(6600, out), false, 'pas encore reçu');
  ring.write(8000, block(8000, 1000)); // la tranche 7000-7999 est perdue
  assert.equal(ring.read(7200, out), true);
  assert.ok(out.every((v) => v === 0), 'le trou vaut zéro');
  ring.write(9000, block(9000, 19000)); // dépasse la capacité
  assert.equal(ring.read(5750, out), false, 'trop ancien');
  assert.equal(ring.read(27000, out), true);
  assert.equal(out[0], 27000);
});
