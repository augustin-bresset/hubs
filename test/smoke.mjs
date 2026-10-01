// Test de bout en bout dans Chrome sans écran (son coupé) : deux pages rejoignent,
// lisent le métronome, puis la page A se calibre via une boucle interne de 123 ms.
// Ne valide pas l'acoustique réelle, seulement la chaîne horloges -> programmation -> mesure.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const HTTP_PORT = 18080, HTTPS_PORT = 18443;
// KEEP_CAPTURES=dossier garde les enregistrements du micro, pour essayer tools/analyze-capture.mjs.
const CAPTURE_DIR = process.env.KEEP_CAPTURES ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sync-captures-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-data-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Clic déclenché dans la page : le clic « souris » de puppeteer attend un rendu qui n'arrive jamais dans un onglet en arrière-plan.
const click = (page, selector) => page.$eval(selector, (el) => el.click());

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url).pathname,
  // Sans identifiants Google : la connexion de développement, ouverte depuis cette machine, sert au test.
  env: { ...process.env, HTTP_PORT, HTTPS_PORT, CAPTURE_DIR, DATA_DIR, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' },
});
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes('prêt') && resolve());
  server.stderr.on('data', (d) => reject(new Error(String(d))));
});

// BROWSER=firefox rejoue le même scénario sous Firefox, dont le moteur audio diffère de celui de Chrome.
const FIREFOX = process.env.BROWSER === 'firefox';
const TRACK_TOLERANCE_MS = FIREFOX ? 2.5 : 1; // sous Firefox la position de lecture flotte d'environ ±1 ms
const browser = await puppeteer.launch(FIREFOX ? {
  product: 'firefox',
  protocol: 'webDriverBiDi',
  executablePath: process.env.FIREFOX ?? '/usr/bin/firefox',
  headless: true,
  // Firefox en snap ne peut pas lire /tmp : profil dans le dépôt.
  userDataDir: new URL('../.ff-profile', import.meta.url).pathname,
  extraPrefsFirefox: {
    'media.volume_scale': '0.0',
    'media.autoplay.default': 0,
    'media.autoplay.blocking_policy': 0,
    'dom.min_background_timeout_value': 4,
    'dom.timeout.enable_budget_timer_throttling': false,
  },
} : {
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
  // L'écart de lecture est relevé cinq fois : une lecture isolée peut tomber sur un à-coup passager
  // (sous Firefox surtout), c'est la valeur médiane qui dit si la lecture est calée.
  const state = async (page) => {
    const errs = [];
    for (let i = 0; i < 5; i++) {
      errs.push(await page.evaluate(() => window.sync.S.errMs));
      await sleep(300);
    }
    const snapshot = await snapshotOf(page);
    const valid = errs.filter((v) => v !== null).sort((p, q) => p - q);
    return { ...snapshot, errMs: valid.length ? valid[valid.length >> 1] : null };
  };
  // Passage par du JSON : le pilotage de Firefox tronque les objets imbriqués.
  const snapshotOf = async (page) => JSON.parse(await page.evaluate(() => {
    const { S } = window.sync;
    return JSON.stringify({ id: S.id, rtt: S.clock.rtt, errMs: S.errMs, playing: !!S.play, latencyMs: S.latencyMs, lastCalib: S.lastCalib, clients: S.clients.length, probes: S.history.filter((h) => h.mode === 'probe'), testing: S.testing, tracks: S.history.filter((h) => h.mode === 'track'), notch: S.notchKey, wait: S.trackWait, live: !!S.live?.on, ringEnd: S.play?.ring?.end ?? 0, late: !!S.play?.late });
  }));

  // A se connecte depuis l'accueil et crée une salle, comme le ferait l'hôte.
  const a = await open(`http://localhost:${HTTP_PORT}/`);
  const code = await a.evaluate(async () => {
    const send = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    await send('/auth/dev', { name: 'Hôte' });
    return (await send('/api/rooms', { name: 'Salle de test' })).code;
  });
  assert.match(code ?? '', /^[A-Z2-9]{6}$/, 'salle créée après connexion');
  await a.goto(`http://localhost:${HTTP_PORT}/r/${code}?loopback`);
  // Sous Chrome, B passe par le chemin HTTPS (certificat auto-signé accepté par option).
  // B est un invité : autre nom d'hôte, donc pas le cookie de session de A (les cookies ignorent le port).
  const b = await open(FIREFOX ? `http://127.0.0.1:${HTTP_PORT}/r/${code}` : `https://127.0.0.1:${HTTPS_PORT}/r/${code}`);
  await sleep(500);
  const uploadHidden = (page) => page.$eval('#fileLabel', (el) => el.hidden);
  assert.equal(await uploadHidden(a), false, "l'hôte peut envoyer un morceau");
  assert.equal(await uploadHidden(b), true, "un invité ne le peut pas");
  await click(a, '#join');
  await sleep(2500);
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

  // Suivi continu par la musique. A envoie un morceau (bruit large bande), le lit, puis écoute :
  // il doit se retrouver dans sa propre bande au retard attendu (compensation déjà appliquée, donc
  // proche de 0) et ne pas trouver B, inaudible pour lui, dans la bande que A lui laisse.
  await a.evaluate(async () => {
    const sr = 48000, n = sr * 4, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    let seed = 1;
    for (let i = 0; i < n; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; v.setInt16(44 + i * 2, (seed / 2 ** 32 - 0.5) * 16000, true); }
    const sent = await fetch(`/api/rooms/${location.pathname.split('/')[2]}/track?name=bruit.wav`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: buf });
    if (!sent.ok) throw new Error(`envoi refusé (${sent.status})`);
  });
  await sleep(500);
  await click(a, '#tracking');
  await sleep(1500);
  sa = await state(a); sb = await state(b);
  assert.ok(sa.wait.includes('ne joue pas'), `sans musique, le suivi attend (« ${sa.wait} »)`);
  assert.equal(sa.notch, '1', "A retire la bande de B");
  assert.equal(sb.notch, '0', "B retire la bande de A");
  await click(a, '#play');
  for (let i = 0; i < 80 && (await state(a)).tracks.length < 2; i++) await sleep(500);
  sa = await state(a); sb = await state(b);
  assert.ok(sa.tracks.length >= 2, 'mesures de suivi reçues');
  const track = sa.tracks[sa.tracks.length - 1];
  const own = track.results.find((r) => r.client === sa.id);
  const peer = track.results.find((r) => r.client !== sa.id);
  console.log('suivi     A:', own.ms?.toFixed(2), 'ms  score', own.psr.toFixed(1), ' glissement', own.driftPpm.toFixed(0), 'ppm   B score', peer.psr.toFixed(1));
  assert.ok(own.detected && Math.abs(own.ms) < TRACK_TOLERANCE_MS, `A attendu à ~0 ms, mesuré ${own.ms}`);
  assert.equal(peer.detected, false, 'B inaudible pour A : rien dans sa bande');
  assert.deepEqual(track.corrections, [], 'pas de correction avec un seul appareil reconnu');
  assert.ok(Math.abs(sa.errMs) < 3 && Math.abs(sb.errMs) < 3, 'la lecture reste calée pendant le suivi');
  await click(a, '#tracking');
  await sleep(1500);
  sa = await state(a); sb = await state(b);
  assert.ok(sa.notch === '' && sb.notch === '', 'filtres retirés avec le suivi');

  // Direct : A diffuse un bruit de test capté sur place ; A et B le rejouent, calés sur l'horloge
  // commune, puis A se retrouve dans ce flux comme il se retrouvait dans le fichier.
  const chosen = await a.$eval('#liveSource', (el) => { el.value = 'test'; return `${el.value} parmi ${[...el.options].map((o) => o.value).join(',')}`; });
  assert.ok(chosen.startsWith('test '), `source de test sélectionnée (${chosen})`);
  await click(a, '#liveToggle');
  for (let i = 0; i < 20 && !((await state(b)).ringEnd > 96000); i++) await sleep(300);
  await sleep(3000);
  sa = await state(a); sb = await state(b);
  console.log('direct    A:', sa.errMs?.toFixed(2), 'ms   B:', sb.errMs?.toFixed(2), 'ms   reçu par B :', (sb.ringEnd / 48000).toFixed(1), 's');
  assert.ok(sa.live && sb.live, `direct annoncé aux deux appareils (page : « ${await a.$eval('#liveInfo', (el) => el.textContent)} »)`);
  assert.ok(sb.ringEnd > 96000, 'B reçoit le flux');
  assert.ok(sa.playing && sb.playing && !sa.late && !sb.late, 'le son arrive à temps');
  assert.ok(Math.abs(sa.errMs) < 3 && Math.abs(sb.errMs) < 3, 'lecture du direct calée à moins de 3 ms');

  const before = sa.tracks.length;
  await click(a, '#tracking');
  for (let i = 0; i < 80 && (await state(a)).tracks.length < before + 2; i++) await sleep(500);
  sa = await state(a);
  assert.ok(sa.tracks.length >= before + 2, 'mesures de suivi pendant le direct');
  const liveOwn = sa.tracks[sa.tracks.length - 1].results.find((r) => r.client === sa.id);
  console.log('suivi en direct A:', liveOwn.ms?.toFixed(2), 'ms  score', liveOwn.psr.toFixed(1));
  assert.ok(liveOwn.detected && Math.abs(liveOwn.ms) < TRACK_TOLERANCE_MS, `A attendu à ~0 ms dans le direct, mesuré ${liveOwn.ms}`);
  await click(a, '#tracking');
  await click(a, '#liveToggle');
  await sleep(1500);
  sa = await state(a); sb = await state(b);
  assert.ok(!sa.live && !sb.live && !sa.playing && !sb.playing, 'direct arrêté partout');

  const captures = fs.readdirSync(path.join(CAPTURE_DIR, code));
  assert.ok(captures.some((f) => f.endsWith('.f32')) && captures.some((f) => f.endsWith('.json')), 'enregistrement du micro reçu par le serveur');

  assert.deepEqual(errors, [], 'aucune erreur JavaScript');
  console.log('OK');
} finally {
  await browser.close();
  server.kill();
  if (!process.env.KEEP_CAPTURES) fs.rmSync(CAPTURE_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}
