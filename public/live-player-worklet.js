// Lecteur du direct : joue le flux reçu à une position et une vitesse pilotées par la page, qui
// l'asservit à l'horloge commune. La position avance avec le temps, que le son soit arrivé ou non :
// une tranche en retard donne un silence, pas un décalage.
class LivePlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.cap = options.processorOptions.capacity;
    this.left = new Float32Array(this.cap);
    this.right = new Float32Array(this.cap);
    this.start = 0; // premier indice du flux encore en mémoire
    this.end = 0; // indice suivant le dernier reçu
    this.empty = true;
    this.pos = 0; // position de lecture dans le flux, fractionnaire
    this.rate = 1; // échantillons du flux par échantillon de sortie
    this.playing = false;
    this.fade = 0;
    this.sinceReport = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'data') this.write(m.n, m.left, m.right);
      else if (m.type === 'rate') this.rate = m.value;
      else if (m.type === 'seek') {
        // `pos` vaut pour l'instant `frame` de l'horloge audio : on rattrape le temps écoulé depuis.
        this.pos = m.pos + (currentFrame - m.frame) * this.rate;
        this.playing = true;
        this.fade = 0;
      }
    };
  }

  write(n, left, right) {
    const cap = this.cap;
    if (this.empty) {
      this.start = this.end = n;
      this.empty = false;
    }
    for (let i = this.end; i < n; i++) { // tranche perdue : silence
      const k = ((i % cap) + cap) % cap;
      this.left[k] = this.right[k] = 0;
    }
    for (let i = 0; i < left.length; i++) {
      const k = (((n + i) % cap) + cap) % cap;
      this.left[k] = left[i];
      this.right[k] = right[i];
    }
    this.end = Math.max(this.end, n + left.length);
    this.start = Math.max(this.start, this.end - cap);
  }

  process(inputs, outputs) {
    const outL = outputs[0][0], outR = outputs[0][1] ?? outL;
    const len = outL.length, cap = this.cap;
    if (this.playing) {
      for (let i = 0; i < len; i++) {
        const i0 = Math.floor(this.pos), f = this.pos - i0;
        if (i0 - 1 >= this.start && i0 + 2 < this.end) {
          // Interpolation cubique entre quatre échantillons voisins (la vitesse n'est jamais exactement 1).
          const a = (((i0 - 1) % cap) + cap) % cap, b = (a + 1) % cap, c = (a + 2) % cap, d = (a + 3) % cap;
          const gain = this.fade < 256 ? this.fade++ / 256 : 1;
          for (const [src, dst] of [[this.left, outL], [this.right, outR]]) {
            const y0 = src[a], y1 = src[b], y2 = src[c], y3 = src[d];
            dst[i] = gain * ((((-0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3) * f + (y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3)) * f + (-0.5 * y0 + 0.5 * y2)) * f + y1);
          }
        } else {
          outL[i] = outR[i] = 0;
          this.fade = 0;
        }
        this.pos += this.rate;
      }
    }
    this.sinceReport += len;
    if (this.sinceReport >= 2048) {
      this.sinceReport = 0;
      this.port.postMessage({ frame: currentFrame + len, pos: this.pos, start: this.start, end: this.end });
    }
    return true;
  }
}

registerProcessor('live-player', LivePlayer);
