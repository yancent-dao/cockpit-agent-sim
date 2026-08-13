import type { Store } from '../core/store'
import type { Registry, ToolResult } from '../tools/registry'
import type { LLM, Msg } from './llm'
import type { AgentManifest } from '../../agents/main-agent/manifest'
import { buildSystemPrompt } from './context'

export type TraceStep =
  | { type: 'userInput'; at: number; text: string }
  | { type: 'prompt'; at: number; system: string; toolCount: number }
  | { type: 'toolCall'; at: number; name: string; args: any; permission?: string }
  | { type: 'toolResult'; at: number; name: string; result: ToolResult; ms: number }
  | { type: 'reply'; at: number; text: string }
  | { type: 'error'; at: number; message: string }

/**
 * 过滤器架构（设计文档 v2.7 §2-§5）：快层小模型先斩后奏，慢层大模型校验接力。
 *
 * 机制归代码，决策归模型：这里只有——两段循环、共享 thread、转交拼装、
 * 世代戳、工具装载的搬运。做不做、对不对、要不要开口，全在模型的输出里。
 */

export type PipelineEvent =
  | { type: 'thinking' }
  | { type: 'executing'; name: string }
  | { type: 'speaking'; text: string; layer: 'fast' | 'slow' }
  | { type: 'confirming'; text: string }
  | { type: 'rejected'; text: string }
  /** 旧 turn 的慢层迟到话术：不抢麦，降级给横幅（§4.1） */
  | { type: 'lateNote'; text: string }
  /** 后台任务池变化（新建/完成/取消）——UI 拿 tasks() 刷任务芯片 */
  | { type: 'taskUpdate' }
  /** 后台任务完成：机械交付素材（播报 summary + 横幅），不叫醒主模型 */
  | { type: 'taskDone'; taskId: string; summary: string; ok: boolean }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface BgTask {
  id: string
  label: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  summary?: string
}

export interface PipelineDeps {
  registry: Registry
  store: Store
  fastLlm: LLM
  slowLlm: LLM
  fastManifest: AgentManifest
  slowManifest: AgentManifest
  clock?: () => number
  desktopSummary?: () => string
  prefsList?: () => string[]
  recentSummary?: () => string
  onTurnStart?: () => void
  /** "上回说到"的落盘口（localStorage 由装配方给）。缺省 = 不跨会话 */
  memory?: { load(): string | null; save(text: string): void }
}

export interface TurnResult {
  reply: string
  trace: TraceStep[]
  rounds: number
  stopReason: 'reply' | 'maxRounds' | 'error' | 'empty'
}

/* 元工具：装载管道，不进 TOOLS（那是业务能力表）。schema 由这里注入，调用由这里拦截 */
const HANDOFF_SCHEMA = {
  type: 'function', function: {
    name: 'agent_handoff',
    description: '收尾时勾选：把后续工作可能用到的工具名（从工具目录里挑）转交给大模型同事预载。没有就不调。',
    parameters: {
      type: 'object',
      properties: { suggestedTools: { type: 'array', items: { type: 'string' }, description: '工具名列表，如 ["navigation.search"]' } },
    },
  },
}
const LOAD_SCHEMA = {
  type: 'function', function: {
    name: 'tools_load',
    description: '把工具目录里的能力装进手边（下一轮获得完整 schema）。要用目录里的工具但它不在当前工具列表时先调这个。',
    parameters: {
      type: 'object', required: ['names'],
      properties: { names: { type: 'array', items: { type: 'string' }, description: '要装载的工具名列表' } },
    },
  },
}
const DELEGATE_SCHEMA = {
  type: 'function', function: {
    name: 'task_delegate',
    description: '把一个独立子任务委托给子 Agent 执行。多个互不依赖的重活（调研/搜集/报告）在**同一轮里连发多个** delegate 即并行。background=true 时立即返回 taskId 后台跑，完成后系统自动通知用户（你先答"我去查着"即可）；否则等结果回来你自己汇总。',
    parameters: {
      type: 'object', required: ['goal'],
      properties: {
        goal: { type: 'string', description: '子任务目标，一句话说清要什么结论' },
        tools: { type: 'array', items: { type: 'string' }, description: '给子 Agent 点的装备（工具目录里的名字）。不点它自己按目录取' },
        background: { type: 'boolean', description: '耗时长的活转后台，完成自动通知' },
      },
    },
  },
}
const CANCEL_SCHEMA = {
  type: 'function', function: {
    name: 'task_cancel',
    description: '取消一个还在跑的后台任务。用户说"别查了/不用了"或点了任务卡上的取消时调。',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string', description: '任务 id（task_N）；不知道 id 可给 label 关键词' },
                    label: { type: 'string', description: '按任务名关键词匹配' } },
    },
  },
}
const SKILL_SCHEMA = {
  type: 'function', function: {
    name: 'skill_use',
    description: '取一个技能的剧本正文（见技能目录）。有剧本的活先取剧本再动手，照章执行。',
    parameters: {
      type: 'object', required: ['name'],
      properties: { name: { type: 'string', description: '技能名，来自技能目录' } },
    },
  },
}
const isMeta = (name: string, meta: string) => name === meta || name === meta.replace(/\./g, '_')

/** epoch 摘要消息的识别标 */
const SUM_MARK = '【前情摘要】'
/** 滑动窗口：最近 K 轮全文，更早的折叠进摘要 */
const KEEP_ROUNDS = 4
const COMPACT_PROMPT = `你是座舱对话的记忆压缩器。把给你的**较早对话**压成前情摘要：
- 不超过 10 行，只写结论与未完成的事（谁要了什么、办到哪一步、定了什么偏好）
- 最后一行固定写「提到过：xxx、yyy」——列出出现过的地名/人名/歌名/店名，
  这是检索索引：用户以后说"刚才那个加油站"要靠它找锚点
- 只输出摘要正文，不解释`

export function createPipeline(deps: PipelineDeps) {
  const { registry, store, clock = Date.now } = deps
  const listeners: Array<(e: PipelineEvent) => void> = []
  const emit = (e: PipelineEvent) => listeners.forEach(l => l(e))
  const on = (cb: (e: PipelineEvent) => void) => {
    listeners.push(cb)
    return () => listeners.splice(listeners.indexOf(cb), 1)
  }

  /** 共享 thread：两层共写的单一事实。llm 各看各的快照视图，落笔都在这 */
  const thread: Msg[] = []
  let gen = 0
  /** 最新 turn 的用户消息位置：旧代慢层的迟到消息插它前面——时间线不交错（§4.1） */
  let boundary = 0
  let toolRound = 0
  // 上回说到：跨会话留一行，"接着昨天那个路线"接得上（§7.5）
  const lastTime = deps.memory?.load()
  if (lastTime) thread.push({ role: 'assistant', content: `${SUM_MARK}上回说到：${lastTime}` })

  const stale = (g: number) => g !== gen
  /** 落 thread：当前代直接追加；旧代插到最新 turn 的用户输入之前 */
  const commit = (g: number, ...msgs: Msg[]) => {
    if (!stale(g)) thread.push(...msgs)
    else { thread.splice(boundary, 0, ...msgs); boundary += msgs.length }
  }

  /** 执行一轮 tool calls（元工具由 interceptors 拦，业务走 registry）。返回 tool 消息 */
  async function execRound(
    g: number, calls: NonNullable<Awaited<ReturnType<LLM['chat']>>['toolCalls']>,
    allow: string[], trace: TraceStep[],
    interceptors: Record<string, (args: any) => ToolResult | Promise<ToolResult>>,
    opts: { quietRejects?: boolean } = {},
  ): Promise<Msg[]> {
    const round = ++toolRound
    const results = await Promise.all(calls.map(async c => {
      const metaKey = Object.keys(interceptors).find(k => isMeta(c.name, k))
      const name = metaKey ?? registry.canonicalName(c.name)
      trace.push({ type: 'toolCall', at: clock(), name, args: c.args, permission: registry.permissionOf(c.name) })
      emit({ type: 'executing', name })
      const s = clock()
      const result = metaKey
        ? await interceptors[metaKey](c.args)
        : await registry.invoke(c.name, c.args, { allow, round })
      trace.push({ type: 'toolResult', at: clock(), name, result, ms: clock() - s })
      if (result.status === 'inputRequired') emit({ type: 'confirming', text: result.message ?? '需要确认' })
      // 快层的拒绝不上横幅（quietRejects）：越权是转交的常态、约束拒绝的解释权归慢层——
      // 结果都如实进报告，慢层看得到（用户实拍："已拒绝执行 无权调用 navigation.setDestination"）
      if (!opts.quietRejects && (result.status === 'rejected' || result.status === 'unavailable'))
        emit({ type: 'rejected', text: result.message ?? '无法执行' })
      return { c, result }
    }))
    return results.map(({ c, result }) => ({
      role: 'tool' as const, tool_call_id: c.id, content: JSON.stringify(result),
    }))
  }

  const asstMsg = (reply: { text?: string; toolCalls?: any[] }): Msg => ({
    role: 'assistant', content: reply.text ?? '',
    tool_calls: reply.toolCalls?.map(c => ({
      id: c.id, type: 'function' as const,
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    })),
  })

  /**
   * 快层视图：最近几条**原话与话术**。工具调用与结果一律不带（§3.2）——
   * 它要的是对话承接感，不是执行细节；上一轮慢层的长报告会撑爆它的预算。
   */
  const fastView = (snapshot: Msg[]): Msg[] =>
    snapshot
      .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content)
      .map(m => ({ role: m.role, content: m.content }))
      .slice(-6)

  /** 快层：能干的立刻干、立刻说；收尾勾选转交。打断（世代变了）即弃场闭嘴 */
  async function runFast(g: number, trace: TraceStep[]): Promise<{ suggested: string[]; said: string; rounds: number }> {
    const fm = deps.fastManifest
    const allTools = [...registry.schemas('openai', fm.tools), HANDOFF_SCHEMA]
    let suggested: string[] = []
    let said = ''
    let rounds = 0
    while (rounds < fm.maxRounds) {
      rounds++
      // 最后一轮撤工具逼话术——实测 GLM-flash 会把两轮全用来重复调同一个工具，
      // 一句话没说就转交，用户等到慢层兜底才听到声。跟慢层最后一轮同一条纪律
      const tools = rounds === fm.maxRounds ? [] : allTools
      const system = buildSystemPrompt(fm, store, registry, {
        catalog: registry.briefCatalog(),
        catalogHint: '仅供你在 agent.handoff 里勾选转交。这些工具你自己一个都调不了，调了也白调',
        signalFilter: registry.signalsFor(fm.tools),
      })
      trace.push({ type: 'prompt', at: clock(), system, toolCount: tools.length })
      const view = fastView(thread)
      let reply
      try { reply = await deps.fastLlm.chat({ system, messages: view, tools }) }
      catch (e) { trace.push({ type: 'error', at: clock(), message: `快层：${e}` }); return { suggested, said, rounds } }
      if (stale(g)) return { suggested, said, rounds }
      // 话术立刻出——先斩后奏的"奏"不等工具返回（车控是本地毫秒级，查询类模型自会下一轮再说）
      if (reply.text) { said = reply.text; emit({ type: 'speaking', text: reply.text, layer: 'fast' }) }
      if (!reply.toolCalls?.length) {
        if (reply.text) commit(g, { role: 'assistant', content: reply.text })
        return { suggested, said, rounds }
      }
      commit(g, asstMsg(reply))
      const toolMsgs = await execRound(g, reply.toolCalls, fm.tools, trace, {
        'agent.handoff': args => {
          suggested = (args?.suggestedTools ?? []).filter((n: string) => registry.list().some(t => t.name === registry.canonicalName(n)))
          return { status: 'ok', message: '已转交' }
        },
      }, { quietRejects: true })
      commit(g, ...toolMsgs)
    }
    return { suggested, said, rounds }
  }

  /* ── 子 Agent 委托（§6）：机制在此，拆不拆/拆几个/等不等全在慢层模型 ── */
  const taskPool: BgTask[] = []
  let taskSeq = 0
  let activeSubs = 0
  const tasks = (): BgTask[] => taskPool.map(t => ({ ...t }))
  const cancelTask = (id: string) => {
    const t = taskPool.find(x => x.id === id)
    if (t?.status === 'running') { t.status = 'cancelled'; emit({ type: 'taskUpdate' }) }
  }

  /**
   * 子 Agent = 同一个循环的独立小生命：自己的 view（只带 goal，不背主对话包袱）、
   * 点名预载 + 目录补载、自己的轮次。无灰权限（后台任务不许自己弹确认）、
   * 无 delegate（深度 1）、无 voice（交付是机械的，不许中途乱说话）。
   */
  async function subRun(goal: string, preload: string[], task?: BgTask): Promise<{ summary: string }> {
    const sm = deps.slowManifest
    const allow = registry.list().filter(t => t.permission !== '灰').map(t => t.name)
    const resident = (sm.resident ?? []).filter(n => !n.startsWith('voice.'))
    const loaded = new Set<string>([...resident, ...preload])
    const manifest = {
      ...sm, role: `
## 子任务模式
你在独立执行一个被委托的子任务，对话第一条就是任务目标。把**结论**用一段话说清——
这段话会被直接播报或展示；要展示报告/图表就自己建卡（报告图表类用 canvas 模板，
列表类用 list）。别闲聊，别问问题——问不到人。`,
    }
    const view: Msg[] = [{ role: 'user', content: goal }]
    const trace: TraceStep[] = []
    for (let r = 0; r < sm.maxRounds; r++) {
      if (task && task.status !== 'running') return { summary: '' }   // 被取消：立刻收手
      const system = buildSystemPrompt(manifest, store, registry, {
        catalog: registry.briefCatalog(),
        signalFilter: registry.signalsFor([...loaded]),
      })
      const tools = r === sm.maxRounds - 1 ? [] : [...registry.schemas('openai', [...loaded]), LOAD_SCHEMA,
        ...(sm.skills?.length ? [SKILL_SCHEMA] : [])]
      const reply = await deps.slowLlm.chat({ system, messages: view, tools })
      if (task && task.status !== 'running') return { summary: '' }
      if (!reply.toolCalls?.length) return { summary: reply.text ?? '' }
      view.push(asstMsg(reply))
      const toolMsgs = await execRound(0, reply.toolCalls, allow, trace, {
        'tools.load': mkLoader(loaded),
        'skill.use': mkSkillUse(loaded),
      })
      view.push(...toolMsgs)
    }
    return { summary: '' }
  }

  /** delegate 拦截器：同步等结果 / 后台立即返回 taskId、完成机械交付 */
  const delegateInterceptor = (args: any): ToolResult | Promise<ToolResult> => {
    const goal = String(args?.goal ?? '').trim()
    if (!goal) return { status: 'rejected', code: 'INVALID_PARAMS', message: 'goal 不能为空' }
    if (activeSubs >= 3)
      return { status: 'rejected', code: 'TASKS_LIMIT', message: '并行任务已达上限 3 个', suggestion: '等一个跑完再派，或合并任务' }
    const preload = ((args?.tools ?? []) as string[])
      .map(n => registry.canonicalName(n))
      .filter(n => registry.list().some(t => t.name === n))
    activeSubs++
    if (args?.background) {
      const task: BgTask = { id: `task_${++taskSeq}`, label: goal.slice(0, 18), status: 'running' }
      taskPool.push(task)
      emit({ type: 'taskUpdate' })
      void subRun(goal, preload, task)
        .then(({ summary }) => {
          if (task.status !== 'running') return    // 取消了就静默收场
          task.status = 'done'; task.summary = summary
          emit({ type: 'taskUpdate' })
          emit({ type: 'taskDone', taskId: task.id, summary, ok: true })
        })
        .catch(e => {
          if (task.status !== 'running') return
          task.status = 'failed'; task.summary = String(e)
          emit({ type: 'taskUpdate' })
          emit({ type: 'taskDone', taskId: task.id, summary: String(e), ok: false })
        })
        .finally(() => { activeSubs-- })
      return { status: 'ok', data: { taskId: task.id }, message: '已转后台，完成会自动通知用户' }
    }
    return subRun(goal, preload)
      .then(({ summary }) => ({ status: 'ok' as const, data: { summary } }))
      .finally(() => { activeSubs-- })
  }

  /** skill.use 拦截器工厂：正文以工具结果注入，附带工具顺路装载 */
  const mkSkillUse = (loaded: Set<string>) => (args: any): ToolResult => {
    const skill = (deps.slowManifest.skills ?? []).find(s => s.name === args?.name)
    if (!skill)
      return { status: 'rejected', code: 'UNKNOWN_SKILL', message: `技能目录里没有「${args?.name}」`, suggestion: '对照技能目录里的名字' }
    for (const n of skill.tools ?? []) {
      const c = registry.canonicalName(n)
      if (registry.list().some(t => t.name === c)) loaded.add(c)
    }
    return { status: 'ok', message: skill.inject, data: { unlocked: skill.tools ?? [] } }
  }

  /** tools.load 拦截器工厂：快慢/子 Agent 各自的 loaded 集合 */
  const mkLoader = (loaded: Set<string>) => (args: any): ToolResult => {
    const names: string[] = ((args?.names ?? []) as string[]).map(n => registry.canonicalName(n))
    const known = names.filter(n => registry.list().some(t => t.name === n))
    known.forEach(n => loaded.add(n))
    const unknown = names.filter(n => !known.includes(n))
    return known.length
      ? { status: 'ok', message: `已装载：${known.join('、')}${unknown.length ? `；没有这些工具：${unknown.join('、')}` : ''}` }
      : { status: 'rejected', code: 'UNKNOWN_TOOL', message: `目录里没有：${names.join('、')}`, suggestion: '对照工具目录里的名字再试' }
  }

  /** 慢层：目录 + 预载 + 补载；校验、接力、静默判断都在模型的输出里 */
  async function runSlow(g: number, suggested: string[], trace: TraceStep[]): Promise<{ said: string; rounds: number; stop: TurnResult['stopReason'] }> {
    const sm = deps.slowManifest
    const loaded = new Set<string>([...(sm.resident ?? []), ...suggested.map(n => registry.canonicalName(n))])
    const view = thread.slice()   // 冻结视图：旧代慢层不许看见新 turn 的内容
    let rounds = 0
    while (rounds < sm.maxRounds) {
      rounds++
      const system = buildSystemPrompt(sm, store, registry, {
        desktop: deps.desktopSummary?.(), prefs: deps.prefsList?.(), recent: deps.recentSummary?.(),
        catalog: registry.briefCatalog(),
        signalFilter: registry.signalsFor([...loaded]),
      })
      trace.push({ type: 'prompt', at: clock(), system, toolCount: loaded.size })
      // 最后一轮撤工具逼话术——语音场景没有"静默耗尽轮次"这个选项
      const last = rounds === sm.maxRounds
      const tools = last ? [] : [...registry.schemas('openai', [...loaded]), LOAD_SCHEMA, DELEGATE_SCHEMA, CANCEL_SCHEMA,
        ...(sm.skills?.length ? [SKILL_SCHEMA] : [])]
      let reply
      try { reply = await deps.slowLlm.chat({ system, messages: view, tools }) }
      catch (e) {
        trace.push({ type: 'error', at: clock(), message: `慢层：${e}` })
        emit({ type: 'error', message: String(e) })
        return { said: '', rounds, stop: 'error' }
      }

      if (!reply.toolCalls?.length) {
        const text = reply.text ?? ''
        if (text) commit(g, { role: 'assistant', content: text })
        trace.push({ type: 'reply', at: clock(), text })
        if (stale(g)) {
          // 迟到的话术不抢麦：降级为横幅素材（§4.1）。活已经干完，成果都在
          if (text) emit({ type: 'lateNote', text })
        } else {
          if (text) emit({ type: 'speaking', text, layer: 'slow' })
          emit({ type: 'done' })
        }
        return { said: text, rounds, stop: 'reply' }
      }

      const am = asstMsg(reply)
      commit(g, am); view.push(am)
      const toolMsgs = await execRound(g, reply.toolCalls, sm.tools, trace, {
        'tools.load': mkLoader(loaded),
        'skill.use': mkSkillUse(loaded),
        'task.delegate': delegateInterceptor,
        'task.cancel': (args: any): ToolResult => {
          const t = taskPool.find(x => x.status === 'running' &&
            (x.id === args?.taskId || (args?.label && x.label.includes(args.label))))
          if (!t) return { status: 'rejected', code: 'TASK_NOT_FOUND', message: '没有对得上的在跑任务' }
          cancelTask(t.id)
          return { status: 'ok', message: `已取消：${t.label}` }
        },
      })
      commit(g, ...toolMsgs); view.push(...toolMsgs)
    }
    if (!stale(g)) emit({ type: 'done' })
    return { said: '', rounds, stop: 'maxRounds' }
  }

  async function run(text: string): Promise<TurnResult> {
    const trace: TraceStep[] = []
    // 空输入直接返回：送进模型它会凭空发挥（实测会无端开窗）
    if (!text.trim()) return { reply: '', trace, rounds: 0, stopReason: 'empty' }
    const g = ++gen
    deps.onTurnStart?.()
    trace.push({ type: 'userInput', at: clock(), text })
    boundary = thread.length
    thread.push({ role: 'user', content: text })
    emit({ type: 'thinking' })

    // pending 确认直达慢层（§4.2）：快层不知道有确认挂着，接了必错。
    // 状态分支不是意图分支——看的是系统状态，不是话的内容
    const pending = registry.pendingConfirm()
    let fast = { suggested: [] as string[], said: '', rounds: 0 }
    if (!pending) fast = await runFast(g, trace)
    else fast.suggested = [pending.tool]

    const slow = await runSlow(g, fast.suggested, trace)
    // 压缩在回复送出之后才起跑——fire-and-forget，不占响应路径一毫秒（§7.5）
    if (!stale(g)) compaction = doCompact(g).catch(() => { /* 失败保持原样，下轮重试 */ })
    return {
      reply: [fast.said, slow.said].filter(Boolean).join(' '),
      trace, rounds: fast.rounds + slow.rounds,
      stopReason: slow.stop,
    }
  }

  /* ── 异步记忆压缩：thread = 摘要头 + 最近 K 轮全文 ── */
  let compaction: Promise<void> = Promise.resolve()
  async function doCompact(g: number) {
    const userIdx = thread.map((m, i) => (m.role === 'user' ? i : -1)).filter(i => i >= 0)
    if (userIdx.length <= KEEP_ROUNDS) return
    const cutAt = userIdx[userIdx.length - KEEP_ROUNDS]
    const head = thread.slice(0, cutAt)
    // 旧摘要参与重压——摘要是滚动的，不是一摞
    const folded = head.map(m =>
      `${m.role}: ${(m.content || (m.tool_calls?.length ? `[调用 ${m.tool_calls.map(c => c.function.name).join('、')}]` : '')).slice(0, 300)}`,
    ).join('\n')
    const reply = await deps.fastLlm.chat({
      system: COMPACT_PROMPT,
      messages: [{ role: 'user', content: folded }], tools: [],
    })
    // 压缩期间用户又开口了 → 本次作废，宁可下轮重压也不改写正在用的现场
    if (stale(g)) return
    const text = (reply.text ?? '').trim()
    if (!text) return
    thread.splice(0, cutAt, { role: 'assistant', content: `${SUM_MARK}\n${text}` })
    boundary = Math.max(thread.map((m, i) => (m.role === 'user' ? i : -1)).filter(i => i >= 0).pop() ?? 0, 0)
    deps.memory?.save(text)
  }

  const reset = () => { thread.length = 0; boundary = 0 }

  return { run, on, reset, thread, tasks, cancelTask,
    get generation() { return gen }, get compaction() { return compaction } }
}

export type Pipeline = ReturnType<typeof createPipeline>
