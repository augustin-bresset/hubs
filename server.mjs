#!/usr/bin/env node
// Serveur de la bêta Unisson : fichiers statiques, horloge de référence et relais
// d'événements (SSE). Aucune dépendance : `node server.mjs`.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const CERT_DIR = path.join(ROOT, '.cert');
const HTTP_PORT = Number(process.env.HTTP_PORT ?? 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 8443);
const MAX_UPLOAD = 80 * 1024 * 1024;

const PLAY_LEAD_MS = 1500; // délai entre « lecture » et le premier son : doit couvrir la plus grosse latence
const CALIB_LEAD_MS = 2000;
const CALIB_SLOT_MS = 1300; // un chirp par créneau, les appareils émettent chacun leur tour
const CALIB_REPS = 3;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const now = () => performance.now();

// --- État partagé -----------------------------------------------------------

const clients = new Map(); // id -> { id, name, ready, status, res }
const history = []; // résultats de calibration, du plus ancien au plus récent
let track = null; // dernier fichier envoyé : { id, name, type, data }
// Position P0 (s) de la piste à l'instant serveur S0 (ms).
let playback = { track: 'metronome', playing: false, S0: 0, P0: 0 };

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event, data) {
  for (const c of clients.values()) send(c.res, event, data);
}
const clientList = () => [...clients.values()].map(({ id, name, ready, status }) => ({ id, name, ready, status }));
const trackInfo = () => track && { id: track.id, name: track.name };

let clientsTimer = null;
function broadcastClients() {
  if (clientsTimer) return;
  clientsTimer = setTimeout(() => {
    clientsTimer = null;
    broadcast('clients', clientList());
  }, 200);
}

function setPlayback(patch) {
  playback = { ...playback, ...patch };
  broadcast('playback', playback);
}
const currentPos = () => (playback.playing ? playback.P0 + (now() - playback.S0) / 1000 : playback.P0);

function startCalib(msg) {
  const emitters = [...clients.values()].filter((c) => c.ready);
  if (!clients.get(msg.id)?.ready) return { ok: false, error: "l'appareil qui écoute n'a pas rejoint" };
  if (playback.playing) setPlayback({ playing: false, P0: currentPos() });
  const schedule = [];
  let T = now() + CALIB_LEAD_MS;
  for (let rep = 0; rep < CALIB_REPS; rep++) {
    for (const c of emitters) {
      schedule.push({ client: c.id, name: c.name, T });
      T += CALIB_SLOT_MS;
    }
  }
  const calibId = randomUUID();
  const mode = ['measure', 'verify', 'probe'].includes(msg.mode) ? msg.mode : 'measure';
  broadcast('calib', { calibId, listener: msg.id, mode, schedule, end: T });
  return { ok: true, calibId };
}

// Garde et journalise chaque mesure, avec la compensation en vigueur au moment où elle arrive.
function recordCalib(result) {
  const entry = {
    ...result,
    at: Date.now(),
    results: result.results.map((r) => ({ ...r, compMs: clients.get(r.client)?.status?.latencyMs ?? null })),
  };
  history.push(entry);
  if (history.length > 100) history.shift();
  const fmt = (v) => (v == null ? '–' : v.toFixed(1));
  const parts = entry.results.map((r) => `${r.name}=${r.detected ? `${fmt(r.ms)}ms` : 'non détecté'} (dispersion ${fmt(r.spreadMs)}, ${r.hits}/${r.reps}, score ${Math.round(Math.min(r.psr, 999))}, comp ${fmt(r.compMs)})`);
  console.log(`[${new Date(entry.at).toLocaleTimeString('fr-FR')}] ${entry.mode.padEnd(7)} ${parts.join('  ')}`);
  broadcast('calibResult', entry);
}

function handleCmd(msg) {
  switch (msg.type) {
    case 'status': {
      const c = clients.get(msg.id);
      if (!c) return { ok: false, error: 'client inconnu' };
      if (typeof msg.name === 'string') c.name = msg.name.slice(0, 40);
      c.ready = !!msg.ready;
      c.status = msg.status ?? null;
      broadcastClients();
      return { ok: true };
    }
    case 'play':
      if (!playback.playing) setPlayback({ playing: true, S0: now() + PLAY_LEAD_MS });
      return { ok: true };
    case 'pause':
      if (playback.playing) setPlayback({ playing: false, P0: currentPos() });
      return { ok: true };
    case 'stop':
      setPlayback({ playing: false, P0: 0 });
      return { ok: true };
    case 'track':
      if (msg.track !== 'metronome' && msg.track !== track?.id) return { ok: false, error: 'piste inconnue' };
      setPlayback({ track: msg.track, playing: false, P0: 0 });
      return { ok: true };
    case 'setLatency':
      broadcast('setLatency', { target: msg.target, deltaMs: Number(msg.deltaMs) || 0 });
      return { ok: true };
    case 'calib':
      return startCalib(msg);
    case 'calibResult':
      recordCalib(msg.result);
      return { ok: true };
    default:
      return { ok: false, error: 'commande inconnue' };
  }
}

// --- HTTP -------------------------------------------------------------------

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('trop volumineux'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC + path.sep)) return json(res, 403, { ok: false });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { ok: false, error: 'introuvable' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/api/time') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    return res.end(String(now()));
  }

  if (p === '/api/info') return json(res, 200, { urls: lanAddresses().map((ip) => `https://${ip}:${HTTPS_PORT}`) });

  if (p === '/api/events') {
    const id = url.searchParams.get('id');
    if (!id) return json(res, 400, { ok: false });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const old = clients.get(id);
    old?.res.end();
    const name = (url.searchParams.get('name') || 'Appareil').slice(0, 40);
    const client = { ready: false, status: null, ...old, id, name, res };
    clients.set(id, client);
    send(res, 'hello', { clients: clientList(), track: trackInfo(), playback, history });
    broadcastClients();
    req.on('close', () => {
      if (clients.get(id)?.res === res) {
        clients.delete(id);
        broadcastClients();
      }
    });
    return;
  }

  if (p === '/api/cmd' && req.method === 'POST') {
    const body = await readBody(req, 1024 * 1024);
    return json(res, 200, handleCmd(JSON.parse(body.toString('utf8'))));
  }

  if (p === '/api/track' && req.method === 'POST') {
    const data = await readBody(req, MAX_UPLOAD);
    track = {
      id: randomUUID(),
      name: (url.searchParams.get('name') || 'fichier').slice(0, 120),
      type: req.headers['content-type'] || 'application/octet-stream',
      data,
    };
    broadcast('track', trackInfo());
    setPlayback({ track: track.id, playing: false, P0: 0 });
    return json(res, 200, { ok: true, track: trackInfo() });
  }

  if (p.startsWith('/api/track/')) {
    if (!track || p.slice('/api/track/'.length) !== track.id) return json(res, 404, { ok: false });
    res.writeHead(200, { 'Content-Type': track.type, 'Content-Length': track.data.length, 'Cache-Control': 'no-store' });
    return res.end(track.data);
  }

  if (req.method === 'GET') return serveStatic(res, p);
  json(res, 405, { ok: false });
}

function listener(req, res) {
  handle(req, res).catch((err) => {
    if (!res.headersSent) json(res, 500, { ok: false, error: String(err.message ?? err) });
    else res.end();
  });
}

// --- Certificat auto-signé (le micro du navigateur exige HTTPS hors localhost) ---

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|br-|veth|virbr)/.test(name)) continue;
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function ensureCert() {
  const ips = ['127.0.0.1', ...lanAddresses()];
  const key = path.join(CERT_DIR, 'key.pem');
  const cert = path.join(CERT_DIR, 'cert.pem');
  const stamp = path.join(CERT_DIR, 'ips');
  const wanted = ips.join(',');
  const upToDate = [key, cert, stamp].every((f) => fs.existsSync(f)) && fs.readFileSync(stamp, 'utf8') === wanted;
  if (!upToDate) {
    fs.mkdirSync(CERT_DIR, { recursive: true });
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365',
      '-keyout', key, '-out', cert, '-subj', '/CN=unisson',
      '-addext', `subjectAltName=DNS:localhost,${ips.map((ip) => `IP:${ip}`).join(',')}`,
    ], { stdio: 'ignore' });
    fs.writeFileSync(stamp, wanted);
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

// Ping SSE pour garder les connexions ouvertes.
setInterval(() => {
  for (const c of clients.values()) c.res.write(': ping\n\n');
}, 15000).unref();

http.createServer(listener).listen(HTTP_PORT, () => {
  https.createServer(ensureCert(), listener).listen(HTTPS_PORT, () => {
    console.log('Unisson prêt.');
    console.log(`  Sur cet ordinateur : http://localhost:${HTTP_PORT}`);
    for (const ip of lanAddresses()) console.log(`  Sur le téléphone   : https://${ip}:${HTTPS_PORT}  (accepter l'avertissement de certificat)`);
  });
});
