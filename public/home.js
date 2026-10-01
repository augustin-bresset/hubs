// Page d'accueil : rejoindre une salle par son code, se connecter, créer et gérer ses salles.
import { BRAND } from './brand.js';

const $ = (id) => document.getElementById(id);
for (const el of document.querySelectorAll('[data-brand]')) el.textContent = BRAND;
document.title = BRAND;

const api = async (path, options = {}) => {
  const r = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};

$('joinForm').onsubmit = (e) => {
  e.preventDefault();
  const code = $('code').value.trim().toUpperCase();
  if (/^[A-Z0-9]{6}$/.test(code)) location.href = `/r/${code}`;
  else $('code').focus();
};

async function renderRooms() {
  const { rooms = [] } = await api('/api/rooms');
  const box = $('rooms');
  box.replaceChildren(...rooms.map((room) => {
    const row = document.createElement('div');
    row.className = 'device';
    const title = document.createElement('div');
    title.className = 'title';
    const link = document.createElement('a');
    link.href = `/r/${room.code}`;
    link.textContent = room.name;
    const code = document.createElement('span');
    code.className = 'lat';
    code.textContent = room.code;
    title.append(link, code);
    const actions = document.createElement('div');
    actions.className = 'nudge';
    const open = document.createElement('a');
    open.className = 'button';
    open.href = `/r/${room.code}`;
    open.textContent = 'Ouvrir';
    const remove = document.createElement('button');
    remove.textContent = 'Supprimer';
    remove.onclick = async () => {
      if (!confirm(`Supprimer la salle « ${room.name} » ?`)) return;
      await api(`/api/rooms/${room.code}`, { method: 'DELETE' });
      renderRooms();
    };
    actions.append(open, remove);
    row.append(title, actions);
    return row;
  }));
  $('roomsHint').textContent = rooms.length ? 'Partage le lien ou le code d’une salle pour que les autres appareils la rejoignent.' : 'Aucune salle pour l’instant.';
}

async function render() {
  const me = await api('/api/me');
  $('loginCard').hidden = !!me.user;
  $('roomsCard').hidden = !me.user;
  const account = $('account');
  account.replaceChildren();
  if (me.user) {
    const name = document.createElement('span');
    name.textContent = me.user.name;
    const out = document.createElement('button');
    out.textContent = 'Se déconnecter';
    out.onclick = async () => {
      await api('/auth/logout', { method: 'POST' });
      render();
    };
    account.append(name, out);
    await renderRooms();
    return;
  }
  $('google').hidden = !me.google;
  $('devForm').hidden = !me.devLogin;
  $('loginHint').textContent = me.google
    ? ''
    : me.devLogin
      ? 'La connexion Google n’est pas configurée sur ce serveur. La connexion de développement, sans mot de passe, n’est proposée que sur la machine qui l’héberge.'
      : 'La connexion n’est pas configurée sur ce serveur.';
}

$('devForm').onsubmit = async (e) => {
  e.preventDefault();
  await api('/auth/dev', { method: 'POST', body: JSON.stringify({ name: $('devName').value }) });
  render();
};

$('createForm').onsubmit = async (e) => {
  e.preventDefault();
  const out = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: $('roomName').value }) });
  if (out.code) location.href = `/r/${out.code}`;
  else $('roomsHint').textContent = out.error ?? 'Création impossible.';
};

render();
