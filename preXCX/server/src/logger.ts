export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  /** 合规留痕（内容安全命中、导出等关键事件）。 */
  audit(event: string, data?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  info: (event, data) => console.log(JSON.stringify({ level: 'info', event, ...data })),
  warn: (event, data) => console.warn(JSON.stringify({ level: 'warn', event, ...data })),
  audit: (event, data) => console.log(JSON.stringify({ level: 'audit', event, ...data })),
};
