// Comptes et sessions : connexion par Google (OpenID Connect, flux « code » avec PKCE) et session
// portée par un cookie signé. Aucune dépendance : la signature du jeton d'identité est vérifiée
// avec node:crypto à partir des clés publiques du fournisseur.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SESSION_DAYS = 30;
const b64url = (data) => Buffer.from(data).toString('base64url');
const fromB64url = (text) => Buffer.from(text, 'base64url');

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

export function createAuth({ dataDir, publicUrl, env = process.env }) {
  const cfg = {
    clientId: env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
    // Surchargés dans les tests par un faux fournisseur.
    authUrl: env.OIDC_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: env.OIDC_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
    jwksUrl: env.OIDC_JWKS_URL ?? 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: (env.OIDC_ISSUER ?? 'https://accounts.google.com,accounts.google.com').split(','),
  };
  const googleEnabled = Boolean(cfg.clientId && cfg.clientSecret);

  fs.mkdirSync(dataDir, { recursive: true });
  const secretFile = path.join(dataDir, 'session-secret');
  if (!env.SESSION_SECRET && !fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const secret = env.SESSION_SECRET ?? fs.readFileSync(secretFile, 'utf8');

  const usersFile = path.join(dataDir, 'users.json');
  const users = new Map(fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile, 'utf8')).map((u) => [u.id, u]) : []);
  const saveUsers = () => fs.writeFileSync(usersFile, JSON.stringify([...users.values()], null, 1));

  // --- Jetons signés (session, état du flux de connexion) ---

  const mac = (text) => crypto.createHmac('sha256', secret).update(text).digest('base64url');
  function sign(payload, maxAgeS) {
    const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + maxAgeS }));
    return `${body}.${mac(body)}`;
  }
  function verify(token) {
    const [body, sig] = String(token ?? '').split('.');
    if (!body || !sig) return null;
    const expected = Buffer.from(mac(body)), given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    try {
      const payload = JSON.parse(fromB64url(body).toString('utf8'));
      return payload.exp > Date.now() / 1000 ? payload : null;
    } catch {
      return null;
    }
  }

  // Derrière un mandataire qui termine le HTTPS, TRUST_PROXY=1 fait confiance à son en-tête.
  const isSecure = (req) => Boolean(req.socket.encrypted) || (env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] === 'https');
  function cookie(req, name, value, maxAgeS) {
    return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${isSecure(req) ? '; Secure' : ''}`;
  }

  function currentUser(req) {
    const session = verify(parseCookies(req).session);
    return (session && users.get(session.uid)) || null;
  }

  function upsertUser({ provider, sub, email, name, picture }) {
    const id = `${provider}:${sub}`;
    const now = new Date().toISOString();
    const user = { createdAt: now, ...users.get(id), id, email: email ?? null, name: name || email || 'Sans nom', picture: picture ?? null, lastLoginAt: now };
    users.set(id, user);
    saveUsers();
    return user;
  }

  function startSession(req, res, user, location) {
    res.writeHead(302, {
      Location: location,
      'Set-Cookie': [cookie(req, 'session', sign({ uid: user.id }, SESSION_DAYS * 86400), SESSION_DAYS * 86400), cookie(req, 'oidc', '', 0)],
    });
    res.end();
  }

  // --- Vérification du jeton d'identité ---

  const keys = new Map(); // kid -> clé publique
  let keysFetchedAt = 0;
  async function publicKey(kid) {
    if (!keys.has(kid) && Date.now() - keysFetchedAt > 60000) {
      keysFetchedAt = Date.now();
      const jwks = await (await fetch(cfg.jwksUrl)).json();
      keys.clear();
      for (const jwk of jwks.keys ?? []) keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    }
    return keys.get(kid) ?? null;
  }

  async function verifyIdToken(idToken, nonce) {
    const [h, p, s] = String(idToken ?? '').split('.');
    if (!h || !p || !s) throw new Error('jeton mal formé');
    const header = JSON.parse(fromB64url(h).toString('utf8'));
    if (header.alg !== 'RS256') throw new Error('algorithme de signature refusé');
    const key = await publicKey(header.kid);
    if (!key || !crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, fromB64url(s))) throw new Error('signature invalide');
    const claims = JSON.parse(fromB64url(p).toString('utf8'));
    if (!cfg.issuers.includes(claims.iss)) throw new Error('émetteur inattendu');
    if (claims.aud !== cfg.clientId) throw new Error('jeton destiné à une autre application');
    if (!(claims.exp > Date.now() / 1000)) throw new Error('jeton expiré');
    if (claims.nonce !== nonce) throw new Error('nonce inattendu');
    if (claims.email && claims.email_verified === false) throw new Error('adresse non vérifiée');
    return claims;
  }

  const safeNext = (next) => (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/');
  const fail = (res, code, error) => {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Connexion impossible : ${error}`);
  };

  // --- Routes ---

  async function handle(req, res, url, { json, readJson }) {
    const p = url.pathname;

    if (p === '/api/me') {
      const user = currentUser(req);
      json(res, 200, { user: user && { id: user.id, name: user.name, email: user.email, picture: user.picture }, google: googleEnabled, devLogin: devLoginAllowed(req) });
      return true;
    }

    if (p === '/auth/login') {
      if (!googleEnabled) return fail(res, 503, 'la connexion Google n’est pas configurée sur ce serveur'), true;
      const state = b64url(crypto.randomBytes(16)), nonce = b64url(crypto.randomBytes(16)), verifier = b64url(crypto.randomBytes(32));
      const query = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: `${publicUrl}/auth/callback`,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      res.writeHead(302, {
        Location: `${cfg.authUrl}?${query}`,
        'Set-Cookie': cookie(req, 'oidc', sign({ state, nonce, verifier, next: safeNext(url.searchParams.get('next')) }, 600), 600),
      });
      res.end();
      return true;
    }

    if (p === '/auth/callback') {
      const flow = verify(parseCookies(req).oidc);
      if (!flow || !url.searchParams.get('state') || url.searchParams.get('state') !== flow.state) return fail(res, 400, 'demande de connexion inconnue ou expirée'), true;
      if (url.searchParams.get('error')) return fail(res, 400, url.searchParams.get('error')), true;
      try {
        const reply = await fetch(cfg.tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: url.searchParams.get('code') ?? '',
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
            redirect_uri: `${publicUrl}/auth/callback`,
            code_verifier: flow.verifier,
          }),
        });
        if (!reply.ok) throw new Error(`échange du code refusé (${reply.status})`);
        const claims = await verifyIdToken((await reply.json()).id_token, flow.nonce);
        const user = upsertUser({ provider: 'google', sub: claims.sub, email: claims.email, name: claims.name, picture: claims.picture });
        startSession(req, res, user, flow.next);
      } catch (err) {
        fail(res, 400, err.message);
      }
      return true;
    }

    if (p === '/auth/dev' && req.method === 'POST') {
      if (!devLoginAllowed(req)) return json(res, 403, { ok: false, error: 'connexion de développement désactivée' }), true;
      const name = String((await readJson(req)).name ?? '').trim().slice(0, 40) || 'Développeur';
      const user = upsertUser({ provider: 'dev', sub: name.toLowerCase(), name });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': cookie(req, 'session', sign({ uid: user.id }, SESSION_DAYS * 86400), SESSION_DAYS * 86400) });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }

    if (p === '/auth/logout' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': cookie(req, 'session', '', 0) });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }
    return false;
  }

  // Connexion sans mot de passe, pour développer sans compte Google : seulement depuis la machine
  // qui héberge le serveur, tant que Google n'est pas configuré (ou si DEV_LOGIN=1 le force).
  function devLoginAllowed(req) {
    if (env.DEV_LOGIN === '1') return true;
    return env.DEV_LOGIN !== '0' && !googleEnabled && isLoopback(req) && !req.headers['x-forwarded-for'];
  }

  return { handle, currentUser, googleEnabled };
}
