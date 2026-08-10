import type { Store } from '../core/store'
import type { Permission, Value, Op } from '../core/types'
import type { ToolDef, ParamDef } from '../config/tools'
import { globMatch } from '../core/glob'
import type { Desk } from '../cards/desk'

/** 统一返回契约。inputRequired 对齐 MCP 2026-07-28 的 MRTR */
export interface ToolResult {
  status: 'ok' | 'rejected' | 'inputRequired' | 'unavailable' | 'failed'
  data?: unknown
  changed?: string[]
  code?: string
  message?: string
  suggestion?: string
  /** MRTR 二次确认令牌 */
  token?: string
}

export interface InvokeCtx {
  confirmToken?: string
  /** Agent 的能力白名单，支持通配 */
  allow?: string[]
  /** 跳过确认（仅供控制面板手动触发使用） */
  force?: boolean
}

const compare = (a: any, op: Op, b: any) =>
  op === '>' ? a > b : op === '<' ? a < b : op === '>=' ? a >= b
  : op === '<=' ? a <= b : op === '==' ? a === b : a !== b

const CONFIRM_TTL = 60_000

export interface RegistryDeps { desk?: Desk }

export function createRegistry(
  store: Store,
  tools: ToolDef[],
  clock: () => number = Date.now,
  deps: RegistryDeps = {},
) {
  const byName = new Map(tools.map(t => [t.name, t]))
  const tokens = new Map<string, { tool: string; expires: number }>()
  let seq = 0

  /** 有真实逻辑的 Tool —— 具名 handler 白名单 */
  const handlers: Record<string, (args: any) => ToolResult> = {
    getState: args => {
      const snap = store.snapshot()
      if (!args?.paths?.length) return { status: 'ok', data: snap }
      const data: Record<string, Value> = {}
      for (const p of args.paths) if (p in snap) data[p] = snap[p]
      return { status: 'ok', data }
    },
    speak: args => ({ status: 'ok', data: { spoken: args.text }, message: args.text }),

    /* ── 卡片调度：把 desk 的结果翻译成统一返回契约 ── */
    cardShow: args => toResult(need().show({
      template: args.template, size: args.size, ttl: parseTtl(args.ttl),
      key: args.key, data: args.data, kind: args.kind,
    })),
    cardUpdate: args => toResult(need().update(args.cardId, args.data)),
    cardResize: args => toResult(need().resize(args.cardId, args.size)),
    cardDismiss: args => toResult(need().dismiss(args.cardId)),
    cardFocus: args => toResult(need().focus(args.cardId)),
    deskPin: args => toResult(need().pin(args.cardId)),
    deskUnpin: args => toResult(need().unpin(args.cardId)),
    deskLayout: () => {
      const l = need().layout()
      const brief = (c: any) => ({ id: c.id, key: c.key, template: c.template, size: c.size, title: c.data?.title ?? c.template })
      return {
        status: 'ok',
        data: {
          agent: l.agent.map(brief), fixed: l.fixed.map(brief),
          overlay: l.overlay ? brief(l.overlay) : null,
          agentFree: l.agentFree, fixedFree: l.fixedFree,
        },
      }
    },
  }

  const need = (): Desk => {
    if (!deps.desk) throw new Error('卡片能力未装配：createRegistry 缺少 desk')
    return deps.desk
  }
  /** ttl 在 schema 里是字符串（模型友好），这里转回内部类型 */
  const parseTtl = (v: any) => {
    if (v === undefined || v === null) return undefined
    const n = Number(v)
    return Number.isFinite(n) && String(v).trim() !== '' ? n : v
  }
  const toResult = (r: any): ToolResult =>
    r.status === 'ok'
      ? { status: 'ok', data: { cardId: r.cardId, ...(r.level && { level: r.level }) },
          ...(r.shrunk && { code: 'CARD_SHRUNK' }),
          ...(r.note && { message: r.note }) }
      : { status: 'rejected', code: r.code, message: r.message }

  const authorized = (name: string, allow?: string[]) =>
    !allow || allow.some(p => globMatch(p, name))

  /** 动态权限：基础等级 + escalate 规则 */
  function permissionOf(name: string): Permission | undefined {
    const t = byName.get(name)
    if (!t) return undefined
    let perm = t.permission
    for (const e of t.escalate ?? []) {
      const [path, op, val] = e.when
      if (compare(store.get(path), op, val)) perm = e.to
    }
    return perm
  }

  function validate(t: ToolDef, args: Record<string, any>): string | null {
    for (const [key, def] of Object.entries(t.params) as [string, ParamDef][]) {
      const v = args?.[key]
      if (v === undefined || v === null) {
        if (def.required) return `缺少必填参数 ${key}`
        continue
      }
      if (def.type === 'number') {
        if (typeof v !== 'number' || Number.isNaN(v)) return `${key} 需要数值`
        if (def.range && (v < def.range[0] || v > def.range[1]))
          return `${key} 需在 ${def.range[0]}~${def.range[1]} 之间`
      }
      if (def.type === 'enum' && !def.values?.includes(v)) return `${key} 不支持取值 ${v}`
      if (def.type === 'boolean' && typeof v !== 'boolean') return `${key} 需要布尔值`
      if (def.type === 'array' && !Array.isArray(v)) return `${key} 需要数组`
    }
    return null
  }

  /** 由 writes 声明自动生成的写入逻辑 */
  function applyWrites(t: ToolDef, args: Record<string, any>): ToolResult {
    const w = t.writes!
    // 参数展开：window=all → 四扇
    let variants: Record<string, any>[] = [args]
    for (const [key, table] of Object.entries(t.expand ?? {})) {
      const list = table[args[key]]
      if (list) variants = list.map(v => ({ ...args, [key]: v }))
    }

    const raw = args[w.from]
    const value: Value = w.map ? w.map[String(raw)] : raw

    const targets = variants.map(v =>
      w.path.replace(/\{(\w+)\}/g, (_, k) => String(v[k])))

    // 先全量试算（不写入）：任一被拒则整体拒绝，杜绝部分写入
    for (const path of targets) {
      const probe = store.canSet(path, value)
      if (probe.status !== 'ok') return probe as ToolResult
    }

    let code: string | undefined, message: string | undefined
    for (const path of targets) {
      const r = store.set(path, value)
      if (r.status === 'ok' && r.code) { code = r.code; message = r.message }
    }
    return { status: 'ok', changed: targets, ...(code && { code, message }) }
  }

  function invoke(name: string, args: Record<string, any> = {}, ctx: InvokeCtx = {}): ToolResult {
    const t = byName.get(name)
    if (!t) return { status: 'unavailable', code: 'UNKNOWN_TOOL', message: `没有名为 ${name} 的能力` }

    if (t.permission === '黑')
      return { status: 'unavailable', code: 'BLOCKED', message: `${name} 属于安全禁区，不对 AI 开放` }

    if (!authorized(name, ctx.allow))
      return { status: 'unavailable', code: 'NOT_AUTHORIZED', message: `当前 Agent 无权调用 ${name}` }

    const bad = validate(t, args)
    if (bad) return { status: 'rejected', code: 'INVALID_PARAMS', message: bad }

    // ── MRTR 二次确认 ──
    // token 既可由 ctx 传入（程序化调用），也可由模型作为 confirmToken 参数回传（标准 MRTR）
    // 空字符串按未提供处理：部分模型会主动补一个空的 confirmToken
    const supplied = ctx.confirmToken || (args.confirmToken as string | undefined) || undefined
    if (permissionOf(name) === '灰' && !ctx.force) {
      const tk = supplied && tokens.get(supplied)
      const valid = tk && tk.tool === name && tk.expires > clock()
      if (!valid) {
        const token = `ct_${(++seq).toString(36)}_${clock().toString(36)}`
        tokens.set(token, { tool: name, expires: clock() + CONFIRM_TTL })
        return {
          status: 'inputRequired', code: 'CONFIRM_REQUIRED',
          message: t.confirmPrompt ?? `即将执行 ${name}，确认吗？`,
          token,
        }
      }
      tokens.delete(supplied!) // 一次性
    }

    try {
      if (t.writes) return applyWrites(t, args)
      const h = t.handler && handlers[t.handler]
      if (h) return h(args)
      return { status: 'failed', code: 'NO_HANDLER', message: `${name} 尚未实现` }
    } catch (e) {
      return { status: 'failed', code: 'HANDLER_ERROR', message: String(e) }
    }
  }

  const list = (allow?: string[]) =>
    tools.filter(t => t.permission !== '黑' && authorized(t.name, allow))

  const jsonType = (d: ParamDef) =>
    d.type === 'enum' ? 'string' : d.type === 'array' ? 'array' : d.type

  function schemas(format: 'openai' | 'anthropic' | 'mcp' = 'openai', allow?: string[]): any[] {
    return list(allow).map(t => {
      const properties: Record<string, any> = {}
      const required: string[] = []
      for (const [k, d] of Object.entries(t.params)) {
        properties[k] = { type: jsonType(d), description: d.desc }
        if (d.values) properties[k].enum = d.values
        if (d.items) properties[k].items = { type: d.items }
        if (d.required) required.push(k)
      }
      // 可能需要二次确认的 Tool，把 MRTR 令牌作为显式参数暴露给模型，
      // 这样运行时不需要判断"用户是否在确认" —— 保持代码零意图分支
      if (t.permission === '灰' || t.escalate?.some(e => e.to === '灰'))
        properties.confirmToken = {
          type: 'string',
          description: '二次确认令牌。首次调用不要传；若返回 CONFIRM_REQUIRED，在用户明确同意后用返回的 token 再次调用本工具。',
        }
      const parameters = { type: 'object', properties, required }
      if (format === 'openai')
        return { type: 'function', function: { name: t.name, description: t.desc, parameters } }
      if (format === 'anthropic')
        return { name: t.name, description: t.desc, input_schema: parameters }
      return { name: t.name, description: t.desc, inputSchema: parameters }
    })
  }

  return { list, schemas, invoke, permissionOf, tools }
}

export type Registry = ReturnType<typeof createRegistry>
