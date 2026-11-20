// events.jsonl の読み書き（行の分割だけ。解釈は core/reduce.js の仕事）。
// 設計書 4.5 の 1：末尾が途中で切れていれば、切れた行を捨てる。

const NL = 0x0a;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

/** 1 つの操作を 1 行（末尾 LF 付き）のバイト列にする。 */
export function encodeEventLine(event) {
  return encoder.encode(JSON.stringify(event) + '\n');
}

/**
 * events.jsonl のバイト列を読む。LF で終わっていない最終行、JSON として読めない行以降は捨てる。
 * @param {Uint8Array} u8
 * @returns {{events: any[], validBytes: number, droppedBytes: number}}
 */
export function parseEventsBytes(u8) {
  const events = [];
  let pos = 0;
  let valid = 0;
  while (pos < u8.length) {
    const nl = u8.indexOf(NL, pos);
    if (nl === -1) break; // LF のない末尾は、途中で切れた行として捨てる
    const line = decoder.decode(u8.subarray(pos, nl));
    pos = nl + 1;
    if (line.trim() === '') { valid = pos; continue; }
    let ev;
    try { ev = JSON.parse(line); } catch { break; }
    if (!ev || typeof ev !== 'object' || !Number.isInteger(ev.seq) || typeof ev.type !== 'string') break;
    events.push(ev);
    valid = pos;
  }
  return { events, validBytes: valid, droppedBytes: u8.length - valid };
}

export function eventsToText(events) {
  return events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
}
