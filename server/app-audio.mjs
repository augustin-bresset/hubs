// Son d'une application de cet ordinateur (Spotify, lecteur vidéo…) comme source du direct, sous
// Linux (PipeWire ou PulseAudio). Le serveur crée une sortie virtuelle, y déplace l'application et
// capte ce qui en sort : rien à régler dans le système. À l'arrêt, l'application retrouve sa sortie
// et la sortie virtuelle disparaît.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { LIVE, encodeFrame } from '../public/live.js';

const FORMAT = { sampleRate: 48000, channels: 2 }; // ce que le serveur demande à la capture
const SINK = 'hubs_direct';
const WATCH_MS = 2000; // l'application peut ouvrir un nouveau flux en cours de route
const HIDDEN = /^speech-dispatcher/; // flux muet ouvert en permanence par certaines distributions
const RELAX = 5e-4; // ms par ms : dérive d'horloge de capture que les dates peuvent suivre (500 ppm)
// LC_ALL=C : la sortie de pactl est traduite, on la lit dans sa forme d'origine.
const OPTIONS = { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C' } };

const pactl = (...args) => execFileSync('pactl', args.map(String), { ...OPTIONS, stdio: ['ignore', 'pipe', 'ignore'] });
const pactlLater = (...args) => new Promise((resolve, reject) => {
  execFile('pactl', args, OPTIONS, (err, out) => (err ? reject(err) : resolve(out)));
});

// Flux de lecture ouverts, d'après `pactl list sink-inputs` : numéro, sortie, application.
export function parseSinkInputs(text) {
  return text.split(/^Sink Input #/m).slice(1).map((block) => ({
    index: Number(block.match(/^\d+/)[0]),
    sink: Number(block.match(/^\tSink: (\d+)/m)?.[1]),
    app: block.match(/^\t\tapplication\.name = "(.*)"$/m)?.[1] ?? null,
  }));
}

// Applications qui ont un flux de lecture ouvert, même en pause. Vide si le système ne s'y prête pas.
export async function listApps() {
  try {
    const names = parseSinkInputs(await pactlLater('list', 'sink-inputs')).map((s) => s.app).filter((name) => name && !HIDDEN.test(name));
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

// Découpe le son brut (entiers 16 bits entrelacés) en tranches datées, au format de public/live.js.
export class PcmSlicer {
  constructor({ sampleRate, channels }) {
    Object.assign(this, { sampleRate, channels, sampleBytes: 2 * channels, pending: Buffer.alloc(0), n: 0, origin: null, lastMs: 0 });
  }

  // bytes : son reçu à l'heure nowMs. Son dernier échantillon vient d'être capté, à un délai de
  // livraison près qui varie d'un bloc à l'autre (plusieurs ms) mais ne fait que retarder. L'heure
  // du début du flux est donc la plus petite de celles que donnent les blocs, relâchée lentement
  // pour suivre une horloge de capture plus lente que sa fréquence annoncée.
  push(bytes, nowMs) {
    this.pending = Buffer.concat([this.pending, bytes]);
    const ms = (samples) => (samples * 1000) / this.sampleRate;
    const seen = nowMs - ms(this.n + this.pending.length / this.sampleBytes);
    this.origin = this.origin === null ? seen : Math.min(seen, this.origin + RELAX * (nowMs - this.lastMs));
    this.lastMs = nowMs;
    const size = LIVE.chunk * this.sampleBytes, frames = [];
    while (this.pending.length >= size) {
      frames.push(encodeFrame({ n: this.n, t: this.origin + ms(this.n), channels: this.channels, pcm: this.pending.subarray(0, size) }));
      this.pending = this.pending.subarray(size);
      this.n += LIVE.chunk;
    }
    return frames;
  }
}

function sinkIndex() {
  const line = pactl('list', 'short', 'sinks').split('\n').map((l) => l.split('\t')).find((cols) => cols[1] === SINK);
  return line ? Number(line[0]) : null;
}

let active = null; // une seule sortie virtuelle, donc une seule capture à la fois sur la machine

// Capte le son d'une application. onFrame reçoit des tranches prêtes à relayer ; onEnd est appelé
// si la capture s'interrompt d'elle-même. Rend le format du son capté et stop(), qui remet tout en place.
export function captureApp(app, { now, onFrame, onEnd }) {
  if (active) throw new Error('une application est déjà diffusée depuis cet ordinateur');
  let streams;
  try {
    streams = parseSinkInputs(pactl('list', 'sink-inputs')).filter((s) => s.app === app);
  } catch {
    throw new Error("la capture d'une application n'est pas disponible sur ce système");
  }
  if (!streams.length) throw new Error(`${app} n'a aucun son ouvert : lance l'application, puis réessaie`);

  // Une sortie restée d'un arrêt brutal est reprise telle quelle, puis retirée à la fin comme les autres.
  if (sinkIndex() === null) pactl('load-module', 'module-null-sink', `sink_name=${SINK}`, 'sink_properties=device.description=Hubs-direct');
  const sink = sinkIndex();
  const origin = new Map(); // flux déplacé -> sa sortie d'avant
  const adopt = (list) => {
    for (const s of list) {
      if (s.sink === sink) continue;
      try {
        pactl('move-sink-input', s.index, SINK);
        origin.set(s.index, s.sink);
      } catch { /* flux refermé entre-temps */ }
    }
  };
  adopt(streams);

  let stopped = false;
  const watch = setInterval(() => {
    pactlLater('list', 'sink-inputs').then((text) => {
      if (!stopped) adopt(parseSinkInputs(text).filter((s) => s.app === app));
    }, () => {});
  }, WATCH_MS);

  const slicer = new PcmSlicer(FORMAT);
  const rec = spawn('parec', [`--device=${SINK}.monitor`, '--format=s16le', `--rate=${FORMAT.sampleRate}`, `--channels=${FORMAT.channels}`, '--latency-msec=20', '--client-name=Hubs'], { stdio: ['ignore', 'pipe', 'ignore'] });
  rec.stdout.on('data', (bytes) => {
    for (const frame of slicer.push(bytes, now())) onFrame(frame);
  });

  function stop() {
    if (stopped) return;
    stopped = true;
    active = null;
    clearInterval(watch);
    rec.kill();
    try {
      // Chaque flux retrouve sa sortie d'avant ; celui ouvert en cours de route, la sortie par défaut.
      for (const s of parseSinkInputs(pactl('list', 'sink-inputs')).filter((s) => s.sink === sink)) {
        try {
          pactl('move-sink-input', s.index, origin.get(s.index) ?? '@DEFAULT_SINK@');
        } catch { /* sortie débranchée entre-temps : le système le replace lui-même */ }
      }
      for (const line of pactl('list', 'short', 'modules').split('\n')) {
        if (line.includes(`sink_name=${SINK}`)) pactl('unload-module', line.split('\t')[0]);
      }
    } catch { /* serveur de son injoignable : plus rien à remettre en place */ }
  }
  const ended = () => {
    if (stopped) return;
    stop();
    onEnd();
  };
  rec.on('error', ended);
  rec.on('exit', ended);

  active = { format: FORMAT, stop };
  return active;
}

// À l'arrêt du serveur : rend sa sortie à l'application en cours de diffusion.
export const stopAppCapture = () => active?.stop();
