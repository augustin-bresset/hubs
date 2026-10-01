import test from 'node:test';
import assert from 'node:assert/strict';
import { fitClock, localToServer, serverToLocal } from '../public/sync.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// Allers-retours simulés : horloge serveur = locale + offset0 + drift * locale, trajets aller et
// retour de durées aléatoires indépendantes (donc asymétriques), comme sur un Wi-Fi de téléphone.
function simulate({ seconds, drift, offset0, seed = 1 }) {
  const rand = rng(seed);
  const samples = [];
  for (let at = 0; at < seconds * 1000; at += 350) {
    const up = 4 + 25 * rand() ** 2, down = 4 + 25 * rand() ** 2;
    const t0 = at, t1 = at + up + down;
    const server = t0 + up + offset0 + drift * (t0 + up);
    samples.push({ at: t1, rtt: t1 - t0, offset: server - (t0 + t1) / 2 });
  }
  return samples;
}

test('fitClock suit la dérive entre les deux horloges', () => {
  for (const drift of [40e-6, -120e-6]) {
    const offset0 = 123456.7;
    const samples = simulate({ seconds: 60, drift, offset0 });
    const clock = fitClock(samples);
    const now = samples[samples.length - 1].at;
    const truth = now + offset0 + drift * now;
    assert.ok(Math.abs(localToServer(clock, now) - truth) < 1.5, `erreur ${localToServer(clock, now) - truth} ms`);
    assert.ok(Math.abs(clock.b - drift) < 60e-6, `pente ${clock.b}`);
  }
});

test('fitClock : trop peu de recul, on garde le meilleur aller-retour sans pente', () => {
  const clock = fitClock(simulate({ seconds: 5, drift: 40e-6, offset0: 1000 }));
  assert.equal(clock.b, 0);
  assert.ok(Math.abs(clock.a - 1000) < 8);
});

test('les conversions serveur <-> local sont inverses', () => {
  const clock = { a: 5000.25, b: 80e-6, t0: 90000 };
  for (const local of [0, 12345.678, 3.6e6]) {
    assert.ok(Math.abs(serverToLocal(clock, localToServer(clock, local)) - local) < 1e-6);
  }
});
