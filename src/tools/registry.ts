import type { Store } from '../core/store'
import type { Permission, Value, Op } from '../core/types'
import type { ToolDef, ParamDef } from '../config/tools'
import { globMatch } from '../core/glob'
import type { Desk } from '../cards/desk'
import { CARD_TEMPLATES, COMMON_SIZES, type CardTemplate } from '../config/cards'
import type { AmapClient } from '../integrations/amap'
import type { ItunesClient } from '../integrations/itunes'
import type { RadioClient } from '../integrations/radio'
import type { NewsClient } from '../integrations/news'
import type { PexelsClient } from '../integrations/pexels'
import { createNavHandlers } from '../integrations/navHandlers'
import { createMediaHandlers } from '../integrations/mediaHandlers'

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

export interface RegistryDeps { desk?: Desk; amap?: AmapClient; itunes?: ItunesClient; radio?: RadioClient; news?: NewsClient; pexels?: PexelsClient }

export function createRegistry(
  store: Store,
  tools: ToolDef[],
  clock: () => number = Date.now,
  deps: RegistryDeps = {},
) {
  const byName = new Map(tools.map(t => [t.name, t]))
  const tokens = new Map<string, { tool: string; expires: number }>()
  let seq = 0

  /**
   * 有真实逻辑的 Tool —— 具名 handler 白名单。
   * 允许返回 Promise：接三方真实 API（如高德）本质是网络请求，不能假装同步。
   */
  const handlers: Record<string, (args: any) => ToolResult | Promise<ToolResult>> = {
    getState: args => {
      const snap = store.snapshot()
      if (!args?.paths?.length) return { status: 'ok', data: snap }
      const data: Record<string, Value> = {}
      for (const p of args.paths) if (p in snap) data[p] = snap[p]
      return { status: 'ok', data }
    },
    speak: args => ({ status: 'ok', data: { spoken: args.text }, message: args.text }),
    ask: args => {
      // 问句同步上屏——显示是机制，模型只负责把问题念出来。
      // 但候选列表卡已经在场时（如导航搜索多结果）屏幕上不用再动：
      // 选项在列表里摆着，模型的问句常是一整段，塞进标题反而挤掉列表。
      const candidates = deps.desk?.findByKey('nav-candidates')
      if (candidates) { /* 屏幕已经在展示候选，不再开卡也不改标题 */ }
      // ttl 用 untilTaskEnd 而非秒数：用户下一句一开口，这问题要么被回答要么被跳过，
      // 卡片就该走。挂满 60 秒是白占位置。
      else autoCard({ key: 'ask', template: 'confirm', size: '1/3', kind: 'system', ttl: 'untilTaskEnd',
        data: { title: '请选择', question: args.question, options: args.options ?? [] } })
      return { status: 'ok', data: { asked: args.question, options: args.options }, message: args.question }
    },

    /* ── 能力目录：直接读 list()，能力增减自动同步，不允许手写 ── */
    capabilityList: args => {
      const items = list()
        .filter(t => !args?.domain || t.name.startsWith(`${args.domain}.`))
        .map(t => ({
          label: t.name,
          desc: t.desc,
          off: t.requires ? store.signals.find(s => s.alias === t.requires)?.equipped === false : false,
        }))
      autoCard({ key: 'capabilities', template: 'capability', size: 'full', kind: 'task', ttl: 60,
        data: { title: '我能做的事', items } })
      return { status: 'ok', data: { items } }
    },

    /* ── 卡片调度：把 desk 的结果翻译成统一返回契约 ── */
    cardShow: args => {
      const tmpl = CARD_TEMPLATES.find(t => t.id === args.template)
      if (tmpl?.systemOnly)
        return {
          status: 'rejected', code: 'SYSTEM_TEMPLATE',
          message: `${tmpl.label}由系统按车辆状态自动出，不用你建`,
          suggestion: '需要的话调对应的业务工具（如 navigation.setDestination），卡片会自己出现',
        }
      const sizeErr = tmpl && checkSize(tmpl, args.size)
      if (sizeErr) return sizeErr
      const shapeErr = tmpl && checkDataShape(tmpl, args.data ?? {}, { partial: false })
      if (shapeErr) return shapeErr
      return toResult(need().show({
        template: args.template, size: args.size, ttl: parseTtl(args.ttl),
        key: args.key, data: args.data, kind: args.kind,
      }))
    },
    cardUpdate: args => {
      const card = need().get(args.cardId)
      const tmpl = card && CARD_TEMPLATES.find(t => t.id === card.template)
      const shapeErr = tmpl && checkDataShape(tmpl, args.data ?? {}, { partial: true })
      if (shapeErr) return shapeErr
      return toResult(need().update(args.cardId, args.data))
    },
    cardResize: args => {
      // 模板声明的尺寸这里也得认。之前只有 cardShow 校验，于是"地图小一点"
      // 把只支持 2/3 的导航卡缩成了 1/3，再也调不回去
      const card = need().get(args.cardId)
      const tmpl = card && CARD_TEMPLATES.find(t => t.id === card.template)
      const sizeErr = tmpl && checkSize(tmpl, args.size)
      if (sizeErr) return sizeErr
      return toResult(need().resize(args.cardId, args.size))
    },
    cardDismiss: args => toResult(need().dismiss(args.cardId)),
    cardFocus: args => toResult(need().focus(args.cardId)),
    deskLayout: () => {
      const l = need().layout()
      const brief = (c: any) => ({ id: c.id, key: c.key, template: c.template, size: c.size,
        title: c.data?.title ?? CARD_TEMPLATES.find(t => t.id === c.template)?.label ?? c.template })
      return {
        status: 'ok',
        data: {
          cards: l.cards.map(brief),
          overlay: l.overlay ? brief(l.overlay) : null,
          free: l.free,
        },
      }
    },

    /* ── 导航 + 天气：真实逻辑在 navHandlers.ts，这里只是并进同一张白名单 ── */
    ...createNavHandlers(store, () => needAmap(), () => sizedDesk()),
    ...createMediaHandlers(store, () => sizedDesk(), { itunes: () => needCp('itunes'), radio: () => needCp('radio'), news: () => needCp('news'), pexels: () => needCp('pexels') }),
  }

  /**
   * 模板已经声明了自己支持哪些尺寸，其中最小的那个就是显示下限——
   * 列表卡缩到 1/6 只剩个标题、选项全丢。统一在这补，不让每个建卡的地方手写。
   */
  const sizedDesk = (): Desk | undefined => {
    const d = deps.desk
    if (!d) return undefined
    return {
      ...d,
      render: (input: Parameters<Desk['render']>[0]) => {
        if (input.minSize) return d.render(input)
        const tmpl = CARD_TEMPLATES.find(t => t.id === input.template)
        const sizes = tmpl ? (tmpl.sizes ?? COMMON_SIZES) : []
        const min = [...sizes].sort((a, b) => d.cellsOf(a as any) - d.cellsOf(b as any))[0]
        return d.render(min ? { ...input, minSize: min as any } : input)
      },
    } as Desk
  }

  const need = (): Desk => {
    if (!deps.desk) throw new Error('卡片能力未装配：createRegistry 缺少 desk')
    return deps.desk
  }
  /** 查询/交互结果自动上屏。desk 未装配或桌面满都不影响 Tool 主流程 */
  const autoCard = (input: Parameters<Desk['render']>[0]) => {
    try { sizedDesk()?.render(input) } catch { /* 显示失败不拖累执行 */ }
  }
  /** 三方能力未装配时给一句人话，而不是让 undefined 一路炸到堆栈里 */
  const needCp = <K extends 'itunes' | 'radio' | 'news' | 'pexels'>(k: K): NonNullable<RegistryDeps[K]> => {
    const c = deps[k]
    if (!c) throw new Error(`${k} 能力未装配：createRegistry 缺少 ${k}`)
    return c
  }
  const needAmap = (): AmapClient => {
    if (!deps.amap) throw new Error('高德能力未装配：createRegistry 缺少 amap')
    return deps.amap
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

  /**
   * 模板只允许它声明过的形状。show 和 resize 共用一份，别再漏一处。
   * 不声明 sizes 就是通用池——白名单窄一分，桌面的几何死角就多一分。
   */
  const checkSize = (tmpl: CardTemplate, size: string): ToolResult | null => {
    const allowed = tmpl.sizes ?? COMMON_SIZES
    return allowed.includes(size as any) ? null : {
      status: 'rejected', code: 'SIZE_NOT_SUPPORTED',
      message: `${tmpl.label}不支持 ${size} 尺寸，支持：${allowed.join('、')}`,
    }
  }

  /**
   * 校验 data 是否匹配模板声明的 fields。没声明 fields（如 generic）就放行。
   * partial=true（card.update，局部更新）只查"传了的字段类型对不对"，不强制补全必填；
   * partial=false（card.show，首次创建）必填字段必须都在。
   * 跟 SIZE_NOT_SUPPORTED 一个思路：格式不对也要给可读原因，不能让它悄悄渲染成空白。
   */
  const checkDataShape = (tmpl: CardTemplate, data: Record<string, any>, opts: { partial: boolean }): ToolResult | null => {
    if (!tmpl.fields) return null
    const isType = (v: any, t: string) =>
      t === 'array' ? Array.isArray(v) : t === 'object' ? (typeof v === 'object' && v !== null && !Array.isArray(v)) : typeof v === t
    for (const [key, spec] of Object.entries(tmpl.fields)) {
      const v = data[key]
      if (v === undefined || v === null) {
        if (spec.required && !opts.partial)
          return {
            status: 'rejected', code: 'DATA_SHAPE_MISMATCH',
            message: `${tmpl.label}缺少必填字段 data.${key}（类型应为 ${spec.type}）`,
          }
        continue
      }
      if (!isType(v, spec.type))
        return {
          status: 'rejected', code: 'DATA_SHAPE_MISMATCH',
          message: `${tmpl.label}的 data.${key} 类型不对，应为 ${spec.type}`,
        }
    }
    return null
  }

  const authorized = (name: string, allow?: string[]) =>
    !allow || allow.some(p => globMatch(p, name))

  /**
   * Tool 名对内是点分层级（window.set），对外（LLM 看到的 schema）必须是
   * wire-safe 形式——Anthropic 的 tool.name 校验正则 `^[a-zA-Z0-9_-]{1,128}$`
   * 不接受点号，会直接 400。这里只做点号↔下划线的可逆替换，不改内部命名。
   */
  const wireName = (name: string) => name.replace(/\./g, '_')
  const resolve = (name: string): ToolDef | undefined =>
    byName.get(name) ?? byName.get(name.replace(/_/g, '.'))
  /** 把 provider 可能返回的 wire 形式统一转回内部点号形式，供追踪面板显示 */
  const canonicalName = (name: string) => resolve(name)?.name ?? name

  /** 动态权限：基础等级 + escalate 规则 */
  function permissionOf(name: string): Permission | undefined {
    const t = resolve(name)
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

  /**
   * 由 writes 声明自动生成的写入逻辑。
   * writes 是数组：climate.set 这类 Tool 一次调用要写多个不同信号，
   * 每条目独立判断对应的 from 字段本次有没有传——没传就跳过，不是必填。
   */
  function applyWrites(t: ToolDef, args: Record<string, any>): ToolResult {
    const jobs: Array<{ path: string; value: Value }> = []

    for (const w of t.writes!) {
      const raw = args[w.from]
      if (raw === undefined || raw === null) continue // 可选字段这次没传，跳过

      // 参数展开：window=all → 四扇。只在路径模板真的用到该占位符时才展开
      let variants: Record<string, any>[] = [args]
      for (const [key, table] of Object.entries(t.expand ?? {})) {
        if (!w.path.includes(`{${key}}`)) continue
        const list = table[args[key]]
        if (list) variants = list.map(v => ({ ...args, [key]: v }))
      }

      const value: Value = w.map ? w.map[String(raw)] : raw
      for (const v of variants)
        jobs.push({ path: w.path.replace(/\{(\w+)\}/g, (_, k) => String(v[k])), value })
    }

    if (!jobs.length)
      return { status: 'rejected', code: 'NO_FIELDS', message: '至少要传一个要修改的字段' }

    // 先全量试算（不写入）：任一被拒则整体拒绝，杜绝部分写入
    for (const { path, value } of jobs) {
      const probe = store.canSet(path, value)
      if (probe.status !== 'ok') return probe as ToolResult
    }

    let code: string | undefined, message: string | undefined
    const changed: string[] = []
    for (const { path, value } of jobs) {
      const r = store.set(path, value)
      changed.push(path)
      if (r.status === 'ok' && r.code) { code = r.code; message = r.message }
    }
    return { status: 'ok', changed, ...(code && { code, message }) }
  }

  async function invoke(name: string, args: Record<string, any> = {}, ctx: InvokeCtx = {}): Promise<ToolResult> {
    const t = resolve(name)
    if (!t) return { status: 'unavailable', code: 'UNKNOWN_TOOL', message: `没有名为 ${name} 的能力` }
    name = t.name // 归一化成内部点号形式：鉴权白名单、token 绑定都按这个来

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
        const message = t.confirmPrompt ?? `即将执行 ${name}，确认吗？`
        // 确认卡自动上屏（需求书 §4.5 P0 模板）——用户在屏上能看到自己在确认什么。
        // ttl 用 untilTaskEnd：Agent 可能看完 message 直接决定拒绝（行驶中开门就是），
        // 那这张卡就是孤儿，语音在说"不行"、屏幕在问"确认吗"。用户下一句一开口就该散
        autoCard({ key: 'confirm', template: 'confirm', size: '1/3', kind: 'system',
          ttl: 'untilTaskEnd',
          data: { title: '需要确认', question: message, options: ['确认', '取消'] } })
        return { status: 'inputRequired', code: 'CONFIRM_REQUIRED', message, token }
      }
      tokens.delete(supplied!) // 一次性
      // 确认完成，确认卡使命结束
      const c = deps.desk?.findByKey('confirm')
      if (c) deps.desk!.dismiss(c.id)
    }

    try {
      if (t.writes) return applyWrites(t, args)
      const h = t.handler && handlers[t.handler]
      if (h) return await h(args)
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
      const name = wireName(t.name)
      if (format === 'openai')
        return { type: 'function', function: { name, description: t.desc, parameters } }
      if (format === 'anthropic')
        return { name, description: t.desc, input_schema: parameters }
      return { name, description: t.desc, inputSchema: parameters }
    })
  }

  return { list, schemas, invoke, permissionOf, canonicalName, tools }
}

export type Registry = ReturnType<typeof createRegistry>
