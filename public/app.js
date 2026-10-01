import { makeChirp, detectChirp, median, PROBE, TRACKING, makeBandstop, MusicAnalyzer, GapTracker } from './dsp.js';
import { fitClock, localToServer, serverToLocal, gapCorrections } from './sync.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
// ?loopback : le micro est remplacé par une boucle interne de retard connu (tests automatiques).
const LOOPBACK = params.has('loopback');
const LOOPBACK_DELAY = 0.123;

const PSR_MIN = 10; // score minimal pour considérer un chirp comme détecté
const HARD_RESYNC_S = 0.06; // au-delà, on recale d'un coup plutôt que d'ajuster la vitesse
const MAX_RATE_DEV = 0.01;
const KP = 0.5; // 1/s : un écart de 1 ms corrige la vitesse de 500 ppm
const KI = 0.05; // 1/s² : apprend la dérive constante en une vingtaine de secondes
const INTEG_MAX = 5e-4;
const INTEG_FREEZE_S = 0.003;
const STABILITY_ROUNDS = 10;
const MODE_LABEL = { measure: 'calibration', verify: 'vérification', probe: 'mesure', track: 'suivi' };
const TRACK_BLOCKS = TRACKING.blocks;
const TRACK_SETTLE_MS = 4000; // attente après une correction, le temps que la lecture se recale
// Décalages essayés quand rien n'est trouvé autour de la dernière position connue.
const TRACK_SWEEP_MS = [150, -150, 300, -300, 450, -450, 600, -600];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isMobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

const S = {
  id: sessionStorage.getItem('unisson.id') || Math.random().toString(36).slice(2, 10),
  name: localStorage.getItem('unisson.name') || `${isMobile ? 'Téléphone' : 'Ordi'} ${Math.floor(Math.random() * 90 + 10)}`,
  ready: false,
  connected: false,
  ctx: null,
  master: null,
  chirpBus: null,
  chirpBuf: null,
  clock: { a: 0, b: 0, t0: 0, rtt: Infinity, samples: [] }, // voir fitClock : heure serveur à partir de performance.now()
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
  rateBias: 0,
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
  tracking: null, // état du suivi continu diffusé par le serveur
  musicBus: null, // entrée de la chaîne musique : filtre coupe-bande puis sortie
  notch: null,
  notchKey: null, // emplacements dont la bande est actuellement retirée
  notchDelay: 0, // retard (s) ajouté par le filtre, compensé au lancement de la lecture
  notchChangedMs: 0, // heure serveur du dernier changement de filtre
  trackRunning: false,
  gapTracker: null, // mémoire du suivi d'une fenêtre à l'autre (appareils faibles)
  trackWait: '', // pourquoi le suivi ne mesure pas en ce moment
  trackCenterMs: 0, // décalage commun (trajet du micro) autour duquel chercher les signatures
  lastTrack: null,
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
  c.samples = c.samples.filter((s) => t1 - s.at < 60000).slice(-200);
  Object.assign(c, fitClock(c.samples));
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

const serverNow = () => localToServer(S.clock, performance.now());
const serverToCtx = (ms) => serverToLocal(S.clock, ms) / 1000 - S.ctxDelta;
const ctxToServer = (t) => localToServer(S.clock, (t + S.ctxDelta) * 1000);

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

// Source bouclée asservie à l'horloge serveur : la position `pos0` (s) du tampon doit être
// *entendue* à l'heure serveur `t0` (ms).
class SyncedLoop {
  constructor(buffer, t0, pos0) {
    Object.assign(this, { buffer, t0, pos0, err: null, lastResync: 0 });
    this.integ = S.rateBias; // dérive déjà apprise lors d'une lecture précédente
    this.start();
  }

  start() {
    const ctx = S.ctx;
    this.src = ctx.createBufferSource();
    this.src.buffer = this.buffer;
    this.src.loop = true;
    this.gain = ctx.createGain();
    this.src.connect(this.gain).connect(S.musicBus);

    // Lancé en avance de la latence et du retard du filtre, pour que le son sorte de l'enceinte
    // à l'heure voulue.
    let when = serverToCtx(this.t0) - S.latencyMs / 1000 - S.notchDelay;
    let pos = this.pos0;
    const earliest = ctx.currentTime + 0.08;
    if (when < earliest) {
      pos += earliest - when; // on arrive en cours de route
      when = earliest;
    }
    const dur = this.buffer.duration;
    this.gain.gain.setValueAtTime(0, when);
    this.gain.gain.linearRampToValueAtTime(1, when + 0.02);
    this.src.start(when, ((pos % dur) + dur) % dur);
    Object.assign(this, { anchorCtx: when, anchorPos: pos, rate: 1, lastTick: null });
  }

  stop() {
    const t = S.ctx.currentTime, g = this.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + 0.015);
    try {
      this.src.stop(t + 0.02);
    } catch { /* déjà arrêtée */ }
  }

  // Compare la position réellement jouée à celle voulue par l'horloge serveur et ajuste la
  // vitesse : terme proportionnel pour résorber l'écart, terme intégral pour annuler la dérive
  // constante entre l'horloge audio et celle du serveur. Recalage franc si l'écart est trop grand.
  tick() {
    const t = S.ctx.currentTime;
    if (t < this.anchorCtx) return;
    const actual = this.anchorPos + (t - this.anchorCtx) * this.rate;
    const wanted = this.pos0 + (ctxToServer(t + S.latencyMs / 1000 + S.notchDelay) - this.t0) / 1000;
    const err = actual - wanted;
    this.err = err;

    if (Math.abs(err) > HARD_RESYNC_S) {
      if (performance.now() - this.lastResync > 1000) {
        this.lastResync = performance.now();
        log(`recalage (écart ${(err * 1000).toFixed(1)} ms)`);
        this.stop();
        this.start();
      }
      return;
    }
    const dt = this.lastTick === null ? 0 : Math.min(2, t - this.lastTick);
    this.lastTick = t;
    // Pas d'apprentissage pendant un gros rattrapage, sinon l'intégrale s'emballe.
    if (Math.abs(err) < INTEG_FREEZE_S) {
      this.integ = Math.max(-INTEG_MAX, Math.min(INTEG_MAX, this.integ + KI * err * dt));
      S.rateBias = this.integ;
    }
    this.rate = 1 - Math.max(-MAX_RATE_DEV, Math.min(MAX_RATE_DEV, KP * err + this.integ));
    this.anchorPos = actual;
    this.anchorCtx = t;
    this.src.playbackRate.value = this.rate;
  }
}

function stopSource() {
  S.play?.stop();
  S.play = null;
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
  S.play = new SyncedLoop(buf, pb.S0, pb.P0);
}

function driftTick() {
  if (S.ctx.state !== 'running') return;
  S.play?.tick();
  const err = S.play?.err;
  S.errMs = err == null ? null : err * 1000;
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
  node.port.onmessage = (e) => {
    S.chunks.push(e.data);
    // En suivi continu l'enregistrement ne s'arrête jamais : on ne garde que les 14 dernières secondes.
    if (S.trackRunning) while (S.chunks[0].start < e.data.start - 14 * ctx.sampleRate) S.chunks.shift();
  };

  if (LOOPBACK) {
    const delay = ctx.createDelay(1);
    delay.delayTime.value = LOOPBACK_DELAY;
    S.master.connect(delay).connect(node); // tout ce que l'enceinte jouerait
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

// Met bout à bout les blocs enregistrés ; `first` est l'indice, dans l'horloge audio, du premier échantillon.
function assembleRecording() {
  const chunks = S.chunks;
  if (!chunks.length) throw new Error('aucun son enregistré');
  const first = Math.min(...chunks.map((c) => c.start));
  const last = Math.max(...chunks.map((c) => c.start + c.data.length));
  const data = new Float32Array(last - first);
  for (const c of chunks) data.set(c.data, c.start - first);
  return { first, data };
}

function analyze(ev, expected) {
  const sr = S.ctx.sampleRate;
  const { first, data: rec } = assembleRecording();

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
  S.history.push(res);
  if (S.history.length > 300) S.history.shift();
  if (res.mode === 'track') {
    S.lastTrack = res;
    const fix = res.corrections.find((c) => c.client === S.id);
    if (fix) setLatency(S.latencyMs + fix.deltaMs, 'suivi');
  } else {
    S.lastCalib = res;
    const mine = res.results.find((r) => r.client === S.id);
    if (res.mode === 'measure' && mine?.detected) setLatency(mine.ms, 'micro');
  }
  S.calibWaiters.get(res.calibId)?.(res);
  S.calibWaiters.delete(res.calibId);
  render();
}

// --- Suivi continu par la musique -------------------------------------------

// Installe le filtre de la musique de cet appareil : il retire les bandes données (celles des
// autres appareils pendant le suivi, aucune sinon). Le nœud est remplacé à chaque changement,
// un ConvolverNode n'acceptant qu'une seule réponse impulsionnelle.
function setNotch(bands) {
  const ctx = S.ctx;
  const ir = makeBandstop(ctx.sampleRate, bands);
  const buffer = ctx.createBuffer(1, ir.length, ctx.sampleRate);
  buffer.copyToChannel(ir, 0);
  const node = new ConvolverNode(ctx, { buffer, disableNormalization: true });
  node.connect(S.master);
  S.musicBus.connect(node);
  const old = S.notch;
  if (old) {
    S.musicBus.disconnect(old);
    setTimeout(() => old.disconnect(), 500); // le temps qu'il finisse de jouer ce qu'il a déjà reçu
  }
  S.notch = node;
  S.notchChangedMs = serverNow();
}

// Applique l'état du suivi diffusé par le serveur : pendant le suivi, chaque appareil se tait dans
// la bande de chacun des autres, pour que chacun soit seul dans la sienne.
function applyTracking() {
  if (!S.ready) return;
  const tr = S.tracking;
  const mine = S.clients.find((c) => c.id === S.id)?.slot;
  const others = tr?.on ? S.clients.filter((c) => c.ready && c.id !== S.id && c.slot != null && c.slot !== mine).map((c) => c.slot) : [];
  const slots = [...new Set(others)].sort();
  if (slots.join(',') !== S.notchKey) {
    S.notchKey = slots.join(',');
    setNotch(slots.map((slot) => PROBE.bands[slot]));
  }
  if (tr?.on && tr.listener === S.id && !S.trackRunning) trackingLoop();
}

async function trackingLoop() {
  S.trackRunning = true;
  const active = () => S.tracking?.on && S.tracking.listener === S.id && !!S.recorder;
  try {
    await ensureRecorder();
    S.chunks = [];
    S.recorder.port.postMessage({ on: true });
    S.gapTracker = new GapTracker(S.ctx.sampleRate);
    let notBefore = serverNow();
    while (active()) {
      const result = await analyzeTracking(notBefore, active);
      if (!result) break;
      S.trackWait = result.waiting ?? '';
      if (result.waiting) {
        S.gapTracker.reset(); // lecture ou appareils modifiés : les écarts mémorisés ne valent plus
        render();
        await sleep(500);
        continue;
      }
      await cmd('calibResult', { result });
      uploadCapture(result).catch((err) => log('capture non envoyée :', err.message));
      if (result.corrections.length) S.gapTracker.reset();
      notBefore = serverNow() + (result.corrections.length ? TRACK_SETTLE_MS : 0);
    }
  } catch (err) {
    log('suivi interrompu :', err.message);
  }
  S.recorder?.port.postMessage({ on: false });
  S.trackRunning = false;
  S.trackWait = '';
  if (S.tracking?.on && S.tracking.listener === S.id) cmd('tracking', { on: false }).catch(() => {});
}

// Envoie au serveur ce que le micro vient d'entendre, avec de quoi le recaler sur l'horloge commune :
// c'est ce qui permet d'analyser hors ligne une situation où le suivi échoue. Réservé à l'appareil
// qui héberge le serveur, pour ne pas charger le Wi-Fi.
async function uploadCapture(result) {
  if (!isLocal) return;
  const sr = S.ctx.sampleRate;
  const { first, data } = assembleRecording();
  const meta = {
    sampleRate: sr,
    firstFrame: first,
    firstServerMs: ctxToServer(first / sr),
    windowStartMs: result.windowStartMs,
    centerMs: S.trackCenterMs,
    playback: S.playback,
    results: result.results,
    clients: S.clients,
    listener: S.id,
    bands: PROBE.bands,
    mic: S.micStream?.getAudioTracks()[0]?.getSettings() ?? null,
    userAgent: navigator.userAgent,
  };
  await fetch('/api/capture', { method: 'POST', headers: { 'X-Meta': encodeURIComponent(JSON.stringify(meta)) }, body: data });
}

// Mesure le retard de chaque appareil sur une fenêtre de musique qui commence au plus tôt à
// l'heure serveur `notBefore`. Renvoie null si le suivi s'arrête, { waiting } s'il n'y a rien à mesurer.
async function analyzeTracking(notBefore, active) {
  const sr = S.ctx.sampleRate;
  const pb = S.playback;
  const buf = pb?.playing ? S.buffers.get(pb.track) : null;
  if (!buf || buf.sampleRate !== sr) return { waiting: 'la musique ne joue pas' };
  const devices = S.clients.filter((c) => c.ready && c.slot != null);
  const readyKey = devices.map((c) => `${c.id}:${c.slot}`).join(',');
  const spanMs = ((TRACK_BLOCKS * PROBE.block) / sr) * 1000;
  // La fenêtre ne doit contenir ni le début de la lecture ni un changement de filtre.
  const start = Math.max(notBefore, pb.S0 + 500, S.notchChangedMs + 1500);

  // Le trajet du micro décale toutes les arrivées d'un même montant, qui dérive et saute parfois de
  // plusieurs dizaines de ms : on cherche autour de la dernière valeur connue, puis plus large.
  let results = null;
  for (const centerMs of [S.trackCenterMs, ...TRACK_SWEEP_MS.map((d) => S.trackCenterMs + d)]) {
    const endMs = start + spanMs + centerMs + 500;
    while (active() && S.playback === pb && serverNow() < endMs) await sleep(100);
    if (!active()) return null;
    const stillSame = S.clients.filter((c) => c.ready && c.slot != null).map((c) => `${c.id}:${c.slot}`).join(',') === readyKey;
    if (S.playback !== pb || !stillSame || S.notchChangedMs + 1500 > start) return { waiting: 'la lecture ou les appareils viennent de changer' };
    const pass = await correlateWindow(start, centerMs, devices, pb, buf);
    if (pass?.some((r) => r.detected)) {
      results = pass;
      break;
    }
    results ??= pass;
  }
  results ??= devices.map((c) => ({ client: c.id, name: c.name, detected: false, ms: null, psr: 0, driftPpm: 0, levelDb: null, windows: 1 }));

  const found = results.filter((r) => r.detected);
  if (found.length) S.trackCenterMs = found.reduce((sum, r) => sum + r.ms, 0) / found.length;
  return {
    calibId: Math.random().toString(36).slice(2),
    mode: 'track',
    listener: S.id,
    mic: S.micLabel,
    windowStartMs: start,
    results,
    // On ne touche pas à une calibration correcte : rien en dessous de 2 ms d'écart entre deux
    // appareils (1 ms de part et d'autre de la moyenne), et des pas de 6 ms au plus.
    corrections: gapCorrections(found.map((r) => ({ client: r.client, ms: r.ms })), { deadbandMs: 1, maxStepMs: 6 }),
  };
}

// Corrèle, bloc par bloc, la musique de référence avec ce que le micro a enregistré au moment où
// chaque bloc devait être entendu (décalé de centerMs), dans la bande propre à chaque appareil.
async function correlateWindow(start, centerMs, devices, pb, buf) {
  const sr = S.ctx.sampleRate;
  const { first, data } = assembleRecording();
  const analyzer = new MusicAnalyzer(sr, new Map(devices.map((c) => [c.id, PROBE.bands[c.slot]])));
  const channels = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const ref = new Float32Array(PROBE.block);
  const len = PROBE.block + 2 * PROBE.maxLag;
  for (let b = 0; b < TRACK_BLOCKS; b++) {
    const offsetS = (b * PROBE.block) / sr;
    // Échantillon de musique entendu à cet instant, puis l'instant exact où lui est entendu.
    const q = Math.round((pb.P0 + (start + offsetS * 1000 - pb.S0) / 1000) * sr);
    const heardMs = pb.S0 + (q / sr - pb.P0) * 1000;
    const x0 = Math.round((serverToCtx(heardMs) + centerMs / 1000) * sr) - PROBE.maxLag - first;
    if (x0 < 0 || x0 + len > data.length) continue;
    for (let i = 0; i < PROBE.block; i++) {
      const k = (((q + i) % buf.length) + buf.length) % buf.length;
      let v = 0;
      for (const ch of channels) v += ch[k];
      ref[i] = v / channels.length;
    }
    analyzer.addBlock(ref, data.subarray(x0, x0 + len), offsetS);
    if (b % 8 === 7) await sleep(0); // laisse respirer l'interface
  }
  // GapTracker décide qui est reconnu : l'appareil le plus net sert de référence, l'écart des autres
  // vient du cumul de leurs dernières fenêtres. Une bande presque vide (restes du filtrage des
  // autres appareils) ou une arrivée en bord de plage ne compte pas.
  const out = S.gapTracker.update(analyzer);
  return devices.map((c) => {
    const r = out.get(c.id);
    return { client: c.id, name: c.name, detected: r.detected, ms: r.detected ? centerMs + (r.lag / sr) * 1000 : null, psr: r.score, driftPpm: r.drift * 1e6, levelDb: r.level, windows: r.windows };
  });
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
      browser: (navigator.userAgent.match(/(Firefox|Chrome|Version)\/[\d.]+/) ?? [''])[0],
      mic: S.micStream?.getAudioTracks()[0]?.getSettings() ?? null,
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
    S.tracking = d.tracking ?? null;
    onPlayback(d.playback);
    applyTracking();
    reportStatus();
    render();
  });
  on('clients', (d) => { S.clients = d; applyTracking(); render(); });
  on('tracking', (d) => { S.tracking = d; applyTracking(); render(); });
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
  $('calibrate').disabled = $('verify').disabled = S.calibBusy || !!S.tracking?.on;
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
  // Le trajet du micro ajoute à toutes les mesures un même décalage, qui dérive d'une mesure à
  // l'autre : en vérification, seul l'écart par rapport à un appareil de référence a un sens.
  const ref = verify ? ok.find((r) => r.client === res.listener) ?? ok[0] : null;
  const rows = res.results.map((r) => {
    const tr = document.createElement('tr');
    const value = !r.detected ? 'non détecté' : !ref ? `${fmt(r.ms)} ms` : r === ref ? 'référence' : `${r.ms > ref.ms ? '+' : ''}${fmt(r.ms - ref.ms)} ms`;
    const cells = [
      r.name,
      value,
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
  box.innerHTML = `<table><thead><tr><th>Appareil</th><th>${verify ? 'Écart après compensation' : 'Latence mesurée'}</th><th>Dispersion</th><th>Détections</th><th>Score</th></tr></thead><tbody></tbody></table><p class="hint"></p>`;
  box.querySelector('tbody').append(...rows);
  box.querySelector('.hint').textContent = verify
    ? gap == null
      ? 'Il faut au moins deux appareils détectés pour mesurer un écart.'
      : `Écart entre appareils après compensation : ${fmt(gap)} ms (attendu : proche de 0).${Math.abs(ref.ms) > 5 ? ` Décalage commun de ${fmt(ref.ms, 0)} ms dû au trajet du micro, sans effet sur la synchro.` : ''}`
    : res.mode === 'probe'
      ? `Mesure seule, compensation inchangée${gap == null ? '' : ` (écart brut entre appareils : ${fmt(gap)} ms)`}.`
      : `Compensation appliquée aux appareils détectés${gap == null ? '' : ` (écart avant compensation : ${fmt(gap)} ms)`}. Lance « Vérifier » pour contrôler. La latence inclut celle du micro, identique pour tous.`;
}

// Écart entre appareils (max - min) d'une mesure, si tous ont été détectés.
function gapOf(res) {
  const ok = res.results.filter((r) => r.detected).map((r) => r.ms);
  return ok.length >= 2 && ok.length === res.results.length ? Math.max(...ok) - Math.min(...ok) : null;
}

const signed = (v) => `${v >= 0 ? '+' : ''}${fmt(v)}`;
const nameOf = (res, client) => res.results.find((r) => r.client === client)?.name ?? client;

// Valeurs d'une mesure rapportées à un appareil de référence (celui qui écoute s'il est détecté).
function relativeValues(res) {
  const ok = res.results.filter((r) => r.detected);
  const ref = ok.find((r) => r.client === res.listener) ?? ok[0];
  return res.results.map((r) => {
    const value = !r.detected ? (r.windows > 1 ? `trop faible pour l'instant, cumul en cours (${r.windows})` : 'non détecté') : r === ref ? 'référence' : `${signed(r.ms - ref.ms)} ms`;
    return `${r.name} ${value}${r.detected && r.windows > 1 ? ` (cumul de ${r.windows} mesures)` : ''}`;
  }).join(' · ');
}

function renderTracking() {
  const tr = S.tracking;
  if (!tr) return;
  const listener = S.clients.find((c) => c.id === tr.listener)?.name;
  $('tracking').textContent = !tr.on ? 'Activer le suivi (cet appareil écoute)' : tr.listener === S.id ? 'Arrêter le suivi' : `Arrêter le suivi (écoute : ${listener ?? '?'})`;
  $('tracking').disabled = S.calibBusy;
  const last = S.lastTrack;
  let info = '';
  if (tr.on && S.trackWait) info = `En attente : ${S.trackWait}.`;
  else if (tr.on && !last) info = 'Première mesure dans quelques secondes…';
  else if (tr.on) {
    const found = last.results.filter((r) => r.detected).length;
    info = found === 0
      ? 'Aucun appareil reconnu dans la musique : monte le volume ou rapproche les enceintes du micro.'
      : found === 1
        ? `Un seul appareil reconnu (${relativeValues(last)}) : il en faut deux pour mesurer un écart.`
        : `Dernière mesure à ${new Date(last.at).toLocaleTimeString()} : ${relativeValues(last)}. ${last.corrections.length ? `Corrections : ${last.corrections.map((c) => `${nameOf(last, c.client)} ${signed(c.deltaMs)} ms`).join(', ')}.` : 'Aucune correction nécessaire.'}`;
  }
  $('trackInfo').textContent = info;
}

function renderHistory() {
  $('stability').textContent = S.testing ? `Arrêter le test (mesure ${S.testRound}/${STABILITY_ROUNDS})` : `Test de stabilité (${STABILITY_ROUNDS} mesures)`;
  $('stability').disabled = (S.calibBusy && !S.testing) || !!S.tracking?.on;
  $('historyBox').hidden = S.history.length === 0;
  const lines = S.history.slice(-60).map((h) => {
    const absolute = h.mode === 'measure' || h.mode === 'probe';
    const values = absolute ? h.results.map((r) => `${r.name} ${r.detected ? `${fmt(r.ms)} ms` : 'non détecté'}`).join(' · ') : relativeValues(h);
    const gap = gapOf(h);
    const fixes = h.corrections?.length ? `  corrections : ${h.corrections.map((c) => `${nameOf(h, c.client)} ${signed(c.deltaMs)} ms`).join(', ')}` : '';
    return `${new Date(h.at).toLocaleTimeString()}  ${MODE_LABEL[h.mode].padEnd(12)}  ${values}${gap === null ? '' : `  →  écart ${fmt(gap)} ms`}${fixes}`;
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

  for (const id of ['playCard', 'devicesCard', 'calibCard', 'trackCard', 'logCard']) $(id).hidden = !S.ready;
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
  renderTracking();
  renderHistory();
}

async function join() {
  $('join').disabled = true;
  $('join').textContent = 'Activation du son…';
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
  S.musicBus = ctx.createGain();
  S.notchDelay = (PROBE.taps - 1) / 2 / ctx.sampleRate;
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

  // Au démarrage, l'horloge audio avance par à-coups : les premières mesures du lien entre cette
  // horloge et celle de l'ordinateur sont fausses d'une dizaine de ms. On les jette et on attend
  // des mesures propres avant de jouer quoi que ce soit, sinon la lecture se décale d'autant
  // quelques secondes plus tard.
  ctxDeltaLoop();
  await sleep(1200);
  S.deltas = [];
  await sleep(400);
  setInterval(driftTick, 500);
  setInterval(reportStatus, 2000);

  const saved = JSON.parse(sessionStorage.getItem('unisson.latency') || 'null');
  // Sans calibration, on part de l'estimation du navigateur (souvent fausse en Bluetooth).
  if (saved) setLatency(saved.ms, saved.source);
  else setLatency((ctx.outputLatency || 0) * 1000, 'navigateur');

  navigator.wakeLock?.request('screen').catch(() => {});
  S.ready = true;
  log(`son activé (${ctx.sampleRate} Hz)`);
  reportStatus();
  applyTracking(); // installe la chaîne musique avant toute lecture
  applyPlayback();
  render();
}

$('name').value = S.name;
$('join').onclick = () => join().catch((err) => {
  $('join').disabled = false;
  $('join').textContent = 'Rejoindre';
  alert(`Impossible d'activer le son : ${err.message}`);
});
$('play').onclick = () => cmd('play');
$('pause').onclick = () => cmd('pause');
$('stop').onclick = () => cmd('stop');
$('source').onchange = (e) => cmd('track', { track: e.target.value });
$('calibrate').onclick = () => runCalibration('measure');
$('verify').onclick = () => runCalibration('verify');
$('stability').onclick = stabilityTest;
$('tracking').onclick = async () => {
  if (S.tracking?.on) return cmd('tracking', { on: false });
  try {
    await ensureRecorder();
  } catch (err) {
    $('trackInfo').textContent = `Micro inaccessible : ${err.message}`;
    return;
  }
  S.trackCenterMs = 0;
  S.lastTrack = null;
  return cmd('tracking', { on: true });
};
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
