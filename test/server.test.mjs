// Comptes et salles, contre un vrai serveur et un faux fournisseur d'identité (à la place de Google).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = 18180, TLS_PORT = 18543, IDP_PORT = 18181;
const BASE = `http://localhost:${PORT}`;
const CLIENT_ID = 'client-de-test', CLIENT_SECRET = 'secret-de-test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-server-'));
const b64url = (data) => Buffer.from(data).toString('base64url');

// --- Faux fournisseur : signe des jetons d'identité avec sa clé, publie la clé publique ---
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const idp = { challenge: null, claims: {}, signWith: privateKey, alg: 'RS256', seen: null };

function idToken() {
  const header = b64url(JSON.stringify({ alg: idp.alg, kid: 'cle-1', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: 'https://faux-fournisseur.test', aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 300, sub: '42', email: 'ada@example.org', email_verified: true, name: 'Ada', ...idp.claims }));
  const sig = idp.alg === 'none' ? '' : crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), idp.signWith).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

const provider = http.createServer((req, res) => {
  if (req.url === '/jwks') return res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'cle-1', alg: 'RS256', use: 'sig' }] }));
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const form = new URLSearchParams(body);
    idp.seen = Object.fromEntries(form);
    // PKCE : le vérificateur présenté doit correspondre au défi envoyé au départ du flux.
    const pkceOk = b64url(crypto.createHash('sha256').update(form.get('code_verifier') ?? '').digest()) === idp.challenge;
    if (form.get('code') !== 'code-valide' || form.get('client_secret') !== CLIENT_SECRET || !pkceOk) {
      res.statusCode = 400;
      return res.end('{}');
    }
    res.end(JSON.stringify({ id_token: idToken() }));
  });
});

let server;
before(async () => {
  await new Promise((r) => provider.listen(IDP_PORT, r));
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env, HTTP_PORT: PORT, HTTPS_PORT: TLS_PORT, DATA_DIR: path.join(tmp, 'data'), CAPTURE_DIR: path.join(tmp, 'captures'), PUBLIC_URL: BASE,
      GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
      OIDC_AUTH_URL: `http://localhost:${IDP_PORT}/auth`, OIDC_TOKEN_URL: `http://localhost:${IDP_PORT}/token`, OIDC_JWKS_URL: `http://localhost:${IDP_PORT}/jwks`, OIDC_ISSUER: 'https://faux-fournisseur.test',
    },
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('prêt') && resolve());
    server.stderr.on('data', (d) => reject(new Error(String(d))));
  });
});
after(() => {
  server?.kill();
  provider.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const cookieOf = (res, name) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`)) ?? null;
const get = (url, cookie) => fetch(BASE + url, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
const post = (url, body, cookie, headers = {}) => fetch(BASE + url, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) });

// Déroule la connexion comme le ferait un navigateur. `tamper` permet de fausser une étape.
async function login({ state, tamper } = {}) {
  Object.assign(idp, { claims: {}, signWith: privateKey, alg: 'RS256' });
  const start = await get('/auth/login?next=/r/ABC234');
  assert.equal(start.status, 302);
  const target = new URL(start.headers.get('location'));
  idp.challenge = target.searchParams.get('code_challenge');
  tamper?.(target);
  if (!idp.claims.nonce) idp.claims.nonce = target.searchParams.get('nonce');
  const back = await get(`/auth/callback?code=code-valide&state=${state ?? target.searchParams.get('state')}`, cookieOf(start, 'oidc'));
  return { start: target, back, session: cookieOf(back, 'session') };
}

test('la connexion suit le flux attendu et ouvre une session', async () => {
  const { start, back, session } = await login();
  assert.equal(start.origin + start.pathname, `http://localhost:${IDP_PORT}/auth`);
  assert.equal(start.searchParams.get('redirect_uri'), `${BASE}/auth/callback`);
  assert.equal(start.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(idp.seen.redirect_uri, `${BASE}/auth/callback`);
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), '/r/ABC234', 'retour sur la page demandée');
  assert.match(back.headers.getSetCookie().find((c) => c.startsWith('session=')), /HttpOnly; SameSite=Lax/);
  const me = await (await get('/api/me', session)).json();
  assert.deepEqual([me.user.name, me.user.email, me.google, me.devLogin], ['Ada', 'ada@example.org', true, false]);
});

test('un jeton d’identité douteux est refusé', async () => {
  const cases = {
    'autre destinataire': () => { idp.claims.aud = 'une-autre-application'; },
    'autre émetteur': () => { idp.claims.iss = 'https://ailleurs.test'; },
    'expiré': () => { idp.claims.exp = Math.floor(Date.now() / 1000) - 10; },
    'nonce rejoué': () => { idp.claims.nonce = 'nonce-d-une-autre-connexion'; },
    'signé par une autre clé': () => { idp.signWith = other.privateKey; },
    'sans signature': () => { idp.alg = 'none'; },
    'adresse non vérifiée': () => { idp.claims.email_verified = false; },
  };
  for (const [name, tamper] of Object.entries(cases)) {
    const { back, session } = await login({ tamper });
    assert.equal(back.status, 400, name);
    assert.equal(session, null, name);
  }
});

test('un retour de connexion sans demande correspondante est refusé', async () => {
  assert.equal((await login({ state: 'etat-forge' })).back.status, 400);
  assert.equal((await get('/auth/callback?code=code-valide&state=x')).status, 400, 'sans cookie de flux');
});

test('une session falsifiée ne vaut rien, et la connexion de développement est fermée quand Google est configuré', async () => {
  const { session } = await login();
  const forged = `session=${b64url(JSON.stringify({ uid: 'google:42', exp: 9999999999 }))}.signature-inventee`;
  assert.equal((await (await get('/api/me', forged)).json()).user, null);
  assert.equal((await (await get('/api/me', `${session}x`)).json()).user, null);
  assert.equal((await post('/auth/dev', { name: 'Intrus' })).status, 403);
  assert.equal((await post('/api/rooms', { name: 'x' })).status, 401, 'créer une salle demande un compte');
});

test('salles : création, droits du créateur, isolation, suppression', async () => {
  const { session } = await login();
  const created = await post('/api/rooms', { name: 'Salon' }, session);
  assert.equal(created.status, 201);
  const a = (await created.json()).code;
  const b = (await (await post('/api/rooms', { name: 'Terrasse' }, session)).json()).code;
  assert.match(a, /^[A-Z2-9]{6}$/);
  assert.notEqual(a, b);
  assert.deepEqual((await (await get('/api/rooms', session)).json()).rooms.map((r) => r.name), ['Salon', 'Terrasse']);

  assert.equal((await (await get(`/api/rooms/${a}`, session)).json()).isOwner, true);
  const asGuest = await (await get(`/api/rooms/${a}`)).json();
  assert.deepEqual([asGuest.name, asGuest.isOwner], ['Salon', false]);
  assert.equal((await get('/api/rooms/ZZZZZZ')).status, 404);
  assert.equal((await get('/api/rooms/ZZZZZZ/events?id=x')).status, 404);

  // Seul le créateur envoie un morceau, et pas depuis une page d'un autre site.
  const audio = new Uint8Array([1, 2, 3, 4]);
  assert.equal((await post(`/api/rooms/${a}/track?name=essai.wav`, audio, null, { 'Content-Type': 'audio/wav' })).status, 403);
  assert.equal((await post(`/api/rooms/${a}/track?name=essai.wav`, audio, session, { 'Content-Type': 'audio/wav', Origin: 'https://site-malveillant.test' })).status, 403);
  const sent = await (await post(`/api/rooms/${a}/track?name=essai.wav`, audio, session, { 'Content-Type': 'audio/wav' })).json();
  assert.equal(sent.track.name, 'essai.wav');
  assert.deepEqual(new Uint8Array(await (await get(`/api/rooms/${a}/track/${sent.track.id}`)).arrayBuffer()), audio, 'un invité peut le télécharger');
  assert.equal((await get(`/api/rooms/${b}/track/${sent.track.id}`)).status, 404, 'mais pas depuis une autre salle');

  // Une commande dans une salle ne touche pas l'autre.
  const hello = async (code) => {
    const res = await get(`/api/rooms/${code}/events?id=test&name=Test`);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    reader.cancel();
    return JSON.parse(new TextDecoder().decode(value).split('\n').find((l) => l.startsWith('data: ')).slice(6));
  };
  assert.equal((await (await post(`/api/rooms/${a}/cmd`, { type: 'play', id: 'test' })).json()).ok, true);
  assert.equal((await hello(a)).playback.playing, true);
  assert.equal((await hello(b)).playback.playing, false);

  assert.equal((await fetch(`${BASE}/api/rooms/${a}`, { method: 'DELETE' })).status, 403, 'un invité ne supprime pas');
  assert.equal((await fetch(`${BASE}/api/rooms/${a}`, { method: 'DELETE', headers: { Cookie: session } })).status, 200);
  assert.equal((await get(`/api/rooms/${a}`)).status, 404);
  assert.equal((await get(`/api/rooms/${b}`)).status, 200);
});

test('les pages sont servies avec une politique de sécurité de contenu', async () => {
  for (const url of ['/', '/r/ABC234']) {
    const res = await get(url);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  }
  assert.equal((await get('/../server.mjs')).status, 404);
});
