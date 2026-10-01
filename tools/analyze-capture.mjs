#!/usr/bin/env node
// Rejoue hors ligne le suivi par la musique sur les enregistrements du micro (captures/*.f32 + .json),
// avec le morceau sauvegardé à côté (track-<id>, décodé par ffmpeg).
// Usage : node tools/analyze-capture.mjs [dossier]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROBE, MusicAnalyzer, GapTracker } from '../public/dsp.js';

const dir = process.argv[2] ?? new URL('../captures', import.meta.url).pathname;
const BLOCKS = 32;
const music = new Map(); // « id@fréquence » -> échantillons mono
// Mêmes réglages que la page (TRACK_* dans public/app.js).
let tracker = null;

function loadTrack(id, sampleRate) {
  const key = `${id}@${sampleRate}`;
  if (!music.has(key)) {
    const pcm = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(dir, `track-${id}`), '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
    music.set(key, new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 2));
  }
  return music.get(key);
}

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, file)));
  const label = file.slice(11, 19);
  const pb = meta.playback;
  if (!pb?.playing || !fs.existsSync(path.join(dir, `track-${pb.track}`))) {
    console.log(`${label} : pas de morceau enregistré pour cette capture`);
    continue;
  }
  const sr = meta.sampleRate;
  const raw = fs.readFileSync(path.join(dir, file.replace('.json', '.f32')));
  const rec = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2);
  const ref = loadTrack(pb.track, sr);
  const devices = meta.clients.filter((c) => c.ready && c.slot != null);
  const analyzer = new MusicAnalyzer(sr, new Map(devices.map((c) => [c.id, meta.bands[c.slot]])));
  const block = new Float32Array(PROBE.block), len = PROBE.block + 2 * PROBE.maxLag;
  for (let b = 0; b < BLOCKS; b++) {
    const offsetS = (b * PROBE.block) / sr;
    const q = Math.round((pb.P0 + (meta.windowStartMs + offsetS * 1000 - pb.S0) / 1000) * sr);
    const heardMs = pb.S0 + (q / sr - pb.P0) * 1000;
    const x0 = Math.round(((heardMs - meta.firstServerMs + meta.centerMs) / 1000) * sr) - PROBE.maxLag;
    if (x0 < 0 || x0 + len > rec.length) continue;
    for (let i = 0; i < PROBE.block; i++) block[i] = ref[(((q + i) % ref.length) + ref.length) % ref.length];
    analyzer.addBlock(block, rec.subarray(x0, x0 + len), offsetS);
  }
  tracker ??= new GapTracker(sr, { scoreMin: 12, levelMin: -30, minBlocks: BLOCKS / 2 });
  const res = tracker.update(analyzer);
  const parts = devices.map((c) => {
    const r = res.get(c.id);
    const where = r.detected ? `${((r.lag / sr) * 1000 + meta.centerMs).toFixed(1).padStart(6)} ms` : 'non reconnu';
    return `${c.name} : ${where}, score ${r.score.toFixed(1).padStart(6)}, niveau ${r.level.toFixed(0).padStart(4)} dB${r.windows > 1 ? `, cumul de ${r.windows} fenêtres` : ''}`;
  });
  console.log(`${label} | ${parts.join(' | ')}`);
}
