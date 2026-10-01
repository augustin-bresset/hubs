#!/usr/bin/env node
// Analyse hors ligne des enregistrements du micro (captures/*.f32 + .json) : pour chaque signature,
// retard, score, et amplitude estimée au micro, comparée à celle d'une signature que personne ne joue.
// Usage : node tools/analyze-capture.mjs [dossier]
import fs from 'node:fs';
import path from 'node:path';
import { SIG, makeSignature, signatureTemplates, SignatureAnalyzer } from '../public/dsp.js';

const dir = process.argv[2] ?? new URL('../captures', import.meta.url).pathname;
const ABSENT = 99; // code de signature qu'aucun appareil n'utilise : référence de bruit
const PERIODS = 4;
const blocks = SIG.length / SIG.block;
const sigs = new Map();
const sigOf = (code) => sigs.get(code) ?? sigs.set(code, makeSignature(code)).get(code);
const tmplCache = new Map();
const tmplOf = (code) => tmplCache.get(code) ?? tmplCache.set(code, signatureTemplates(sigOf(code))).get(code);

// Amplitude de la signature dans l'enregistrement, autour du retard `lag` (échantillons) :
// meilleure corrélation normalisée par bloc à ±searchMs, médiane sur les blocs.
function amplitude(rec, index0, code, lag, searchMs = 0.3) {
  const sig = sigOf(code), search = Math.round((searchMs / 1000) * SIG.rate), values = [];
  for (let m = 0; m < PERIODS; m++) {
    for (let j = 0; j < blocks; j++) {
      const at = Math.round(index0 + m * SIG.length + j * SIG.block + lag);
      if (at - search < 0 || at + search + SIG.block >= rec.length) continue;
      let energy = 0, best = 0;
      for (let n = 0; n < SIG.block; n++) energy += sig[j * SIG.block + n] ** 2;
      for (let d = -search; d <= search; d++) {
        let c = 0;
        for (let n = 0; n < SIG.block; n++) c += rec[at + d + n] * sig[j * SIG.block + n];
        best = Math.max(best, Math.abs(c));
      }
      values.push(best / energy);
    }
  }
  values.sort((a, b) => a - b);
  return values[values.length >> 1];
}

const db = (v) => (20 * Math.log10(v)).toFixed(1).padStart(6);
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, file)));
  const rec = new Float32Array(fs.readFileSync(path.join(dir, file.replace('.json', '.f32'))).buffer.slice(0));
  if (meta.sampleRate !== SIG.rate) { console.log(file, ': fréquence', meta.sampleRate, 'non gérée'); continue; }
  const index0 = ((meta.windowStartMs - meta.firstServerMs) / 1000) * SIG.rate + (meta.centerMs / 1000) * SIG.rate;
  const devices = meta.clients.filter((c) => c.ready && c.code != null);
  const analyzer = new SignatureAnalyzer(new Map([...devices.map((c) => [c.code, tmplOf(c.code)]), [ABSENT, tmplOf(ABSENT)]]));
  const slice = new Float32Array(SIG.block + 2 * SIG.maxLag);
  for (let m = 0; m < PERIODS; m++) {
    for (let j = 0; j < blocks; j++) {
      const at = Math.round(index0 + m * SIG.length + j * SIG.block - SIG.maxLag);
      if (at < 0 || at + slice.length > rec.length) continue;
      slice.set(rec.subarray(at, at + slice.length));
      analyzer.addBlock(j, slice, (m * SIG.length + j * SIG.block) / SIG.rate);
    }
  }
  const res = analyzer.results();
  let rms = 0;
  for (const v of rec) rms += v * v;
  rms = Math.sqrt(rms / rec.length);
  // Retard de référence : celui de l'appareil le mieux détecté (les autres en sont à quelques ms).
  const best = devices.map((c) => res.get(c.code)).sort((a, b) => b.score - a.score)[0];
  const noise = amplitude(rec, index0, ABSENT, best.lag, 3);
  const parts = devices.map((c) => {
    const r = res.get(c.code);
    const amp = amplitude(rec, index0, c.code, r.score >= 8 ? r.lag : best.lag, r.score >= 8 ? 0.3 : 3);
    return `${c.name}: score ${r.score.toFixed(1).padStart(6)}, ${((r.lag / SIG.rate) * 1000 + meta.centerMs).toFixed(1).padStart(5)} ms, amplitude ${db(amp)} dB`;
  });
  console.log(`${file.slice(11, 19)} lecture ${meta.playback.playing ? 'oui' : 'non'} curseur ${meta.tracking.levelDb} dB micro ${db(rms)} dB RMS | ${parts.join(' | ')} | plancher ${db(noise)} dB`);
}
