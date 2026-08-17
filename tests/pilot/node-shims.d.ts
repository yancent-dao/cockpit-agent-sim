/**
 * pilot 跑批器跑在 Node 里，需要 fs / process 的类型。
 * 按 工程手册 的规矩：不为这点类型引入 @types/node（会破坏"只有 3 个 devDependency"），
 * 自己声明用到的那几个就够了。
 */
declare module 'node:fs' {
  export function writeFileSync(path: string, data: string): void
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void
  export function existsSync(path: string): boolean
}

declare const process: {
  env: Record<string, string | undefined>
  argv: string[]
  exit(code?: number): never
}
