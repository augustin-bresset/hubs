#!/usr/bin/env node
// Serveur : fichiers statiques, horloge de référence, comptes, salles et relais
// d'événements (SSE). Aucune dépendance : `node server.mjs`.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { randomUUID, X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAuth, isLoopback } from './server/auth.mjs';
import { createRooms } from './server/rooms.mjs';
import { captureApp, listApps, stopAppCapture } from './server/app-audio.mjs';
import { BRAND } from './public/brand.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const CERT_DIR = path.join(ROOT, '.cert');
const HTTP_PORT = Number(process.env.HTTP_PORT ?? 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 8443);
// Adresse publique du service : c'est là que Google renvoie après la connexion.
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${HTTP_PORT}`).replace(/\/$/, '');
const DATA_DIR = process.env.DATA_DIR ?? path.join(ROOT, 'data');
// Enregistrements du micro envoyés par l'appareil qui écoute, pour analyse hors ligne.
const CAPTURE_DIR = process.env.CAPTURE_DIR ?? path.join(ROOT, 'captures');
const MAX_UPLOAD = 80 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.apk': 'application/vnd.android.package-archive',
};
// Tout le code vient du serveur lui-même ; les images distantes servent aux photos de profil.
const CSP = "default-src 'self'; img-src 'self' https: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const now = () => performance.now();
const BOOT = randomUUID(); // l'horloge repart de zéro à chaque démarrage : les pages doivent le savoir

const auth = createAuth({ dataDir: DATA_DIR, publicUrl: PUBLIC_URL });
const rooms = createRooms({ dataDir: DATA_DIR, now, captureDir: CAPTURE_DIR, captureApp });

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

const readJson = async (req) => JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}');

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { ok: false, error: 'introuvable' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': CSP,
    });
    res.end(data);
  });
}

function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname));
  if (!file.startsWith(PUBLIC + path.sep)) return json(res, 403, { ok: false });
  serveFile(res, file);
}

// Ce qui touche à l'ordinateur du serveur (le son de ses applications) n'est offert qu'à une page
// ouverte sur cet ordinateur même, pas à travers un mandataire qui tournerait à côté.
const onThisMachine = (req) => isLoopback(req) && !req.headers['x-forwarded-for'];

// Une action faite avec le cookie de session doit venir de nos propres pages.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function handleRoom(req, res, url, code, rest) {
  const meta = rooms.meta(code);
  if (!meta) return json(res, 404, { ok: false, error: 'salle introuvable' });
  const user = auth.currentUser(req);
  const isOwner = user?.id === meta.ownerId;

  if (rest === '' && req.method === 'GET') return json(res, 200, { ok: true, code: meta.code, name: meta.name, ownerName: meta.ownerName, isOwner });
  if (rest === '' && req.method === 'DELETE') {
    if (!isOwner || !sameOrigin(req)) return json(res, 403, { ok: false, error: 'réservé au créateur de la salle' });
    rooms.remove(code);
    return json(res, 200, { ok: true });
  }

  const room = rooms.open(code);
  if (rest === '/events') {
    const id = url.searchParams.get('id');
    if (!id) return json(res, 400, { ok: false });
    return room.connect(req, res, id.slice(0, 40), (url.searchParams.get('name') || 'Appareil').slice(0, 40));
  }
  if (rest === '/cmd' && req.method === 'POST') return json(res, 200, room.handleCmd(await readJson(req)));

  if (rest === '/track' && req.method === 'POST') {
    // Le morceau est gardé en mémoire sur le serveur : seul le créateur de la salle peut en envoyer un.
    if (!isOwner || !sameOrigin(req)) return json(res, 403, { ok: false, error: 'seul le créateur de la salle peut envoyer un morceau' });
    const data = await readBody(req, MAX_UPLOAD);
    return json(res, 200, { ok: true, track: room.setTrack(url.searchParams.get('name') || 'fichier', req.headers['content-type'] || 'application/octet-stream', data) });
  }
  if (rest.startsWith('/track/') && req.method === 'GET') {
    const track = room.track;
    if (!track || rest.slice('/track/'.length) !== track.id) return json(res, 404, { ok: false });
    res.writeHead(200, { 'Content-Type': track.type, 'Content-Length': track.data.length, 'Cache-Control': 'no-store' });
    return res.end(track.data);
  }
  // Direct : le son passe par le serveur, donc seul le créateur de la salle peut diffuser.
  if (rest === '/live/stream' && req.method === 'GET') {
    if (!room.live.on) return json(res, 404, { ok: false, error: 'aucun direct en cours' });
    return room.listenLive(req, res);
  }
  // Applications de cet ordinateur que le serveur peut capter lui-même pour le direct.
  if (rest === '/live/apps' && req.method === 'GET') return json(res, 200, { ok: true, apps: isOwner && onThisMachine(req) ? await listApps() : [] });
  if (rest.startsWith('/live/') && req.method === 'POST') {
    if (!isOwner || !sameOrigin(req)) return json(res, 403, { ok: false, error: 'seul le créateur de la salle peut diffuser' });
    if (rest === '/live/start') {
      const msg = await readJson(req);
      if (msg.app === undefined) return json(res, 200, room.startLive(msg));
      if (!onThisMachine(req)) return json(res, 403, { ok: false, error: "le son d'une application ne se diffuse que depuis l'ordinateur du serveur" });
      return json(res, 200, room.startAppLive(msg));
    }
    if (rest === '/live/stop') return json(res, 200, room.stopLive());
    if (rest === '/live/chunk') return json(res, 200, { ok: room.pushLive(await readBody(req, 1024 * 1024)) });
  }

  if (rest === '/capture' && req.method === 'POST') {
    // Écrit sur le disque du serveur : réservé à la machine qui l'héberge.
    if (!isLoopback(req)) return json(res, 403, { ok: false });
    const data = await readBody(req, 16 * 1024 * 1024);
    room.saveCapture(JSON.parse(decodeURIComponent(req.headers['x-meta'] ?? '%7B%7D')), data);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { ok: false });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/api/time') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'X-Boot': BOOT });
    return res.end(String(now()));
  }
  if (p === '/api/info') return json(res, 200, { urls: lanAddresses().map((ip) => `https://${ip}:${HTTPS_PORT}`) });

  if (await auth.handle(req, res, url, { json, readJson })) return;

  if (p === '/api/rooms') {
    const user = auth.currentUser(req);
    if (!user) return json(res, 401, { ok: false, error: 'connexion requise' });
    if (req.method === 'GET') return json(res, 200, { ok: true, rooms: rooms.listFor(user.id).map(({ code, name, createdAt }) => ({ code, name, createdAt })) });
    if (req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { ok: false });
      const out = rooms.create(user, (await readJson(req)).name);
      return out.error ? json(res, 409, { ok: false, error: out.error }) : json(res, 201, { ok: true, code: out.meta.code, name: out.meta.name });
    }
    return json(res, 405, { ok: false });
  }
  const m = p.match(/^\/api\/rooms\/([A-Z0-9]{6})(\/.*)?$/);
  if (m) return handleRoom(req, res, url, m[1], m[2] ?? '');

  if (req.method !== 'GET') return json(res, 405, { ok: false });
  if (p === '/') return serveFile(res, path.join(PUBLIC, 'home.html'));
  if (/^\/r\/[A-Za-z0-9]{6}$/.test(p)) return serveFile(res, path.join(PUBLIC, 'room.html'));
  return serveStatic(res, p);
}

function listener(req, res) {
  handle(req, res).catch((err) => {
    if (!res.headersSent) json(res, 500, { ok: false, error: String(err.message ?? err) });
    else res.end();
  });
}

// --- Certificat auto-signé (le micro du navigateur exige HTTPS hors localhost) ---

// Adresses IPv4 de cette machine, celles d'un réseau local (Wi-Fi, box) en premier : c'est la
// première que montre le code QR d'une salle, alors qu'un VPN comme Tailscale (100.x) en ajoute d'autres.
function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|br-|veth|virbr)/.test(name)) continue;
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  const local = (ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return [...out.filter(local), ...out.filter((ip) => !local(ip))];
}

function ensureCert() {
  const ips = ['127.0.0.1', ...lanAddresses()];
  const key = path.join(CERT_DIR, 'key.pem');
  const cert = path.join(CERT_DIR, 'cert.pem');
  const stamp = path.join(CERT_DIR, 'ips');
  const wanted = ips.join(',');
  // Même ensemble d'adresses, dans n'importe quel ordre : le certificat (et son empreinte, que
  // l'application Android a mémorisée) reste le même.
  const sameSet = (text) => text.split(',').sort().join(',') === [...ips].sort().join(',');
  const upToDate = [key, cert, stamp].every((f) => fs.existsSync(f)) && sameSet(fs.readFileSync(stamp, 'utf8'));
  if (!upToDate) {
    fs.mkdirSync(CERT_DIR, { recursive: true });
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365',
      '-keyout', key, '-out', cert, '-subj', '/CN=hubs',
      '-addext', `subjectAltName=DNS:localhost,${ips.map((ip) => `IP:${ip}`).join(',')}`,
    ], { stdio: 'ignore' });
    fs.writeFileSync(stamp, wanted);
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

// Un direct qui capte une application l'a déplacée sur une sortie virtuelle : la lui rendre en partant.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    stopAppCapture();
    process.exit(0);
  });
}

http.createServer(listener).listen(HTTP_PORT, () => {
  const tls = ensureCert();
  https.createServer(tls, listener).listen(HTTPS_PORT, () => {
    console.log(`${BRAND} prêt.`);
    console.log(`  Sur cet ordinateur : http://localhost:${HTTP_PORT}`);
    for (const ip of lanAddresses()) console.log(`  Sur le réseau local : https://${ip}:${HTTPS_PORT}  (accepter l'avertissement de certificat)`);
    // L'application Android montre cette empreinte avant de faire confiance au serveur.
    console.log(`  Empreinte du certificat : ${new X509Certificate(tls.cert).fingerprint256}`);
    console.log(auth.googleEnabled ? `  Connexion Google active, retour sur ${PUBLIC_URL}/auth/callback` : '  Connexion Google non configurée : connexion de développement, depuis cet ordinateur seulement.');
  });
});
