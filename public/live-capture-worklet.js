// Hôte du direct : découpe le son capté en tranches, en notant l'indice d'échantillon, dans
// l'horloge du contexte audio, du début de chacune.
class LiveCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = options.processorOptions.chunk;
    this.left = new Float32Array(this.size);
    this.right = new Float32Array(this.size);
    this.n = 0;
    this.start = 0;
    this.on = false;
    this.port.onmessage = (e) => {
      this.on = e.data.on;
      this.n = 0;
    };
  }

  process(inputs) {
    if (!this.on) return true;
    const left = inputs[0][0], right = inputs[0][1] ?? left;
    const len = left ? left.length : 128;
    if (this.n + len > this.size) {
      this.port.postMessage({ start: this.start, left: this.left.slice(0, this.n), right: this.right.slice(0, this.n) });
      this.n = 0;
    }
    if (this.n === 0) this.start = currentFrame;
    if (left) {
      this.left.set(left, this.n);
      this.right.set(right, this.n);
    } else {
      this.left.fill(0, this.n, this.n + len);
      this.right.fill(0, this.n, this.n + len);
    }
    this.n += len;
    return true;
  }
}

registerProcessor('live-capture', LiveCapture);
