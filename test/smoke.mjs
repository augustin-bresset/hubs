// Test de bout en bout dans Chrome sans écran (son coupé) : deux pages rejoignent,
// lisent le métronome, puis la page A se calibre via une boucle interne de 123 ms.
// Ne valide pas l'acoustique réelle, seulement la chaîne horloges -> programmation -> mesure.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const HTTP_PORT = 18080, HTTPS_PORT = 18443;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Clic déclenché dans la page : le clic « souris » de puppeteer attend un rendu qui n'arrive jamais dans un onglet en arrière-plan.
const click = (page, selector) => page.$eval(selector, (el) => el.click());

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, HTTP_PORT, HTTPS_PORT },
});
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes('prêt') && resolve());
  server.stderr.on('data', (d) => reject(new Error(String(d))));
});

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  headless: 'new',
  args: [
    '--mute-audio',
    '--ignore-certificate-errors',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
});

try {
  const errors = [];
  const open = async (url) => {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(url);
    return page;
  };
  const state = (page) => page.evaluate(() => {
    const { S } = window.unisson;
    return { id: S.id, rtt: S.clock.rtt, errMs: S.errMs, playing: !!S.play, latencyMs: S.latencyMs, lastCalib: S.lastCalib, clients: S.clients.length, probes: S.history.filter((h) => h.mode === 'probe'), testing: S.testing, tracks: S.history.filter((h) => h.mode === 'track'), sig: !!S.sig };
  });

  const a = await open(`http://localhost:${HTTP_PORT}/?loopback`);
  const b = await open(`https://localhost:${HTTPS_PORT}/`); // passe aussi par le chemin HTTPS
  await click(a, '#join');
  await sleep(1500);
  await click(a, '#play');
  await sleep(2500);
  await click(b, '#join'); // B arrive en cours de lecture
  await sleep(5000);

  let sa = await state(a), sb = await state(b);
  console.log('lecture   A:', sa.errMs?.toFixed(2), 'ms   B:', sb.errMs?.toFixed(2), 'ms   rtt', sa.rtt.toFixed(1), sb.rtt.toFixed(1));
  assert.equal(sa.clients, 2);
  assert.ok(sa.playing && sb.playing, 'les deux pages lisent');
  assert.ok(Math.abs(sa.errMs) < 3 && Math.abs(sb.errMs) < 3, 'écart de position sous 3 ms');

  const waitCalib = async (mode, previousId) => {
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const s = await state(a);
      if (s.lastCalib?.mode === mode && s.lastCalib.calibId !== previousId) return s;
    }
    throw new Error(`pas de résultat de calibration (${mode})`);
  };

  await click(a, '#calibrate');
  sa = await waitCalib('measure');
  const mine = sa.lastCalib.results.find((r) => r.client === sa.id);
  const other = sa.lastCalib.results.find((r) => r.client !== sa.id);
  console.log('calib     A:', mine.ms?.toFixed(2), 'ms (dispersion', mine.spreadMs?.toFixed(2), ')   B détecté :', other.detected);
  assert.ok(mine.detected, 'A détecté');
  assert.ok(Math.abs(mine.ms - 123) < 1, `latence de boucle attendue 123 ms, mesurée ${mine.ms}`);
  assert.ok(mine.spreadMs < 1, 'mesures répétables');
  assert.equal(other.detected, false, "B est inaudible pour A : ne doit pas être détecté");
  assert.ok(Math.abs(sa.latencyMs - mine.ms) < 0.1, 'compensation appliquée à A');
  assert.equal((await state(b)).playing, false, 'la calibration met la lecture en pause');

  await click(a, '#verify');
  sa = await waitCalib('verify');
  const residual = sa.lastCalib.results.find((r) => r.client === sa.id);
  console.log('vérif     A:', residual.ms?.toFixed(2), 'ms');
  assert.ok(residual.detected && Math.abs(residual.ms) < 1, `résidu attendu ~0, mesuré ${residual.ms}`);

  // Test de stabilité : mesures répétées sans toucher à la compensation, arrêt au second clic.
  await click(a, '#stability');
  for (let i = 0; i < 80 && (await state(a)).probes.length < 2; i++) await sleep(500);
  await click(a, '#stability');
  for (let i = 0; i < 40 && (await state(a)).testing; i++) await sleep(500);
  sa = await state(a);
  const probed = sa.probes.map((h) => h.results.find((r) => r.client === sa.id).ms);
  console.log('stabilité A:', probed.map((v) => v?.toFixed(2)).join(', '), 'ms');
  assert.ok(probed.length >= 2 && probed.length <= 3, `test arrêté après ${probed.length} mesures`);
  assert.ok(probed.every((v) => Math.abs(v - 123) < 1), 'mesures brutes stables autour de 123 ms');
  assert.ok(Math.abs(sa.latencyMs - mine.ms) < 0.1, 'la mesure seule ne modifie pas la compensation');

  // Une compensation de 123 ms sur A ne doit pas casser la reprise de lecture.
  await click(a, '#play');
  await sleep(5000);
  sa = await state(a); sb = await state(b);
  console.log('reprise   A:', sa.errMs?.toFixed(2), 'ms   B:', sb.errMs?.toFixed(2), 'ms');
  assert.ok(sa.playing && sb.playing);
  assert.ok(Math.abs(sa.errMs) < 3 && Math.abs(sb.errMs) < 3);

  // Suivi continu pendant la lecture : A retrouve sa propre signature sous le métronome,
  // au retard attendu (compensation déjà appliquée, donc proche de 0), sans rien corriger seul.
  await click(a, '#tracking');
  for (let i = 0; i < 80 && (await state(a)).tracks.length < 2; i++) await sleep(500);
  sa = await state(a); sb = await state(b);
  assert.ok(sa.sig && sb.sig, 'chaque appareil joue sa signature');
  const track = sa.tracks[sa.tracks.length - 1];
  const own = track.results.find((r) => r.client === sa.id);
  console.log('suivi     A:', own.ms?.toFixed(2), 'ms  score', own.psr.toFixed(1), ' glissement', own.driftPpm.toFixed(0), 'ppm   B score', track.results.find((r) => r.client !== sa.id).psr.toFixed(1));
  assert.ok(own.detected && Math.abs(own.ms) < 1, `signature de A attendue à ~0 ms, mesurée ${own.ms}`);
  assert.equal(track.results.find((r) => r.client !== sa.id).detected, false, 'signature de B inaudible pour A');
  assert.deepEqual(track.corrections, [], 'pas de correction avec un seul appareil détecté');
  assert.ok(Math.abs(sa.errMs) < 3 && Math.abs(sb.errMs) < 3, 'la lecture reste calée pendant le suivi');
  await click(a, '#tracking');
  await sleep(1500);
  sa = await state(a); sb = await state(b);
  assert.ok(!sa.sig && !sb.sig, 'signatures arrêtées avec le suivi');

  assert.deepEqual(errors, [], 'aucune erreur JavaScript');
  console.log('OK');
} finally {
  await browser.close();
  server.kill();
}
