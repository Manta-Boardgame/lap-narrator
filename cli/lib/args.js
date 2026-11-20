// 引数の読み取り。依存なし。`--name value`、`--name=value`、真偽の `--flag`、`--` 以降は位置引数。
import { usageError } from './errors.js';

/** すべてのコマンドで使える引数 */
export const GLOBAL_OPTIONS = Object.freeze({ workspace: 'string', json: 'boolean', help: 'boolean' });

/**
 * @param {string[]} argv コマンド名を除いた引数
 * @param {Record<string,'string'|'boolean'|'list'>} options コマンド固有の引数（'list' は繰り返せる文字列）
 * @returns {{opts: Record<string, any>, positionals: string[]}}
 */
export function parseArgs(argv, options) {
  const spec = { ...GLOBAL_OPTIONS, ...options };
  const opts = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (!tok.startsWith('--')) { positionals.push(tok); continue; }
    let name = tok.slice(2);
    let inline;
    const eq = name.indexOf('=');
    if (eq >= 0) { inline = name.slice(eq + 1); name = name.slice(0, eq); }
    const kind = Object.prototype.hasOwnProperty.call(spec, name) ? spec[name] : undefined;
    if (!kind) throw usageError(`unknown option --${name}`, { option: name });
    if (kind === 'boolean') {
      if (inline !== undefined) {
        if (inline !== 'true' && inline !== 'false') throw usageError(`--${name} takes no value`, { option: name });
        opts[name] = inline === 'true';
      } else opts[name] = true;
      continue;
    }
    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw usageError(`--${name} needs a value`, { option: name });
      value = next;
      i++;
    }
    if (kind === 'list') (opts[name] = opts[name] || []).push(value);
    else opts[name] = value;
  }
  return { opts, positionals };
}

/** 整数の引数。誤りは使い方の誤り */
export function intOption(opts, name, def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (opts[name] === undefined) return def;
  const s = String(opts[name]);
  if (!/^-?\d+$/.test(s)) throw usageError(`--${name} must be an integer`, { option: name, value: s });
  const n = Number(s);
  if (n < min || n > max) throw usageError(`--${name} must be between ${min} and ${max}`, { option: name, value: s });
  return n;
}

export function requireOption(opts, name) {
  if (opts[name] === undefined) throw usageError(`--${name} is required`, { option: name });
  return opts[name];
}
