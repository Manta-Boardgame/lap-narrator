// 出力の道具。標準出力には最後に 1 つの JSON（封筒）だけを出し、進み具合は標準エラー出力に 1 行 1 JSON で出す（CONTRACTS.md 3.1）。

/**
 * @param {{stderr: {write:(s:string)=>any}}} io
 * @param {string} command
 */
export function createContext(io, command) {
  const warnings = [];
  return {
    command,
    warnings,
    /** 進み具合：{"progress":{"stage","done","total"}} */
    progress(stage, done, total) {
      io.stderr.write(JSON.stringify({ progress: { stage, done, total } }) + '\n');
    },
    warn(code, message, detail) {
      warnings.push(detail === undefined ? { code, message } : { code, message, detail });
    },
  };
}

/** 封筒（schema/cli-result）。`result` が undefined なら入れない */
export function envelope({ ok, command, result, warnings, errors }) {
  const env = { ok, command };
  if (result !== undefined) env.result = result;
  env.warnings = warnings || [];
  env.errors = errors || [];
  return env;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const secOf = (samples, rate) => Math.round((samples / rate) * 1000) / 1000;
export const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
