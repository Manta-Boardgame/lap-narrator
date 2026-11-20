// 型の定義（JSDoc のみ。実行時には何もしない）。CONTRACTS.md と schema/ が正。

/**
 * @typedef {{raw: string, sample: number, pos: number}} Position
 * @typedef {{seq: number, eventId: string, type: string, wall: string, mono: number, at?: Position, [k: string]: any}} LapEvent
 * @typedef {{name: string, sampleRate: number, samples: number, durableSamples?: number}} RawInfo
 * @typedef {{segmentId: string, takeId: string, slideId: string, raw: string, start: number, end: number,
 *            startSec?: number, endSec?: number, rotationFrom?: {raw:string,end:number},
 *            status: 'kept'|'discarded'|'uncommitted', reason?: string, order: number|null}} Segment
 * @typedef {{takeId: string, slideId: string, status: 'open'|'closed', startSeq: number, endSeq: number|null,
 *            segments: string[], samples: number, candidate: boolean}} Take
 * @typedef {{code: string, seq?: number, message: string}} Issue
 * @typedef {{segments: Segment[], takes: Take[], defaultTakes: Record<string,string>,
 *            recoverable: {pos:number, raw:string, sample:number, lastCheckpointId:string|null}|null,
 *            marks: any[], issues: Issue[]}} ReduceResult
 * @typedef {{readJson(p:string):Promise<any|null>, writeJson(p:string,v:any):Promise<void>,
 *            exists(p:string):Promise<boolean>, list(prefix:string):Promise<string[]>,
 *            openWrite(p:string):Promise<{write(u8:Uint8Array):Promise<void>|void, close():Promise<void>|void}>,
 *            openRead(p:string):Promise<{size:number, read(start:number,end:number):Promise<Uint8Array>}>,
 *            remove(p:string):Promise<void>}} Store
 */
export {};
