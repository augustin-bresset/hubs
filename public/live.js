// Diffusion en direct : l'ordinateur hôte capte un son (carte son, onglet, câble virtuel) et
// l'envoie par tranches aux appareils de la salle. Ici, ce qui ne dépend pas du navigateur :
// format des tranches, tampon de la musique reçue, horloge du flux.

export const LIVE = {
  chunk: 4800, // échantillons par tranche envoyée (100 ms à 48 kHz)
  header: 24, // octets d'en-tête par tranche
  delayMs: 1000, // retard par défaut entre la capture et l'écoute ; doit couvrir la plus grosse latence
  ringSeconds: 20, // musique gardée par chaque appareil pour la comparer à ce que le micro entend
  backlog: 30, // tranches rejouées par le serveur à un appareil qui arrive (3 s)
};

// Tranche : [uint32 octets de son][uint32 canaux][float64 n][float64 t] puis le son en entiers
// 16 bits entrelacés. n : indice du premier échantillon dans le flux ; t : heure serveur (ms) à
// laquelle il a été capté.
export function encodeFrame({ n, t, channels, pcm }) {
  const out = new Uint8Array(LIVE.header + pcm.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, pcm.byteLength, true);
  view.setUint32(4, channels, true);
  view.setFloat64(8, n, true);
  view.setFloat64(16, t, true);
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), LIVE.header);
  return out;
}

// Reconstitue les tranches à partir des morceaux que livre le réseau, coupés n'importe où.
export class FrameParser {
  constructor() {
    this.pending = new Uint8Array(0);
  }

  push(bytes) {
    const joined = new Uint8Array(this.pending.length + bytes.length);
    joined.set(this.pending);
    joined.set(bytes, this.pending.length);
    const frames = [];
    let at = 0;
    while (joined.length - at >= LIVE.header) {
      const view = new DataView(joined.buffer, joined.byteOffset + at, LIVE.header);
      const size = view.getUint32(0, true);
      if (joined.length - at < LIVE.header + size) break;
      // Copie : un Int16Array exige un décalage pair, que le découpage du réseau ne garantit pas.
      const pcm = new Int16Array(joined.slice(at + LIVE.header, at + LIVE.header + size).buffer);
      frames.push({ channels: view.getUint32(4, true), n: view.getFloat64(8, true), t: view.getFloat64(16, true), pcm });
      at += LIVE.header + size;
    }
    this.pending = joined.slice(at);
    return frames;
  }
}

// Horloge du flux : droite reliant l'indice d'échantillon à l'heure serveur de sa capture. Elle suit
// le rythme réel de la carte son de l'hôte, qui n'est jamais exactement la fréquence annoncée.
// points : [{ n, t }] des tranches reçues. Tant que le recul est trop court pour estimer la pente,
// on prend la fréquence nominale.
export function fitStreamClock(points, sampleRate) {
  const nominal = sampleRate / 1000; // échantillons par ms
  const last = points[points.length - 1];
  const count = points.length;
  let mn = 0, mt = 0;
  for (const p of points) { mn += p.n; mt += p.t; }
  mn /= count;
  mt /= count;
  let rate = nominal;
  if (last.t - points[0].t >= 5000) {
    let stt = 0, stn = 0;
    for (const p of points) { stt += (p.t - mt) ** 2; stn += (p.t - mt) * (p.n - mn); }
    rate = Math.max(nominal * 0.999, Math.min(nominal * 1.001, stn / stt));
  }
  return {
    rate,
    posAt: (ms) => mn + (ms - mt) * rate,
    msAt: (n) => mt + (n - mn) / rate,
  };
}

// Musique récemment reçue, en mono, adressée par indice d'échantillon dans le flux.
export class StreamRing {
  constructor(sampleRate) {
    this.data = new Float32Array(Math.round(LIVE.ringSeconds * sampleRate));
    this.start = 0; // premier indice encore disponible
    this.end = 0; // indice suivant le dernier reçu
  }

  write(n, mono) {
    const cap = this.data.length;
    if (this.end === 0 && this.start === 0) this.start = this.end = n;
    // Tranche perdue : le trou est mis à zéro plutôt que de laisser traîner une musique plus ancienne.
    for (let i = this.end; i < n; i++) this.data[((i % cap) + cap) % cap] = 0;
    for (let i = 0; i < mono.length; i++) this.data[(((n + i) % cap) + cap) % cap] = mono[i];
    this.end = Math.max(this.end, n + mono.length);
    this.start = Math.max(this.start, this.end - cap);
  }

  // Copie out.length échantillons à partir de l'indice q ; false s'ils ne sont pas tous disponibles.
  read(q, out) {
    if (q < this.start || q + out.length > this.end) return false;
    const cap = this.data.length;
    for (let i = 0; i < out.length; i++) out[i] = this.data[(((q + i) % cap) + cap) % cap];
    return true;
  }
}
