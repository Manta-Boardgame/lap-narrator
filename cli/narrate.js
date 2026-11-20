#!/usr/bin/env node
// narrate：lap-narrator の CLI（設計書 5.1、9、CONTRACTS.md 3 章）。依存は node の標準ライブラリと core/ だけ。
//
//   node cli/narrate.js <command> [options] --workspace <dir> [--json]
//
// 標準出力には 1 つの JSON だけ：{ok, command, result, warnings, errors}（schema/cli-result.schema.json）。--json がなくても同じ。
// 進み具合は標準エラー出力に 1 行 1 JSON：{"progress":{"stage","done","total"}}。人に質問しない。
// 終了コード：0 成功、1 処理の失敗、2 使い方の誤り、3 検証の不一致、4 人の判断が要る。
//
// コマンド：pack、import、status、select、render、split-takes、validate、build、verify（`narrate --help` で一覧）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/args.js';
import { CliError, EXIT } from './lib/errors.js';
import { createContext, envelope } from './lib/output.js';
import { StoreError } from './lib/store.js';

const COMMANDS = {
  pack: () => import('./cmd/pack.js'),
  import: () => import('./cmd/import.js'),
  status: () => import('./cmd/status.js'),
  select: () => import('./cmd/select.js'),
  render: () => import('./cmd/render.js'),
  'split-takes': () => import('./cmd/split-takes.js'),
  validate: () => import('./cmd/validate.js'),
  build: () => import('./cmd/build.js'),
  verify: () => import('./cmd/verify.js'),
  transcribe: () => import('./cmd/transcribe.js'),
  align: () => import('./cmd/align.js'),
  boundary: () => import('./cmd/boundary.js'),
};

export const USAGE = {
  pack: 'pack (--from-json <dir> | --from-markdown <file> --images <dir> | --from-pptx <pptx>) --out <script-pack.zip> [--project-id <id>] [--title <t>]',
  import: 'import (<zip|*_index.json|folder>... | --audio <mono-PCM.wav>) --workspace <dir> [--script <script-pack.zip>]',
  status: 'status --workspace <dir>',
  select: 'select --slide <id> --session <id> --take <id> [--export <id>] --workspace <dir>   (or --slide <id> --clear)',
  render: 'render --workspace <dir> [--out <dir>] [--allow-missing] [--boundaries <boundaries.json>] [--allow-unconfirmed] [--no-boundaries] [--tail-margin-ms 100] [--lead-in-sec 4] [--lead-keep-ms 250] [--target-lufs -16] [--ceiling-db -1.5] [--lookahead-limiter]   (a continuous recording is cut at the boundaries; --allow-missing applies to per-slide recordings)',
  'split-takes': 'split-takes --session <id> --out <dir> --workspace <dir>',
  validate: 'validate <file.json|file.jsonl|zip|folder> [--schema <name>]',
  build: 'build --method B|A --workspace <dir> [--out <dir>] [--timeline <json>] [--allow-missing]   (timeline: --timeline, else <out>/timeline.json, else <ws>/out/timeline.json) [--pptx <pptx> --mode both|linked|embedded --grid-ms 33]',
  transcribe: 'transcribe (--audio <wav> | --workspace <dir> [--audio-name final/all.wav]) [--model small] [--models-dir <dir>] [--out transcript.json] [--vad on|off] [--force]   (faster-whisper; needs the model under models/, never downloads)',
  align: 'align --workspace <dir> [--transcript <transcript.json>] [--script <script-pack.zip|script.json>] [--audio <wav>] [--threshold 0.8] [--force]   (writes <ws>/boundaries.json; exit 4 when a boundary needs a decision)',
  boundary: 'boundary show --workspace <dir> | boundary review --workspace <dir> [--out review.md|review.json] [--format md|json] [--context-sec 15] [--max-chars 450] [--script <script.json>] [--transcript <transcript.json>] | boundary set --slide <id> (--at <sec> | --at-text "<phrase>" | --before-text "<phrase>" [--nth N]) [--exact] --workspace <dir> | boundary confirm --slide <id> --workspace <dir>',
  verify: 'verify --workspace <dir> [--out <build-out-dir>] [--allow-unmeasurable] [--report <file.json>]   (or --video <mp4> --timeline <json> [--method A|B])',
};

export const WORKFLOW = 'pack -> (record straight through on the phone, OK and retake only) -> import -> status -> transcribe -> align -> [boundary show/set/confirm while align exits 4] -> render -> build -> verify';
export const WORKFLOW_LEGACY = 'per-slide recording (next-slide pressed while recording): pack -> (record) -> import -> status -> [select while exit 4] -> render --no-boundaries -> build -> verify';

// 各コマンドの既定の出力先（<ws> は --workspace）
export const DEFAULT_OUTPUTS = {
  pack: 'the --out zip',
  import: '<ws>/sessions/<sessionId>/, <ws>/script.json, <ws>/slides/, and <ws>/final/all.wav for a continuous recording',
  status: 'stdout only (nothing is written)',
  select: '<ws>/selections.json',
  render: '<ws>/out/final/<slideId>.wav, <ws>/out/timeline.json, <ws>/out/slides/*.png',
  'split-takes': 'the --out folder',
  validate: 'stdout only',
  build: '<ws>/out/video.mp4 (+ build-report.json); the place is also saved in <ws>/last-build.json',
  transcribe: '<ws>/transcript.json (reused when the audio SHA-256 and the model are the same)',
  align: '<ws>/boundaries.json',
  boundary: '<ws>/boundaries.json (set / confirm); show writes nothing; review writes only with --out',
  verify: 'stdout only (a file only with --report <file.json>); reads <ws>/last-build.json, else <ws>/out/',
};

/**
 * コマンドを実行して、封筒と終了コードを返す（試験ではこれを直接呼ぶ）。
 * @param {string[]} argv @param {{stdout:{write:(s:string)=>any}, stderr:{write:(s:string)=>any}}} io
 * @returns {Promise<{exitCode:number, envelope:any}>}
 */
export async function runCli(argv, io) {
  const [command, ...rest] = argv;
  const finish = (env, exitCode) => {
    io.stdout.write(JSON.stringify(env) + '\n');
    return { exitCode, envelope: env };
  };
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    const ok = command !== undefined;
    return finish(envelope({
      ok, command: '', result: { usage: USAGE, workflow: WORKFLOW, workflowLegacy: WORKFLOW_LEGACY, defaultOutputs: DEFAULT_OUTPUTS, exitCodes: { 0: 'ok', 1: 'failed', 2: 'usage error', 3: 'validation mismatch (verify: out of tolerance or unmeasurable)', 4: 'a decision is needed (align/render: boundary set or confirm; per-slide recordings: select)' } },
      errors: ok ? [] : [{ code: 'usage', message: 'a command is required' }],
    }), ok ? EXIT.OK : EXIT.USAGE);
  }
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, command)) {
    return finish(envelope({ ok: false, command, errors: [{ code: 'usage', message: `unknown command ${JSON.stringify(command)}`, detail: { commands: Object.keys(COMMANDS) } }] }), EXIT.USAGE);
  }
  const ctx = createContext(io, command);
  try {
    const mod = await COMMANDS[command]();
    const { opts, positionals } = parseArgs(rest, mod.options || {});
    if (opts.help) return finish(envelope({ ok: true, command, result: { usage: USAGE[command] } }), EXIT.OK);
    const workspace = opts.workspace ? path.resolve(opts.workspace) : null;
    const r = await mod.run({ ctx, opts, positionals, workspace });
    const errors = r.errors || [];
    const exit = r.exit !== undefined ? r.exit : (errors.length ? EXIT.FAIL : EXIT.OK);
    return finish(envelope({ ok: errors.length === 0 && exit === EXIT.OK, command, result: r.result, warnings: ctx.warnings, errors }), exit);
  } catch (e) {
    if (e instanceof CliError) {
      const err = { code: e.code, message: e.message, ...(e.detail !== undefined ? { detail: e.detail } : {}) };
      return finish(envelope({ ok: false, command, result: e.result, warnings: ctx.warnings, errors: [err] }), e.exit);
    }
    if (e instanceof StoreError) return finish(envelope({ ok: false, command, warnings: ctx.warnings, errors: [{ code: e.code, message: e.message }] }), EXIT.FAIL);
    if (e && e.name === 'ImportError') return finish(envelope({ ok: false, command, warnings: ctx.warnings, errors: [{ code: e.code, message: e.message, ...(e.detail ? { detail: e.detail } : {}) }] }), EXIT.FAIL);
    const msg = e && e.message ? e.message : String(e);
    return finish(envelope({ ok: false, command, warnings: ctx.warnings, errors: [{ code: 'internal-error', message: msg, detail: { stack: String(e && e.stack ? e.stack : '').split('\n').slice(0, 6) } }] }), EXIT.FAIL);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr }).then(({ exitCode }) => {
    process.exitCode = exitCode;
  });
}
