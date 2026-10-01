// Salles : chaque salle a ses appareils, sa lecture, son morceau et son suivi, isolés des autres.
// Le registre garde la liste des salles sur disque ; leur état vivant reste en mémoire.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PLAY_LEAD_MS = 1500; // délai entre « lecture » et le premier son : doit couvrir la plus grosse latence
const CALIB_LEAD_MS = 2000;
const CALIB_SLOT_MS = 1300; // un chirp par créneau, les appareils émettent chacun leur tour
const CALIB_REPS = 3;
const SLOTS = 4; // emplacements de suivi : un par bande de fréquences réservée (voir PROBE.bands)
const CAPTURE_KEEP = 12;
const ROOMS_PER_USER = 10;
const IDLE_MS = 10 * 60 * 1000; // une salle vide depuis ce délai libère sa mémoire (morceau compris)
const LIVE_BACKLOG = 30; // tranches rejouées à un appareil qui arrive en cours de direct (3 s)
const LIVE_MAX_PENDING = 4 * 1024 * 1024; // un appareil qui prend ce retard de réception est décroché
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sans 0/O ni 1/I/L, pour être dicté sans erreur

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

class Room {
  constructor(meta, { now, captureDir }) {
    Object.assign(this, { meta, now, captureDir });
    this.clients = new Map(); // id -> { id, name, ready, status, slot, res }
    this.history = []; // résultats de calibration et de suivi, du plus ancien au plus récent
    // Suivi continu : chaque appareil a sa bande réservée dans la musique, celui qui écoute y mesure son retard.
    this.tracking = { on: false, listener: null };
    this.track = null; // dernier fichier envoyé : { id, name, type, data }
    // Position P0 (s) de la piste à l'instant serveur S0 (ms).
    this.playback = { track: 'metronome', playing: false, S0: 0, P0: 0 };
    // Direct : l'hôte capte un son et l'envoie par tranches, relayées telles quelles aux appareils.
    this.live = { on: false };
    this.liveBacklog = [];
    this.liveListeners = new Set();
    this.clientsTimer = null;
    this.emptySince = Date.now();
  }

  log(text) {
    console.log(`[${new Date().toLocaleTimeString('fr-FR')}] [${this.meta.code}] ${text}`);
  }

  broadcast(event, data) {
    for (const c of this.clients.values()) send(c.res, event, data);
  }

  clientList() {
    return [...this.clients.values()].map(({ id, name, ready, status, slot }) => ({ id, name, ready, status, slot }));
  }

  trackInfo() {
    return this.track && { id: this.track.id, name: this.track.name };
  }

  broadcastClients() {
    if (this.clientsTimer) return;
    this.clientsTimer = setTimeout(() => {
      this.clientsTimer = null;
      this.broadcast('clients', this.clientList());
    }, 200);
  }

  // Ouvre le flux d'événements d'un appareil.
  connect(req, res, id, name) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const old = this.clients.get(id);
    old?.res.end();
    // Premier emplacement libre ; au-delà de SLOTS appareils, les suivants ne sont pas suivis.
    const taken = new Set([...this.clients.values()].filter((c) => c.id !== id).map((c) => c.slot));
    const free = Array.from({ length: SLOTS }, (_, i) => i).find((i) => !taken.has(i)) ?? null;
    this.clients.set(id, { ready: false, status: null, slot: free, ...old, id, name, res });
    this.emptySince = null;
    send(res, 'hello', { clients: this.clientList(), track: this.trackInfo(), playback: this.playback, history: this.history, tracking: this.tracking, live: this.live });
    this.broadcastClients();
    req.on('close', () => {
      if (this.clients.get(id)?.res !== res) return;
      this.clients.delete(id);
      if (this.clients.size === 0) this.emptySince = Date.now();
      this.broadcastClients();
      if (this.tracking.listener === id) this.setTracking({ on: false }); // plus personne n'écoute
      if (this.live.on && this.live.hostId === id) this.stopLive(); // plus personne ne diffuse
    });
  }

  // Démarre un direct. sampleRate et channels décrivent le son que l'hôte va envoyer ; delayMs est
  // le retard entre la capture et l'écoute, commun à tous les appareils.
  startLive({ id, sampleRate, channels, delayMs }) {
    if (!this.clients.get(id)?.ready) return { ok: false, error: "l'appareil qui diffuse n'a pas rejoint" };
    if (!(sampleRate >= 8000 && sampleRate <= 96000) || ![1, 2].includes(channels)) return { ok: false, error: 'format de son refusé' };
    if (this.playback.playing) this.setPlayback({ playing: false, P0: this.currentPos() });
    this.liveBacklog = [];
    this.live = { on: true, id: crypto.randomUUID(), hostId: id, sampleRate, channels, delayMs: Math.max(300, Math.min(5000, Number(delayMs) || 1000)) };
    this.log(`direct lancé par ${this.clients.get(id).name} (${sampleRate} Hz, ${channels} canal(aux), retard ${this.live.delayMs} ms)`);
    this.broadcast('live', this.live);
    return { ok: true, live: this.live };
  }

  stopLive() {
    if (!this.live.on) return { ok: true };
    this.live = { on: false };
    this.liveBacklog = [];
    for (const res of this.liveListeners) res.end();
    this.liveListeners.clear();
    this.log('direct arrêté');
    this.broadcast('live', this.live);
    return { ok: true };
  }

  // Relaie une tranche (déjà au format de public/live.js) à tous les appareils qui écoutent.
  pushLive(frame) {
    if (!this.live.on) return false;
    this.liveBacklog.push(frame);
    if (this.liveBacklog.length > LIVE_BACKLOG) this.liveBacklog.shift();
    for (const res of this.liveListeners) {
      if (res.writableLength > LIVE_MAX_PENDING) {
        res.destroy();
        this.liveListeners.delete(res);
      } else res.write(frame);
    }
    return true;
  }

  // Ouvre le flux de son d'un appareil : d'abord les dernières tranches, puis le direct.
  listenLive(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.socket?.setNoDelay(true);
    for (const frame of this.liveBacklog) res.write(frame);
    this.liveListeners.add(res);
    req.on('close', () => this.liveListeners.delete(res));
  }

  setPlayback(patch) {
    this.playback = { ...this.playback, ...patch };
    this.broadcast('playback', this.playback);
  }

  currentPos() {
    const { playing, P0, S0 } = this.playback;
    return playing ? P0 + (this.now() - S0) / 1000 : P0;
  }

  startCalib(msg) {
    const emitters = [...this.clients.values()].filter((c) => c.ready);
    if (!this.clients.get(msg.id)?.ready) return { ok: false, error: "l'appareil qui écoute n'a pas rejoint" };
    if (this.tracking.on) return { ok: false, error: 'arrête le suivi continu avant de calibrer' };
    if (this.live.on) return { ok: false, error: 'arrête le direct avant de calibrer' };
    if (this.playback.playing) this.setPlayback({ playing: false, P0: this.currentPos() });
    const schedule = [];
    let T = this.now() + CALIB_LEAD_MS;
    for (let rep = 0; rep < CALIB_REPS; rep++) {
      for (const c of emitters) {
        schedule.push({ client: c.id, name: c.name, T });
        T += CALIB_SLOT_MS;
      }
    }
    const calibId = crypto.randomUUID();
    const mode = ['measure', 'verify', 'probe'].includes(msg.mode) ? msg.mode : 'measure';
    this.broadcast('calib', { calibId, listener: msg.id, mode, schedule, end: T });
    return { ok: true, calibId };
  }

  // Garde et journalise chaque mesure, avec la compensation en vigueur au moment où elle arrive.
  recordCalib(result) {
    const entry = {
      ...result,
      at: Date.now(),
      results: result.results.map((r) => ({ ...r, compMs: this.clients.get(r.client)?.status?.latencyMs ?? null })),
    };
    this.history.push(entry);
    if (this.history.length > 500) this.history.shift();
    const fmt = (v) => (v == null ? '–' : v.toFixed(1));
    const signed = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
    const nameOf = (id) => entry.results.find((r) => r.client === id)?.name ?? id;
    const parts = entry.results.map((r) => {
      const value = r.detected ? `${fmt(r.ms)}ms` : 'non détecté';
      const detail = entry.mode === 'track'
        ? `score ${fmt(r.psr)}, niveau ${r.levelDb == null ? '–' : `${Math.round(r.levelDb)} dB`}${r.windows > 1 ? `, cumul ${r.windows}` : ''}`
        : `dispersion ${fmt(r.spreadMs)}, ${r.hits}/${r.reps}, score ${Math.round(Math.min(r.psr, 999))}`;
      return `${r.name}=${value} (${detail}, comp ${fmt(r.compMs)})`;
    });
    const fixes = entry.mode === 'track' && entry.corrections.length
      ? `  corrections : ${entry.corrections.map((c) => `${nameOf(c.client)} ${signed(c.deltaMs)}ms`).join(', ')}`
      : '';
    this.log(`${entry.mode.padEnd(7)} ${parts.join('  ')}${fixes}`);
    this.broadcast('calibResult', entry);
  }

  setTracking(msg) {
    if (msg.on === true) {
      if (!this.clients.get(msg.id)?.ready) return { ok: false, error: "l'appareil qui écoute n'a pas rejoint" };
      this.tracking = { on: true, listener: msg.id };
    } else {
      this.tracking = { on: false, listener: null };
    }
    this.log(`suivi ${this.tracking.on ? 'actif' : 'arrêté'}`);
    this.broadcast('tracking', this.tracking);
    return { ok: true };
  }

  handleCmd(msg) {
    switch (msg.type) {
      case 'status': {
        const c = this.clients.get(msg.id);
        if (!c) return { ok: false, error: 'client inconnu' };
        if (typeof msg.name === 'string') c.name = msg.name.slice(0, 40);
        c.ready = !!msg.ready;
        c.status = msg.status ?? null;
        this.broadcastClients();
        return { ok: true };
      }
      case 'play':
        if (this.live.on) return { ok: false, error: 'un direct est en cours' };
        if (!this.playback.playing) this.setPlayback({ playing: true, S0: this.now() + PLAY_LEAD_MS });
        return { ok: true };
      case 'pause':
        if (this.playback.playing) this.setPlayback({ playing: false, P0: this.currentPos() });
        return { ok: true };
      case 'stop':
        this.setPlayback({ playing: false, P0: 0 });
        return { ok: true };
      case 'track':
        if (msg.track !== 'metronome' && msg.track !== this.track?.id) return { ok: false, error: 'piste inconnue' };
        this.setPlayback({ track: msg.track, playing: false, P0: 0 });
        return { ok: true };
      case 'setLatency':
        this.broadcast('setLatency', { target: msg.target, deltaMs: Number(msg.deltaMs) || 0 });
        return { ok: true };
      case 'calib':
        return this.startCalib(msg);
      case 'calibResult':
        this.recordCalib(msg.result);
        return { ok: true };
      case 'tracking':
        return this.setTracking(msg);
      default:
        return { ok: false, error: 'commande inconnue' };
    }
  }

  setTrack(name, type, data) {
    this.track = { id: crypto.randomUUID(), name: name.slice(0, 120), type, data };
    this.broadcast('track', this.trackInfo());
    this.setPlayback({ track: this.track.id, playing: false, P0: 0 });
    return this.trackInfo();
  }

  // Enregistrement du micro envoyé par l'appareil qui écoute, pour analyse hors ligne.
  saveCapture(meta, data) {
    const dir = path.join(this.captureDir, this.meta.code);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(dir, `${stamp}.f32`), data);
    fs.writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify({ ...meta, track: this.trackInfo() }, null, 1));
    // Le morceau joué, pour pouvoir refaire l'analyse hors ligne.
    const trackFile = this.track && path.join(dir, `track-${this.track.id}`);
    if (trackFile && meta.playback?.track === this.track.id && !fs.existsSync(trackFile)) fs.writeFileSync(trackFile, this.track.data);
    const old = fs.readdirSync(dir).filter((f) => f.endsWith('.f32')).sort().slice(0, -CAPTURE_KEEP);
    for (const f of old) {
      fs.rmSync(path.join(dir, f));
      fs.rmSync(path.join(dir, f.replace(/\.f32$/, '.json')), { force: true });
    }
  }

  close() {
    this.stopLive();
    for (const c of this.clients.values()) c.res.end();
    this.clients.clear();
  }
}

export function createRooms({ dataDir, now, captureDir }) {
  const file = path.join(dataDir, 'rooms.json');
  const metas = new Map(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).map((m) => [m.code, m]) : []);
  const live = new Map(); // code -> Room
  const save = () => fs.writeFileSync(file, JSON.stringify([...metas.values()], null, 1));

  function newCode() {
    for (;;) {
      const code = Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
      if (!metas.has(code)) return code;
    }
  }

  // Libère les salles vides depuis longtemps et entretient les connexions ouvertes.
  setInterval(() => {
    for (const [code, room] of live) {
      if (room.emptySince && Date.now() - room.emptySince > IDLE_MS) live.delete(code);
      else for (const c of room.clients.values()) c.res.write(': ping\n\n');
    }
  }, 15000).unref();

  return {
    meta: (code) => metas.get(code) ?? null,
    listFor: (userId) => [...metas.values()].filter((m) => m.ownerId === userId),
    create(user, name) {
      if (this.listFor(user.id).length >= ROOMS_PER_USER) return { error: `${ROOMS_PER_USER} salles au plus par compte` };
      const meta = { code: newCode(), name: String(name ?? '').trim().slice(0, 60) || `Salle de ${user.name}`, ownerId: user.id, ownerName: user.name, createdAt: new Date().toISOString() };
      metas.set(meta.code, meta);
      save();
      return { meta };
    },
    remove(code) {
      live.get(code)?.close();
      live.delete(code);
      metas.delete(code);
      save();
    },
    // État vivant d'une salle existante, créé à la première visite.
    open(code) {
      const meta = metas.get(code);
      if (!meta) return null;
      if (!live.has(code)) live.set(code, new Room(meta, { now, captureDir }));
      return live.get(code);
    },
  };
}
