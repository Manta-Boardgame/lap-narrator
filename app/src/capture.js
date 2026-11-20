// 音の取得元。どちらも同じ形：
//   { kind, sampleRate, open(), close(), arm(), disarm() → {captured, written}, flush(), info() }
// - マイク（本物の経路）：getUserMedia → AudioWorklet（非圧縮の PCM）→ 保存の Worker へ直接。
// - 開発用（?devinput=1）：既知の PCM を、実時間より速く流せる（devsource.js）。

import { DEFAULT_SAMPLE_RATE } from '../../core/constants.js';

export function micConstraints({ noiseSuppression = false } = {}) {
  // 設計書 4.4：echoCancellation と autoGainControl は切ることを要求する。noiseSuppression は選べる。
  return { echoCancellation: false, autoGainControl: false, noiseSuppression: !!noiseSuppression, channelCount: 1 };
}

/** 要求した値と、getSettings() が返した値を別々に持つ。返されない項目は「不明」。 */
export function describeMic(requested, settings, ctxRate) {
  const actual = {};
  for (const key of ['echoCancellation', 'autoGainControl', 'noiseSuppression', 'channelCount', 'sampleRate', 'latency']) {
    actual[key] = settings && settings[key] !== undefined ? settings[key] : 'unknown';
  }
  actual.contextSampleRate = ctxRate;
  return { requested, actual };
}

export function createMicSource({ backend, noiseSuppression = false, onLevel = () => {}, onInterrupt = () => {} }) {
  let stream = null;
  let ctx = null;
  let node = null;
  let track = null;
  let micInfo = null;
  let armed = false;
  let detachSink = null;
  const src = {
    kind: 'mic',
    sampleRate: 0,
    async open() {
      if (ctx) { if (ctx.state !== 'running') await ctx.resume(); return; }
      const requested = micConstraints({ noiseSuppression });
      stream = await navigator.mediaDevices.getUserMedia({ audio: requested });
      track = stream.getAudioTracks()[0];
      try {
        ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: DEFAULT_SAMPLE_RATE });
      } catch (error) {
        if (error?.name !== 'NotSupportedError') { await src.close(); throw error; }
        try { ctx = new AudioContext({ latencyHint: 'interactive' }); }
        catch (fallbackError) { await src.close(); throw fallbackError; }
      }
      if (ctx.sampleRate !== DEFAULT_SAMPLE_RATE) {
        const actual = ctx.sampleRate;
        await src.close();
        throw new Error(`The microphone captured at ${actual} Hz. This app requires a ${DEFAULT_SAMPLE_RATE} Hz audio context.`);
      }
      await ctx.audioWorklet.addModule(new URL('./worklet/capture-processor.js', import.meta.url));
      const source = ctx.createMediaStreamSource(stream);
      node = new AudioWorkletNode(ctx, 'lap-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      const silent = ctx.createGain();
      silent.gain.value = 0; // 出力は無音（音が出ない）。処理を進めるためだけにつなぐ。
      source.connect(node);
      node.connect(silent);
      silent.connect(ctx.destination);
      const channel = new MessageChannel();
      node.port.postMessage({ cmd: 'sink', port: channel.port1 }, [channel.port1]);
      detachSink = backend.attachSink(channel.port2);
      node.port.onmessage = (e) => { if (e.data && e.data.kind === 'level') onLevel(e.data); };
      track.onmute = () => onInterrupt('mute');
      track.onended = () => onInterrupt('interrupt');
      ctx.onstatechange = () => { if (ctx && ctx.state !== 'running' && armed) onInterrupt('interrupt'); };
      if (ctx.state !== 'running') await ctx.resume();
      src.sampleRate = ctx.sampleRate;
      micInfo = describeMic(requested, track.getSettings ? track.getSettings() : {}, ctx.sampleRate);
    },
    async arm() {
      armed = true;
      node.port.postMessage({ cmd: 'arm', on: true });
    },
    async disarm() {
      if (!node) return { captured: 0, written: 0 };
      const token = backend.newToken();
      const wait = backend.waitAck(token);
      node.port.postMessage({ cmd: 'arm', on: false, token });
      armed = false;
      return wait;
    },
    async flush() {
      if (!node || !armed) return { captured: 0, written: 0 };
      const token = backend.newToken();
      const wait = backend.waitAck(token);
      node.port.postMessage({ cmd: 'flush', token });
      return wait;
    },
    info() { return micInfo; },
    get state() { return ctx ? ctx.state : 'closed'; },
    async close() {
      armed = false;
      const oldStream = stream;
      const oldCtx = ctx;
      const oldTrack = track;
      const oldNode = node;
      const detach = detachSink;
      stream = null; ctx = null; node = null; track = null; detachSink = null;
      if (oldTrack) { oldTrack.onmute = null; oldTrack.onended = null; }
      if (oldCtx) oldCtx.onstatechange = null;
      if (oldNode) { oldNode.port.onmessage = null; oldNode.port.close(); }
      try { oldStream?.getTracks().forEach((t) => t.stop()); } catch { /* 無視 */ }
      try { detach?.(); } catch { /* 無視 */ }
      try { await oldCtx?.close(); } catch { /* 無視 */ }
    },
  };
  return src;
}
