// Enregistre l'entrée (micro) en notant l'indice d'échantillon, dans l'horloge du
// contexte audio, du début de chaque bloc : c'est ce qui permet de dater une arrivée.
class Recorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.start = 0;
    this.on = false;
    this.port.onmessage = (e) => {
      this.on = e.data.on;
      if (!this.on) this.flush();
    };
  }

  flush() {
    if (this.n === 0) return;
    this.port.postMessage({ start: this.start, data: this.buf.slice(0, this.n) });
    this.n = 0;
  }

  process(inputs) {
    if (!this.on) return true;
    const ch = inputs[0][0];
    const len = ch ? ch.length : 128;
    if (this.n + len > this.buf.length) this.flush();
    if (this.n === 0) this.start = currentFrame;
    if (ch) this.buf.set(ch, this.n);
    else this.buf.fill(0, this.n, this.n + len);
    this.n += len;
    return true;
  }
}

registerProcessor('recorder', Recorder);
