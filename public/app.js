import { makeChirp, detectChirp, median } from './dsp.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
// ?loopback : le micro est remplacé par une boucle interne de retard connu (tests automatiques).
const LOOPBACK = params.has('loopback');
const LOOPBACK_DELAY = 0.123;

const PSR_MIN = 10; // score minimal pour considérer un chirp comme détecté
const HARD_RESYNC_S = 0.06; // au-delà, on recale d'un coup plutôt que d'ajuster la vitesse
const DEADBAND_S = 0.0015;
const MAX_RATE_DEV = 0.01;
const STABILITY_ROUNDS = 10;
const MODE_LABEL = { measure: 'calibration', verify: 'vérification', probe: 'mesure' };

const isMobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);

const S = {
  id: sessionStorage.getItem('unisson.id') || Math.random().toString(36).slice(2, 10),
  name: localStorage.getItem('unisson.name') || `${isMobile ? 'Téléphone' : 'Ordi'} ${Math.floor(Math.random() * 90 + 10)}`,
  ready: false,
  connected: false,
  ctx: null,
  master: null,
  chirpBus: null,
  chirpBuf: null,
  clock: { offset: 0, rtt: Infinity, samples: [] }, // heure serveur = performance.now() + offset
  deltas: [],
  ctxDelta: 0, // performance.now()/1000 - ctx.currentTime
  latencyMs: 0,
  latencySource: 'aucune',
  playback: null,
  track: null,
  buffers: new Map(),
  loading: null,
  play: null,
  errMs: null,
  lastResync: 0,
  clients: [],
  recorder: null,
  micStream: null,
  micLabel: '',
  chunks: [],
  lastCalib: null,
  calibBusy: false,
  calibWaiters: new Map(),
  history: [],
  testing: false,
  testRound: 0,
};
sessionStorage.setItem('unisson.id', S.id);

function log(...parts) {
  const line = `${new Date().toLocaleTimeString()}  ${parts.join(' ')}`;
  $('log').textContent = `${line}\n${$('log').textContent}`.slice(0, 8000);
  console.log('[unisson]', ...parts);
}

async function cmd(type, extra = {}) {
  const r = await fetch('/api/cmd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, id: S.id, ...extra }),
  });
  const out = await r.json();
  if (!out.ok) log(`commande ${type} refusée :`, out.error ?? '');
  return out;
}

// --- Horloges ---------------------------------------------------------------
// Trois horloges : serveur (référence commune), performance.now() locale, et l'horloge
// du contexte audio (celle de la carte son / de l'enceinte), qui dérive par rapport aux deux autres.

async function pingClock() {
  const t0 = performance.now();
  const r = await fetch('/api/time', { cache: 'no-store' });
  const t = Number(await r.text());
  const t1 = performance.now();
  const c = S.clock;
  const boot = r.headers.get('x-boot');
  if (boot !== c.boot) {
    // Serveur redémarré : les mesures faites avec l'ancienne horloge ne valent plus rien.
    c.boot = boot;
    c.samples = [];
  }
  c.samples.push({ rtt: t1 - t0, offset: t - (t0 + t1) / 2, at: t1 });
  c.samples = c.samples.filter((s) => t1 - s.at < 30000).slice(-90);
  // L'aller-retour le plus court est le moins perturbé, donc le plus symétrique.
  const best = c.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  c.offset = best.offset;
  c.rtt = best.rtt;
}

async function clockLoop() {
  for (;;) {
    // Rafale de trois : en Wi-Fi, le premier aller-retour réveille la radio du téléphone,
    // les suivants sont plus courts et plus symétriques.
    for (let i = 0; i < 3; i++) {
      try {
        await pingClock();
      } catch {
        S.clock.rtt = Infinity;
      }
    }
    await new Promise((r) => setTimeout(r, S.clock.samples.length < 12 ? 150 : 1000));
  }
}

function sampleCtxDelta() {
  const ctx = S.ctx;
  if (!ctx || ctx.state !== 'running') return;
  const at = performance.now();
  // currentTime avance par blocs : la valeur lue est en retard d'un temps variable.
  // Les plus petits écarts de la fenêtre sont les lectures faites juste après une mise à jour ;
  // on prend le 10e centile plutôt que le minimum pour ignorer un à-coup isolé du fil audio.
  S.deltas.push({ at, d: at / 1000 - ctx.currentTime });
  S.deltas = S.deltas.filter((s) => at - s.at < 4000);
  const sorted = S.deltas.map((s) => s.d).sort((a, b) => a - b);
  S.ctxDelta = sorted[Math.floor(0.1 * (sorted.length - 1))];
}

// Échantillonnage à intervalles irréguliers, pour ne pas se caler sur le rythme des blocs audio.
function ctxDeltaLoop() {
  sampleCtxDelta();
  setTimeout(ctxDeltaLoop, 25 + Math.random() * 50);
}

const serverNow = () => performance.now() + S.clock.offset;
const serverToCtx = (ms) => (ms - S.clock.offset) / 1000 - S.ctxDelta;
const ctxToServer = (t) => (t + S.ctxDelta) * 1000 + S.clock.offset;

// --- Lecture ----------------------------------------------------------------

function makeMetronome(ctx) {
  const sr = ctx.sampleRate, beats = 16, beat = 0.5;
  const buf = ctx.createBuffer(1, Math.round(beats * beat * sr), sr);
  const d = buf.getChannelData(0);
  for (let b = 0; b < beats; b++) {
    const f = b === 0 ? 2000 : b % 4 === 0 ? 1500 : 1000;
    const start = Math.round(b * beat * sr);
    const n = Math.round(0.04 * sr);
    for (let i = 0; i < n; i++) d[start + i] = 0.7 * Math.sin((2 * Math.PI * f * i) / sr) * Math.exp(-i / (0.008 * sr));
  }
  return buf;
}

function getBuffer(trackId) {
  if (S.buffers.has(trackId)) return Promise.resolve(S.buffers.get(trackId));
  if (S.loading?.id !== trackId) {
    const promise = (async () => {
      log('chargement de la piste…');
      const r = await fetch(`/api/track/${trackId}`);
      if (!r.ok) throw new Error('piste introuvable sur le serveur');
      const buf = await S.ctx.decodeAudioData(await r.arrayBuffer());
      S.buffers.set(trackId, buf);
      log(`piste prête (${buf.duration.toFixed(1)} s)`);
      return buf;
    })();
    S.loading = { id: trackId, promise };
  }
  return S.loading.promise;
}

function stopSource() {
  const p = S.play;
  if (!p) return;
  S.play = null;
  S.errMs = null;
  const t = S.ctx.currentTime;
  p.gain.gain.cancelScheduledValues(t);
  p.gain.gain.setValueAtTime(p.gain.gain.value, t);
  p.gain.gain.linearRampToValueAtTime(0, t + 0.015);
  try {
    p.src.stop(t + 0.02);
  } catch { /* déjà arrêtée */ }
}

function startSource(buf) {
  const ctx = S.ctx, pb = S.playback;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const gain = ctx.createGain();
  src.connect(gain).connect(S.master);

  // Le son doit sortir de l'enceinte à l'heure serveur S0 : on le lance en avance de la latence.
  let when = serverToCtx(pb.S0) - S.latencyMs / 1000;
  let pos = pb.P0;
  const earliest = ctx.currentTime + 0.08;
  if (when < earliest) {
    pos += earliest - when; // on arrive en cours de route
    when = earliest;
  }
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(1, when + 0.02);
  src.start(when, ((pos % buf.duration) + buf.duration) % buf.duration);
  S.play = { src, gain, pb, anchorCtx: when, anchorPos: pos, rate: 1 };
}

async function applyPlayback() {
  stopSource();
  const pb = S.playback;
  if (!S.ready || !pb?.playing) return;
  let buf;
  try {
    buf = await getBuffer(pb.track);
  } catch (err) {
    log('lecture impossible :', err.message);
    return;
  }
  if (S.playback !== pb || S.play) return; // l'état a changé pendant le chargement
  startSource(buf);
}

// Compare la position réellement jouée à celle voulue par l'horloge serveur et corrige :
// petite variation de vitesse pour les écarts faibles, recalage franc sinon.
function driftTick() {
  const p = S.play, ctx = S.ctx;
  if (!p || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  if (t < p.anchorCtx) return;
  const actual = p.anchorPos + (t - p.anchorCtx) * p.rate;
  const wanted = p.pb.P0 + (ctxToServer(t + S.latencyMs / 1000) - p.pb.S0) / 1000;
  const err = actual - wanted;
  S.errMs = err * 1000;

  if (Math.abs(err) > HARD_RESYNC_S) {
    if (performance.now() - S.lastResync > 1000) {
      S.lastResync = performance.now();
      log(`recalage (écart ${S.errMs.toFixed(1)} ms)`);
      applyPlayback();
    }
    return;
  }
  const rate = Math.abs(err) > DEADBAND_S ? 1 - Math.max(-MAX_RATE_DEV, Math.min(MAX_RATE_DEV, err / 2)) : 1;
  if (rate !== p.rate) {
    p.anchorPos = actual;
    p.anchorCtx = t;
    p.rate = rate;
    p.src.playbackRate.value = rate;
  }
}

function setLatency(ms, source) {
  S.latencyMs = Math.max(-200, Math.min(2000, Math.round(ms * 10) / 10));
  S.latencySource = source;
  sessionStorage.setItem('unisson.latency', JSON.stringify({ ms: S.latencyMs, source }));
  reportStatus();
  render();
}

// --- Calibration au micro ---------------------------------------------------

async function ensureRecorder() {
  if (S.recorder) return;
  const ctx = S.ctx;
  await ctx.audioWorklet.addModule('recorder-worklet.js');
  const node = new AudioWorkletNode(ctx, 'recorder');
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination); // garde le nœud actif sans rien faire entendre
  node.port.onmessage = (e) => S.chunks.push(e.data);

  if (LOOPBACK) {
    const delay = ctx.createDelay(1);
    delay.delayTime.value = LOOPBACK_DELAY;
    S.chirpBus.connect(delay).connect(node);
    S.micLabel = 'boucle interne (test)';
  } else {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('micro indisponible : ouvre la page en https:// (ou via localhost)');
    // Tous les traitements voix sont coupés : l'annulation d'écho effacerait nos propres signaux.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    S.micStream = stream;
    S.micSource = ctx.createMediaStreamSource(stream);
    S.micSource.connect(node);
    S.micLabel = stream.getAudioTracks()[0]?.label || 'micro';
  }
  S.recorder = node;
  render();
}

function releaseMic() {
  S.micStream?.getTracks().forEach((t) => t.stop());
  S.micSource?.disconnect();
  S.recorder?.disconnect();
  S.micStream = S.micSource = S.recorder = null;
  S.micLabel = '';
  render();
}

function playChirpAt(when) {
  if (when < S.ctx.currentTime + 0.02) {
    log('chirp ignoré : arrivé trop tard pour être programmé');
    return;
  }
  const src = S.ctx.createBufferSource();
  src.buffer = S.chirpBuf;
  src.connect(S.chirpBus);
  src.start(when);
}

// Modes : 'measure' mesure et applique la compensation, 'verify' rejoue avec compensation,
// 'probe' mesure sans rien appliquer (suivi de la stabilité).
// Renvoie le résultat une fois l'analyse terminée, ou null si la calibration n'a pas pu partir.
async function runCalibration(mode) {
  if (S.calibBusy) return null;
  try {
    await ensureRecorder();
  } catch (err) {
    log('micro :', err.message);
    $('micInfo').textContent = `Micro inaccessible : ${err.message}`;
    return null;
  }
  const out = await cmd('calib', { mode });
  if (!out.ok) return null;
  return new Promise((resolve) => {
    S.calibWaiters.set(out.calibId, resolve);
    setTimeout(() => {
      if (S.calibWaiters.delete(out.calibId)) resolve(null);
    }, 60000);
  });
}

async function stabilityTest() {
  if (S.testing) {
    S.testing = false; // second clic : arrêt après la mesure en cours
    return;
  }
  S.testing = true;
  for (let i = 0; i < STABILITY_ROUNDS && S.testing; i++) {
    S.testRound = i + 1;
    render();
    if (!(await runCalibration('probe'))) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  S.testing = false;
  render();
}

function onCalib(ev) {
  if (!S.ready) return;
  const listening = ev.listener === S.id && !!S.recorder;
  const lead = ev.mode === 'verify' ? S.latencyMs / 1000 : 0;
  const expected = [];
  for (const e of ev.schedule) {
    const mine = e.client === S.id;
    if (!mine && !listening) continue;
    // Conversion vers l'horloge audio faite au dernier moment, avec l'estimation la plus fraîche.
    setTimeout(() => {
      const ctxT = serverToCtx(e.T);
      if (mine) playChirpAt(ctxT - lead);
      if (listening) expected.push({ ...e, ctxT });
    }, Math.max(0, e.T - serverNow() - lead * 1000 - 600));
  }

  if (!listening) return;
  S.calibBusy = true;
  S.chunks = [];
  S.recorder.port.postMessage({ on: true });
  render();
  setTimeout(async () => {
    S.recorder?.port.postMessage({ on: false });
    await new Promise((r) => setTimeout(r, 250));
    try {
      await cmd('calibResult', { result: analyze(ev, expected) });
    } catch (err) {
      log('analyse impossible :', err.message);
    }
    S.calibBusy = false;
    render();
  }, Math.max(0, ev.end - serverNow()) + 300);
}

function analyze(ev, expected) {
  const sr = S.ctx.sampleRate;
  const chunks = S.chunks;
  if (!chunks.length) throw new Error('aucun son enregistré');
  const first = Math.min(...chunks.map((c) => c.start));
  const last = Math.max(...chunks.map((c) => c.start + c.data.length));
  const rec = new Float32Array(last - first);
  for (const c of chunks) rec.set(c.data, c.start - first);

  const template = makeChirp(sr);
  const byClient = new Map();
  for (const e of expected) {
    const center = Math.round(e.ctxT * sr) - first;
    const a = Math.max(0, center - Math.round(0.15 * sr));
    const b = Math.min(rec.length, center + Math.round(1.0 * sr) + template.length);
    const det = b - a > template.length ? detectChirp(rec.subarray(a, b), template, sr) : null;
    const entry = byClient.get(e.client) ?? { client: e.client, name: e.name, reps: [] };
    entry.reps.push(det && det.psr >= PSR_MIN ? { ms: ((a + det.index - center) / sr) * 1000, psr: det.psr } : { ms: null, psr: det?.psr ?? 0 });
    byClient.set(e.client, entry);
  }

  const results = [...byClient.values()].map((r) => {
    const ok = r.reps.filter((x) => x.ms !== null).map((x) => x.ms);
    const detected = ok.length >= 2;
    return {
      client: r.client,
      name: r.name,
      detected,
      ms: detected ? median(ok) : null,
      spreadMs: detected ? Math.max(...ok) - Math.min(...ok) : null,
      psr: Math.max(...r.reps.map((x) => x.psr)),
      hits: ok.length,
      reps: r.reps.length,
    };
  });
  return { calibId: ev.calibId, mode: ev.mode, listener: S.id, mic: S.micLabel, results };
}

function onCalibResult(res) {
  S.lastCalib = res;
  S.history.push(res);
  const mine = res.results.find((r) => r.client === S.id);
  if (res.mode === 'measure' && mine?.detected) setLatency(mine.ms, 'micro');
  S.calibWaiters.get(res.calibId)?.(res);
  S.calibWaiters.delete(res.calibId);
  render();
}

// --- Événements serveur -----------------------------------------------------

function reportStatus() {
  const ctx = S.ctx;
  cmd('status', {
    name: S.name,
    ready: S.ready,
    status: ctx && {
      latencyMs: S.latencyMs,
      latencySource: S.latencySource,
      errMs: S.errMs,
      rtt: Number.isFinite(S.clock.rtt) ? S.clock.rtt : null,
      sampleRate: ctx.sampleRate,
      reportedMs: ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000,
      state: ctx.state,
    },
  }).catch(() => {});
}

function connectEvents() {
  const es = new EventSource(`/api/events?id=${S.id}&name=${encodeURIComponent(S.name)}`);
  const on = (name, fn) => es.addEventListener(name, (e) => fn(JSON.parse(e.data)));
  const onPlayback = (d) => {
    // Une reconnexion renvoie l'état courant : inutile de couper le son s'il n'a pas changé.
    if (S.play && JSON.stringify(d) === JSON.stringify(S.playback)) return;
    S.playback = d;
    applyPlayback();
  };
  on('hello', (d) => {
    S.connected = true;
    S.clients = d.clients;
    S.track = d.track;
    S.history = d.history ?? [];
    onPlayback(d.playback);
    reportStatus();
    render();
  });
  on('clients', (d) => { S.clients = d; render(); });
  on('track', (d) => { S.track = d; render(); });
  on('playback', (d) => { onPlayback(d); render(); });
  on('setLatency', (d) => { if (d.target === S.id) setLatency(S.latencyMs + d.deltaMs, 'manuelle'); });
  on('calib', onCalib);
  on('calibResult', onCalibResult);
  es.onerror = () => { S.connected = false; render(); };
}

// --- Interface --------------------------------------------------------------

const fmt = (v, digits = 1) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(digits));
const deviceRows = new Map();

function renderDevices() {
  const box = $('devices');
  const seen = new Set();
  for (const c of S.clients) {
    seen.add(c.id);
    let row = deviceRows.get(c.id);
    if (!row) {
      const el = document.createElement('div');
      el.className = 'device';
      el.innerHTML = '<div class="title"><span class="name"></span><span class="lat"></span></div><div class="meta"></div><div class="nudge"></div>';
      for (const step of [-10, -1, 1, 10]) {
        const b = document.createElement('button');
        b.textContent = `${step > 0 ? '+' : '−'}${Math.abs(step)} ms`;
        b.onclick = () => cmd('setLatency', { target: c.id, deltaMs: step });
        el.querySelector('.nudge').append(b);
      }
      box.append(el);
      row = { el, name: el.querySelector('.name'), lat: el.querySelector('.lat'), meta: el.querySelector('.meta'), nudge: el.querySelector('.nudge') };
      deviceRows.set(c.id, row);
    }
    const st = c.status;
    row.name.textContent = c.name + (c.id === S.id ? ' (cet appareil)' : '');
    row.lat.textContent = c.ready && st ? `${fmt(st.latencyMs)} ms` : '';
    row.nudge.hidden = !c.ready;
    row.meta.textContent = !c.ready || !st
      ? 'connecté, son pas encore activé'
      : `compensation ${st.latencySource} · écart ${fmt(st.errMs)} ms · réseau ${fmt(st.rtt)} ms · annoncé par le navigateur ${fmt(st.reportedMs, 0)} ms · ${st.sampleRate} Hz`;
  }
  for (const [id, row] of deviceRows) {
    if (!seen.has(id)) {
      row.el.remove();
      deviceRows.delete(id);
    }
  }
}

function renderCalib() {
  const res = S.lastCalib;
  const box = $('calibResult');
  $('calibrate').disabled = $('verify').disabled = S.calibBusy;
  $('releaseMic').hidden = !S.micStream;
  const mic = S.micLabel ? `Micro utilisé : ${S.micLabel}.` : '';
  const bt = /bluez|bluetooth|headset|hands.?free|mains.libres/i.test(S.micLabel)
    ? " Ce micro semble être celui d'un appareil Bluetooth : la sortie risque de basculer en profil mains-libres, choisis le micro intégré dans les réglages son."
    : '';
  $('micInfo').textContent = S.calibBusy ? 'Écoute en cours…' : mic + bt + (isMobile && !S.micLabel ? " Sur téléphone, ouvrir le micro peut changer le trajet du son : l'ordinateur est un meilleur choix pour écouter." : '');
  $('micInfo').classList.toggle('warn', !!bt);
  if (!res) {
    box.textContent = '';
    return;
  }
  const verify = res.mode === 'verify';
  const ok = res.results.filter((r) => r.detected);
  const gap = ok.length >= 2 ? Math.max(...ok.map((r) => r.ms)) - Math.min(...ok.map((r) => r.ms)) : null;
  const rows = res.results.map((r) => {
    const tr = document.createElement('tr');
    const cells = [
      r.name,
      r.detected ? `${fmt(r.ms)} ms` : 'non détecté',
      r.detected ? `${fmt(r.spreadMs)} ms` : '–',
      `${r.hits}/${r.reps}`,
      fmt(Math.min(r.psr, 999), 0),
    ];
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (i > 0) td.className = 'num';
      tr.append(td);
    });
    return tr;
  });
  box.innerHTML = `<table><thead><tr><th>Appareil</th><th>${verify ? 'Écart résiduel' : 'Latence mesurée'}</th><th>Dispersion</th><th>Détections</th><th>Score</th></tr></thead><tbody></tbody></table><p class="hint"></p>`;
  box.querySelector('tbody').append(...rows);
  box.querySelector('.hint').textContent = verify
    ? gap == null
      ? 'Il faut au moins deux appareils détectés pour mesurer un écart.'
      : `Écart entre appareils après compensation : ${fmt(gap)} ms (attendu : proche de 0).`
    : res.mode === 'probe'
      ? `Mesure seule, compensation inchangée${gap == null ? '' : ` (écart brut entre appareils : ${fmt(gap)} ms)`}.`
      : `Compensation appliquée aux appareils détectés${gap == null ? '' : ` (écart avant compensation : ${fmt(gap)} ms)`}. Lance « Vérifier » pour contrôler. La latence inclut celle du micro, identique pour tous.`;
}

// Écart entre appareils (max - min) d'une mesure, si tous ont été détectés.
function gapOf(res) {
  const ok = res.results.filter((r) => r.detected).map((r) => r.ms);
  return ok.length >= 2 && ok.length === res.results.length ? Math.max(...ok) - Math.min(...ok) : null;
}

function renderHistory() {
  $('stability').textContent = S.testing ? `Arrêter le test (mesure ${S.testRound}/${STABILITY_ROUNDS})` : `Test de stabilité (${STABILITY_ROUNDS} mesures)`;
  $('stability').disabled = S.calibBusy && !S.testing;
  $('historyBox').hidden = S.history.length === 0;
  const lines = S.history.map((h) => {
    const values = h.results.map((r) => `${r.name} ${r.detected ? `${fmt(r.ms)} ms` : 'non détecté'}`).join(' · ');
    return `${new Date(h.at).toLocaleTimeString()}  ${MODE_LABEL[h.mode].padEnd(12)}  ${values}`;
  });
  const text = lines.join('\n');
  if ($('history').textContent !== text) $('history').textContent = text;

  // Ce qui compte pour la synchro est la variation de l'écart entre appareils, pas la latence absolue.
  const gaps = S.history.filter((h) => h.mode === 'probe').map(gapOf).filter((g) => g !== null);
  $('stabilitySummary').textContent = gaps.length >= 2
    ? `Sur ${gaps.length} mesures, l'écart brut entre appareils va de ${fmt(Math.min(...gaps))} à ${fmt(Math.max(...gaps))} ms : variation de ${fmt(Math.max(...gaps) - Math.min(...gaps))} ms.`
    : '';
}

function render() {
  const rtt = S.clock.rtt;
  const net = $('net');
  const ok = S.connected && Number.isFinite(rtt);
  net.textContent = ok ? `horloge ±${fmt(rtt / 2)} ms` : 'hors ligne';
  net.className = `pill ${ok ? 'ok' : 'bad'}`;

  for (const id of ['playCard', 'devicesCard', 'calibCard', 'logCard']) $(id).hidden = !S.ready;
  $('joinCard').hidden = S.ready;
  if (!S.ready) return;

  const source = $('source');
  const options = [['metronome', 'Métronome (test de synchro)'], ...(S.track ? [[S.track.id, S.track.name]] : [])];
  if (source.dataset.key !== JSON.stringify(options)) {
    source.dataset.key = JSON.stringify(options);
    source.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  }
  const pb = S.playback;
  if (pb) {
    if (document.activeElement !== source) source.value = pb.track;
    $('play').disabled = pb.playing;
    $('pause').disabled = !pb.playing;
    const dur = S.buffers.get(pb.track)?.duration;
    let pos = pb.playing ? Math.max(0, pb.P0 + (serverNow() - pb.S0) / 1000) : pb.P0;
    if (dur) pos %= dur;
    $('pos').textContent = `${Math.floor(pos / 60)}:${String(Math.floor(pos % 60)).padStart(2, '0')}`;
    $('playHint').textContent = pb.playing && !S.play ? 'Chargement de la piste…' : '';
  }
  renderDevices();
  renderCalib();
  renderHistory();
}

async function join() {
  $('join').disabled = true;
  S.name = $('name').value.trim() || S.name;
  localStorage.setItem('unisson.name', S.name);

  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.resume();
  S.ctx = ctx;
  S.master = ctx.createGain();
  S.master.connect(ctx.destination);
  S.chirpBus = ctx.createGain();
  S.chirpBus.gain.value = 0.8;
  S.chirpBus.connect(S.master);
  const chirp = makeChirp(ctx.sampleRate);
  S.chirpBuf = ctx.createBuffer(1, chirp.length, ctx.sampleRate);
  S.chirpBuf.copyToChannel(chirp, 0);
  S.buffers.set('metronome', makeMetronome(ctx));

  // Bruit de fond infime (-80 dB), joué en permanence : sur un silence complet, le navigateur et
  // la chaîne audio mettent la sortie en veille, et la latence n'est plus la même au réveil.
  const noise = ctx.createBuffer(1, 2 * ctx.sampleRate, ctx.sampleRate);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * 1e-4;
  const keepAlive = ctx.createBufferSource();
  keepAlive.buffer = noise;
  keepAlive.loop = true;
  keepAlive.connect(ctx.destination);
  keepAlive.start();

  ctxDeltaLoop();
  setInterval(driftTick, 500);
  setInterval(reportStatus, 2000);

  const saved = JSON.parse(sessionStorage.getItem('unisson.latency') || 'null');
  if (saved) setLatency(saved.ms, saved.source);
  else {
    // Sans calibration, on part de l'estimation du navigateur (souvent fausse en Bluetooth).
    setTimeout(() => {
      if (S.latencySource === 'aucune') setLatency((ctx.outputLatency || 0) * 1000, 'navigateur');
    }, 800);
  }

  navigator.wakeLock?.request('screen').catch(() => {});
  S.ready = true;
  log(`son activé (${ctx.sampleRate} Hz)`);
  reportStatus();
  applyPlayback();
  render();
}

$('name').value = S.name;
$('join').onclick = () => join().catch((err) => {
  $('join').disabled = false;
  alert(`Impossible d'activer le son : ${err.message}`);
});
$('play').onclick = () => cmd('play');
$('pause').onclick = () => cmd('pause');
$('stop').onclick = () => cmd('stop');
$('source').onchange = (e) => cmd('track', { track: e.target.value });
$('calibrate').onclick = () => runCalibration('measure');
$('verify').onclick = () => runCalibration('verify');
$('stability').onclick = stabilityTest;
$('releaseMic').onclick = releaseMic;
$('file').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  log(`envoi de ${f.name}…`);
  const r = await fetch(`/api/track?name=${encodeURIComponent(f.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': f.type || 'application/octet-stream' },
    body: f,
  });
  if (!r.ok) log("échec de l'envoi (fichier trop gros ?)");
  e.target.value = '';
};

if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  fetch('/api/info').then((r) => r.json()).then(({ urls }) => {
    if (urls.length) $('phoneUrl').textContent = `Sur le téléphone (même Wi-Fi) : ${urls.join(' ou ')} — accepter l'avertissement de certificat.`;
  }).catch(() => {});
}

clockLoop();
connectEvents();
setInterval(render, 500);
render();

// Pour les tests et le débogage depuis la console.
window.unisson = { S, serverNow };
