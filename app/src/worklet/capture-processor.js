// マイクの音を、非圧縮の PCM（Int16、モノラル）で取り出す AudioWorklet（設計書 4.4）。MediaRecorder は使わない。
//
// - 'sink' ：保存を受け持つ Worker へ直接つながるポートを受け取る（メインのスレッドを通さない）。
// - 'arm'  ：true の間だけ音声を Worker へ送る。false にすると、持っている分を送り切って ack を返す。
// - 'flush'：持っている分を送り、ack を返す（OK を押した位置に、直前までの音を含めるため）。
// - 音量（ピーク）は、約 50 ミリ秒ごとにメインのスレッドへ知らせる（音量計と音割れの警告）。

const CHUNK = 2048; // 約 43 ミリ秒（48kHz）

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sink = null;
    this.armed = false;
    this.buf = new Int16Array(CHUNK);
    this.n = 0;
    this.frame = 0; // arm してから送った（または貯めた）フレーム数
    this.sentFrame = 0;
    this.peak = 0;
    this.sumSq = 0;
    this.meterCount = 0;
    this.meterEvery = Math.max(128, Math.round(sampleRate * 0.05));
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.cmd === 'sink') {
        this.sink = m.port;
      } else if (m.cmd === 'arm') {
        if (m.on) {
          this.armed = true;
          this.n = 0;
          this.frame = 0;
          this.sentFrame = 0;
        } else {
          this.sendPartial();
          this.armed = false;
          this.ack(m.token);
        }
      } else if (m.cmd === 'flush') {
        this.sendPartial();
        this.ack(m.token);
      }
    };
  }

  sendPartial() {
    if (this.n > 0 && this.sink) {
      const out = new Int16Array(this.n);
      out.set(this.buf.subarray(0, this.n));
      this.sink.postMessage({ kind: 'pcm', buf: out.buffer, frame: this.sentFrame }, [out.buffer]);
      this.sentFrame += this.n;
      this.n = 0;
    }
  }

  ack(token) {
    if (this.sink) this.sink.postMessage({ kind: 'ack', token, frames: this.sentFrame });
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch) return true;
    const len = ch.length;
    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < len; i++) {
      const x = ch[i];
      const a = x < 0 ? -x : x;
      if (a > peak) peak = a;
      sumSq += x * x;
    }
    if (peak > this.peak) this.peak = peak;
    this.sumSq += sumSq;
    this.meterCount += len;
    if (this.meterCount >= this.meterEvery) {
      this.port.postMessage({ kind: 'level', peak: this.peak, rms: Math.sqrt(this.sumSq / this.meterCount) });
      this.peak = 0;
      this.sumSq = 0;
      this.meterCount = 0;
    }
    if (this.armed && this.sink) {
      for (let i = 0; i < len; i++) {
        let x = ch[i];
        if (x > 1) x = 1; else if (x < -1) x = -1;
        this.buf[this.n++] = Math.round(x < 0 ? x * 32768 : x * 32767);
        if (this.n === CHUNK) {
          const out = new Int16Array(CHUNK);
          out.set(this.buf);
          this.sink.postMessage({ kind: 'pcm', buf: out.buffer, frame: this.sentFrame }, [out.buffer]);
          this.sentFrame += CHUNK;
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('lap-capture', CaptureProcessor);
