// CLI の例外と終了コード（CONTRACTS.md 3.1）。
//   0 成功、1 処理の失敗、2 使い方の誤り、3 検証の不一致、4 人の判断が要る

export const EXIT = Object.freeze({ OK: 0, FAIL: 1, USAGE: 2, MISMATCH: 3, DECISION: 4 });

/** コマンドの失敗。`code` は errors[].code に出す。`exit` は終了コード、`detail` は errors[].detail に出す */
export class CliError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{exit?: number, detail?: any, result?: any}} [opts]
   */
  constructor(code, message, opts) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exit = opts && opts.exit !== undefined ? opts.exit : EXIT.FAIL;
    this.detail = opts ? opts.detail : undefined;
    this.result = opts ? opts.result : undefined;
  }
}

export const usageError = (message, detail) => new CliError('usage', message, { exit: EXIT.USAGE, detail });
export const mismatchError = (code, message, detail) => new CliError(code, message, { exit: EXIT.MISMATCH, detail });
