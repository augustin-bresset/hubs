// Direct depuis une application : lecture de la sortie de pactl, découpage du son capté, et cycle de
// vie de la capture dans une salle (avec une fausse capture : aucun son réel n'est touché).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LIVE, FrameParser } from '../public/live.js';
import { parseSinkInputs, PcmSlicer } from '../server/app-audio.mjs';
import { createRooms } from '../server/rooms.mjs';

test('les flux de lecture sont lus dans la sortie de pactl', () => {
  const text = [
    'Sink Input #133', '\tDriver: PipeWire', '\tSink: 54', '\tCorked: yes', '\tProperties:', '\t\tapplication.name = "speech-dispatcher-dummy"', '',
    'Sink Input #1815', '\tDriver: PipeWire', '\tSink: 54', '\tCorked: yes', '\tProperties:', '\t\tmedia.name = "Spotify"', '\t\tapplication.name = "Spotify"', '',
    'Sink Input #4590', '\tSink: 61', '\tProperties:', '\t\tapplication.name = "Lecteur vidéo"', '\t\tmedia.name = "Zimbra: Réception (88)"', '',
    'Sink Input #7', '\tSink: 54', '\tProperties:', '\t\tmedia.name = "sans application"', '',
  ].join('\n');
  assert.deepEqual(parseSinkInputs(text), [
    { index: 133, sink: 54, app: 'speech-dispatcher-dummy' },
    { index: 1815, sink: 54, app: 'Spotify' },
    { index: 4590, sink: 61, app: 'Lecteur vidéo' },
    { index: 7, sink: 54, app: null },
  ]);
  assert.deepEqual(parseSinkInputs(''), []);
});

test('le son capté est découpé en tranches datées de leur premier échantillon', () => {
  const sr = 48000, slicer = new PcmSlicer({ sampleRate: sr, channels: 2 });
  // 1,05 s de son, livré par blocs de 20 ms coupés au milieu d'un échantillon une fois sur deux,
  // chacun avec un retard de livraison différent.
  const total = sr * 1.05, pcm = Buffer.alloc(total * 4), late = [4, 0, 7, 3, 9];
  for (let i = 0; i < total; i++) { pcm.writeInt16LE(i % 30000, i * 4); pcm.writeInt16LE(-1 - (i % 30000), i * 4 + 2); }
  const frames = [], parser = new FrameParser();
  for (let at = 0, k = 0; at < pcm.length; k++) {
    const size = Math.min(pcm.length - at, 3840 + (k % 2 ? 1 : -1));
    at += size;
    // Le flux commence à l'heure 5000 ms ; le dernier échantillon du bloc vient d'être capté.
    for (const frame of slicer.push(pcm.subarray(at - size, at), 5000 + (at / 4 / sr) * 1000 + late[k % late.length])) frames.push(...parser.push(frame));
  }
  assert.equal(frames.length, 10, 'dix tranches complètes de 100 ms, le reste attend la suite');
  frames.forEach((f, k) => {
    assert.deepEqual([f.n, f.channels, f.pcm.length], [LIVE.chunk * k, 2, LIVE.chunk * 2]);
    assert.ok(Math.abs(f.t - (5000 + 100 * k)) < 0.1, `tranche ${k} datée ${f.t} malgré les retards de livraison`);
    assert.deepEqual([f.pcm[0], f.pcm[1]], [(LIVE.chunk * k) % 30000, -1 - ((LIVE.chunk * k) % 30000)]);
  });
});

test('les dates suivent une horloge de capture plus lente que prévu', () => {
  const sr = 48000, slicer = new PcmSlicer({ sampleRate: sr, channels: 2 }), slow = 1 + 200e-6;
  let last;
  for (let k = 1; k <= 3000; k++) for (const frame of slicer.push(Buffer.alloc(3840), 20 * k * slow)) last = new FrameParser().push(frame)[0];
  assert.ok(Math.abs(last.t - (last.n / 48) * slow) < 0.5, `après une minute, date ${last.t} pour ${(last.n / 48) * slow}`);
});

test('la capture d’une application vit et s’arrête avec le direct', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubs-app-'));
  const captures = [];
  const captureApp = (app, hooks) => {
    if (app === 'Absente') throw new Error("Absente n'a aucun son ouvert");
    const capture = { app, hooks, stopped: 0, format: { sampleRate: 48000, channels: 2 }, stop() { this.stopped++; } };
    captures.push(capture);
    return capture;
  };
  try {
    const rooms = createRooms({ dataDir, now: () => 0, captureDir: dataDir, captureApp });
    const room = rooms.open(rooms.create({ id: 'u', name: 'Ada' }, 'Salon').meta.code);
    const join = (id) => {
      const req = new EventEmitter(), sent = [];
      room.connect(req, { writeHead() {}, write: (text) => sent.push(text), end() {} }, id, id);
      room.handleCmd({ type: 'status', id, ready: true });
      return { req, sent };
    };

    assert.equal(room.startAppLive({ id: 'hote', app: 'Spotify' }).ok, false, "l'hôte doit avoir rejoint");
    const host = join('hote');
    const refused = room.startAppLive({ id: 'hote', app: 'Absente', delayMs: 1000 });
    assert.deepEqual([refused.ok, refused.error, room.live.on], [false, "Absente n'a aucun son ouvert", false]);

    const started = room.startAppLive({ id: 'hote', app: 'Spotify', delayMs: 1500 });
    assert.deepEqual([started.ok, started.live.hostId, started.live.sampleRate, started.live.channels, started.live.delayMs], [true, 'hote', 48000, 2, 1500]);
    assert.ok(host.sent.some((text) => text.startsWith('event: live\n') && text.includes('"on":true')), 'direct annoncé aux appareils');
    // Le son capté est relayé à ceux qui écoutent.
    const heard = [];
    room.listenLive(new EventEmitter(), { writeHead() {}, write: (frame) => heard.push(frame), end() {}, writableLength: 0 });
    captures[0].hooks.onFrame('tranche');
    assert.deepEqual(heard, ['tranche']);

    // Un autre direct, l'arrêt, une capture qui tombe, le départ de l'hôte : chaque fois, la capture est rendue.
    room.startAppLive({ id: 'hote', app: 'Stremio' });
    assert.deepEqual(captures.map((c) => [c.app, c.stopped]), [['Spotify', 1], ['Stremio', 0]]);
    room.startLive({ id: 'hote', sampleRate: 44100, channels: 2 });
    assert.equal(captures[1].stopped, 1, 'un direct envoyé par la page remplace celui de l’application');
    room.stopLive();
    assert.equal(captures[1].stopped, 1, 'pas d’arrêt en double');

    room.startAppLive({ id: 'hote', app: 'Spotify' });
    captures[2].hooks.onEnd();
    assert.equal(room.live.on, false, 'la fin de la capture arrête le direct');

    room.startAppLive({ id: 'hote', app: 'Spotify' });
    host.req.emit('close');
    assert.deepEqual([room.live.on, captures[3].stopped], [false, 1], "le départ de l'hôte rend l'application");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
