import type { Store } from '../core/store'
import type { Registry, ToolResult } from '../tools/registry'
import type { LLM, Msg } from './llm'
import type { AgentManifest } from '../../agents/main-agent/manifest'
import { buildSystemPrompt, buildStateNote } from './context'
import { createTurn, type Turn } from './turn'

export type TraceStep =
  | { type: 'userInput'; at: number; text: string; runId?: string; source?: string }
  | { type: 'prompt'; at: number; system: string; toolCount: number; layer?: 'fast' | 'slow'; llmMs?: number
      /** 调试全量：这一轮送进模型的消息视图与模型原始返回（产品点名要能逐轮看） */
      view?: Msg[]; llmReply?: { text?: string; toolCalls?: Array<{ name: string; args: any }> }; schemaChars?: number; stateChars?: number }
  | { type: 'toolCall'; at: number; name: string; args: any; permission?: string }
  | { type: 'toolResult'; at: number; name: string; result: ToolResult; ms: number }
  | { type: 'reply'; at: number; text: string; layer?: 'fast' | 'slow' }
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
  | { type: 'compacted'; chars: number; foldedRounds: number }

export interface BgTask {
  id: string
  label: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  summary?: string
  /** 进展流（§6.2）：机制副产品——LLM 轮与工具调用都是步骤，零模型成本 */
  steps: Array<{ label: string; at: number; ms?: number }>
  /** 当前动作（状态栏芯片旁的微字） */
  current?: string
}

export interface PipelineDeps {
  registry: Registry
  store: Store
  fastLlm: LLM
  /**
   * 快层开关（2026-08-25 产品决策）：可用的快层模型要么比慢层还慢一个
   * 数量级、要么爱把工具调用当话念，先关掉全走慢层——面板可再开。
   * 只关 runFast 这一段：异步记忆压缩照旧用小模型（那是省钱不是抢答）。
   */
  fastEnabled?: () => boolean
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

/** execRound 的返回值（R-1）：denied/allDenied/bizCalls/bizOk 曾是模块级"出参"，现在是真返回值 */
export interface ExecOutcome { toolMsgs: Msg[]; denied: string[]; allDenied: boolean; bizCalls: number; bizOk: number }

/* 元工具：装载管道，不进 TOOLS（那是业务能力表）。schema 由这里注入，调用由这里拦截 */
const HANDOFF_SCHEMA = {
  type: 'function', function: {
    name: 'agent_handoff',
    description: '收尾必调：say 放给用户的一句话（≤15 字）——你办成了就报结果；没轮到你办的只说衔接语（"稍等""这就来"），绝不说"做不了/抱歉"，你办不了≠系统办不了，同事马上接手。suggestedTools 勾出同事接下来可能用到的工具名（从目录挑，没有就空着）。',
    parameters: {
      type: 'object',
      properties: {
        say: { type: 'string', description: '立即播报给用户的话术' },
        suggestedTools: { type: 'array', items: { type: 'string' }, description: '工具名列表，如 ["navigation.search"]' },
      },
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
    description: '把子任务委托给子 Agent 执行。**要联网查证、要成文交付的耗时重活，哪怕只有一件也建议委托**——子 Agent 有自己独立的完整轮次预算，你自己一轮轮磨会把轮次耗尽在查证上，最后没轮次交付（实测翻过车）。多个互不依赖的重活在同一轮连发多个即并行。background=true 立即返回 taskId 后台跑，完成后系统自动通知用户（你先答"我去查着"即可）；否则等结果回来你汇总。',
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
const AGENDA_SET_SCHEMA = {
  type: 'function', function: {
    name: 'agenda_set',
    description: '给自己记一条跨轮主线备忘（≤80 字：在干什么大事 + 做到哪 + 下一步）。带用户做跨多轮的引导/巡演/分步计划时用——每轮你都会在状态注入里看到它，不怕对话压缩丢线。每推进一步就重设更新。判据：它只记线不干活；要办耗时事用 task.delegate；有域仓的任务（旅行/绘本）自己有仓不用它；用户偏好用 memory.remember。',
    parameters: {
      type: 'object', required: ['text'], additionalProperties: false,
      properties: { text: { type: 'string', description: '主线一句话，如"功能巡演：已演示空调/车窗，下一步导航，之后媒体"' } },
    },
  },
}
const AGENDA_CLEAR_SCHEMA = {
  type: 'function', function: {
    name: 'agenda_clear',
    description: '主线做完或用户明确不继续了，清掉议程备忘。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
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

/**
 * 自纠错误码：参数写错、形状不对这类**模型下一轮自己就能修**的拒绝，
 * 不上横幅（实拍：建卡缺 ttl 被拒弹"有错误做不了"，下一轮它就补对了）。
 * 业务性拒绝（约束拦截、没有队列）仍然要让用户听到——那是事实不是笔误。
 */
const SELF_FIX_CODES = new Set([
  'INVALID_PARAMS', 'DATA_SHAPE_MISMATCH', 'TTL_REQUIRED', 'SIZE_NOT_SUPPORTED',
  'UNKNOWN_TOOL', 'UNKNOWN_SKILL', 'EMPTY_CARD', 'TASK_NOT_FOUND', 'SYSTEM_TEMPLATE',
  'LAST_STOP', 'REPEAT_CALL', 'STALE_TURN', 'ECHO_FAST',
])

/** epoch 摘要消息的识别标 */
const SUM_MARK = '【前情摘要】'
/** 滑动窗口：折叠后保留最近 K 轮全文 */
const KEEP_ROUNDS = 6   // 2026-08-25 从 4 上调：实拍「记不住空调操作」，拿一点 token 换记忆窗口
/**
 * 滞后批量化（2026-08-25 Hermes 对照）：超过 KEEP+LAG 轮才压、一次折到剩 KEEP。
 * 原来每轮都压（第 7 轮起轮轮重写摘要），摘要被小模型反复复印，每次复印都在
 * 丢细节——实拍功能巡演"讲着讲着忘了"的三个根因之一。滞后 4 轮 = 复印频率降 4 倍。
 */
const COMPACT_LAG = 4
const COMPACT_PROMPT = `你是座舱对话的记忆压缩器。把给你的**较早对话**压成【前情摘要】（交接参考），分三段：
- 第一段「进行中的多轮任务」：有没有一件跨多轮还没做完的事（功能巡演、分步攻略、
  连环委托）——它是什么、做到哪一步、下一步该干什么。没有就写"进行中：无"。
  **这一段最重要**：丢了它，接手的人就会忘了自己正在带用户做什么
- 第二段「做过的操作」清单，按时间次序一行一条：用户让做了什么 → 结果如何
  （开了车窗、关了空调、导航去了哪——**已办完的也要留**，用户会回头问
  "我刚才让你干了什么"，丢了操作史就是失忆）
- 第三段「未解决的问题」：等用户答复的问题、答应了还没办的事、定下的偏好
- 最后一行固定写「提到过：xxx、yyy」——列出出现过的地名/人名/歌名/店名，
  这是检索索引：用户以后说"刚才那个加油站"要靠它找锚点
- 总共不超过 16 行，只输出摘要正文，不解释`

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
  /**
   * 上回说到：跨会话留一行，"接着昨天那个路线"接得上（§7.5）。
   *
   * **用 system 角色，而且要写明"以当前请求为准"。** 以前它是 assistant 角色，
   * 模型看到的是"这是我自己刚说过的话"，牵引力远强于一条背景说明——实拍抓到过：
   * 用户开机第一句是"打开车窗、打开空调、你有哪些功能"，Agent 三件事一件没做，
   * 接着上个会话的话头问"你要去哪个充电站"。
   */
  const lastTimeLine = (t: string) =>
    `${SUM_MARK}上回说到：${t}\n（这只是上一次对话的背景，用户这次要什么以当前消息为准，别接着上回的话头往下讲）`
  const lastTime = deps.memory?.load()
  if (lastTime) thread.push({ role: 'system', content: lastTimeLine(lastTime) })

  /** 界面拿它显示"当前带着上回的记忆"——用户看不见就没法预期，出了事只能翻代码 */
  const hasLastTime = () => !!deps.memory?.load()
  /**
   * 忘掉跨会话记忆：当前 thread 里那条和持久化的那份一起清。
   * 只清一边的话"清除"名不副实——清了内存的，刷新页面它又回来了。
   */
  const forgetLastTime = () => {
    const i = thread.findIndex(m => m.role === 'system' && (m.content ?? '').startsWith(SUM_MARK))
    if (i >= 0) thread.splice(i, 1)
    deps.memory?.save('')
  }

  const stale = (g: number) => g !== gen
  /**
   * 会话被清空时的世代线。比它老的代 = 属于已经不存在的那个会话，产物直接丢弃。
   *
   * 只有 stale 一个判据是不够的：barge-in（用户插话）和 reset（清空会话）都会
   * 让旧 turn 变 stale，但处置完全相反——前者的消息该插到新用户输入之前保住
   * 上下文，后者的消息一条都不该留。不区分的话，重置后旧 turn 跑完会把
   * assistant/tool 消息 splice 进空 thread，下次提问时模型看到一段用户
   * 从未说过的幽灵对话。
   */
  let resetGen = 0
  const discarded = (g: number) => g < resetGen
  /** 落 thread：当前代直接追加；旧代插到最新 turn 的用户输入之前；已重置的代丢弃 */
  const commit = (g: number, ...msgs: Msg[]) => {
    if (discarded(g)) return
    if (!stale(g)) thread.push(...msgs)
    else { thread.splice(boundary, 0, ...msgs); boundary += msgs.length }
  }

  /** mic 类工具名单（声明在 ToolDef.mic）。stale 轮里说话/提问都算抢麦 */
  const MIC = new Set(registry.list().filter((t: any) => t.mic).map((t: any) => t.name))
  /** 纯播报类（mic:'say'）：额外受"出声权"闸管——判据是声明，pipeline 不点名工具 */
  const MIC_SAY = new Set(registry.list().filter((t: any) => t.mic === 'say').map((t: any) => t.name))

  /**
   * 执行一轮 tool calls（元工具由 interceptors 拦，业务走 registry）。
   *
   * `turn` 持有撞墙检测与打转熔断（R-1，src/agent/turn.ts）——按 lane（fast/slow）
   * 记上一轮 ok 的调用签名：撞墙检测只看失败，实拍同文 voice.speak 连 ok 6 轮烧光
   * 轮次；相邻两轮同签名且上轮已成功，本轮先斩。一轮内并行重复不拦（连跳两首是
   * 一轮两个调用），跨 turn 不拦（新输入=新意愿，run() 每次建一份新 Turn）。
   * subRun 拿自己独立的 Turn，不会跟主 turn 的撞墙计数互相污染。
   */
  async function execRound(
    g: number, calls: NonNullable<Awaited<ReturnType<LLM['chat']>>['toolCalls']>,
    allow: string[], trace: TraceStep[],
    interceptors: Record<string, (args: any) => ToolResult | Promise<ToolResult>>,
    turn: Turn,
    opts: { quietRejects?: boolean; background?: boolean; lane?: string; canSpeak?: () => boolean } = {},
  ): Promise<ExecOutcome> {
    /**
     * 这一轮的事件该不该露面。以前 emit 既不看世代也不看来源（g 参数在函数体里
     * 根本没被用过）：后台子 Agent 的工具被业务规则拒绝时，会往**当前对话**
     * 弹一条红色横幅，用户正进行的对话被一条跟上下文毫无关系的解释打断，
     * 且无从知道它来自哪个后台任务；barge-in 之后旧 turn 的拒绝同样盖在新 turn 上
     * （话术那半边早有 lateNote 降级通道，工具事件这半边一直是裸奔的）。
     */
    const audible = () => !opts.background && !stale(g)
    const round = ++toolRound
    const results = await Promise.all(calls.map(async c => {
      const metaKey = Object.keys(interceptors).find(k => isMeta(c.name, k))
      const name = metaKey ?? registry.canonicalName(c.name)
      trace.push({ type: 'toolCall', at: clock(), name, args: c.args, permission: registry.permissionOf(c.name) })
      if (audible()) emit({ type: 'executing', name })
      const s = clock()
      const sig = `${name}|${JSON.stringify(c.args ?? {})}`
      const result: ToolResult = metaKey
        ? await interceptors[metaKey](c.args)
        : MIC.has(name) && stale(g) && !discarded(g)
          ? { status: 'rejected', code: 'STALE_TURN',
              message: '用户已经继续别的话题了，这轮的问题/播报已过期——收尾即可，别再输出' }
          /**
           * 复述静音的工具侧堵口（2026-08-19 实拍：快层报完空调偏好，慢层
           * voice.speak 又念一遍——静音只挡了 reply 文本通道，工具通道裸奔；
           * 屏端同文去重也救不了，两句差一个"档"字）。
           * 出声权（canSpeak）是 turn 状态，reply 的 echo 判定与这里共用同一个
           * 谓词；受不受它管由工具自己声明（mic:'say'），pipeline 不点名工具——
           * voice.ask 是 'ask'：问题本身就是新信息，不受此闸。
           */
          : MIC_SAY.has(name) && opts.canSpeak && !opts.canSpeak()
            ? { status: 'rejected', code: 'ECHO_FAST',
                message: '刚才那句用户已经听到了，不用再念——没有新增就直接收尾（回空即可）' }
          : opts.lane && turn.wasJustOk(opts.lane, sig)
            ? { status: 'rejected', code: 'REPEAT_CALL',
                message: '这个调用上一轮刚成功过，重复只会原地打转——直接收尾' }
            : await registry.invoke(c.name, c.args, { allow, round })
      trace.push({ type: 'toolResult', at: clock(), name, result, ms: clock() - s })
      // mic 工具真出声了 → turn 记一笔（空收场兜底靠它分"合法静默"和"全程哑场"）
      if (MIC.has(name) && result.status === 'ok') turn.markSpoke()
      // LRU 触碰：装载集里的工具被成功调用 → 挪到队尾，常用的不被误逐
      if (result.status === 'ok' && sessionLoaded.has(name)) rememberLoaded(name)
      if (result.status === 'inputRequired' && audible()) emit({ type: 'confirming', text: result.message ?? '需要确认' })
      // 快层的拒绝不上横幅（quietRejects）：越权是转交的常态、约束拒绝的解释权归慢层——
      // 结果都如实进报告，慢层看得到（用户实拍："已拒绝执行 无权调用 navigation.setDestination"）
      if (!opts.quietRejects && audible() && (result.status === 'rejected' || result.status === 'unavailable')
          && !SELF_FIX_CODES.has(result.code ?? ''))
        emit({ type: 'rejected', text: result.message ?? '无法执行' })
      return { c, result }
    }))
    /**
     * **别撞死在同一堵墙上。** 实拍：模型连着 9 轮用同样的错误参数调
     * card.show，每轮被同一个错误码拒，40 秒烧完轮次上限，最后一句话没说 ——
     * 用户问「你有什么功能」，屏幕空白、Agent 沉默。
     *
     * 判据只看**同一个工具 + 同一个错误码连续几次**，不看是什么工具、
     * 什么错误 —— 机制不是意图分支。换了工具或换了错误码就重新计数：
     * 那是在往前走，不是在打转。
     */
    /**
     * 这一轮有哪些工具是**越权**被拒的。
     *
     * 实拍算账（一次导航 16.7 秒）：快层轮1 花 9.1 秒决定调
     * navigation.setDestination，0ms 就被判越权；接着又花 3.9 秒跑第二轮
     * 才转交 —— 而拿到 NOT_AUTHORIZED 的那一刻，"这活归慢层"已经是确定的事实，
     * 越权的工具名本身就是最好的 suggestedTools。第二轮纯属白等。
     *
     * 记的是**权限判定的结果**（系统状态），不是话的内容 ——
     * 跟「pending 确认直达慢层」同一条：状态分支不是意图分支。
     */
    const denied = results
      .filter(({ result }) => result.code === 'NOT_AUTHORIZED')
      .map(({ c }) => registry.canonicalName(c.name))
    // "整轮越权"按**业务调用**算——快层惯常"越权调用+handoff 同轮"，
    // 把 meta 算进分母的话这个判定永远不成立，接力棒递不出去（TDD 抓到）
    const bizN = results.filter(({ c }) => !Object.keys(interceptors).find(k => isMeta(c.name, k))).length
    const allDenied = denied.length > 0 && denied.length === bizN
    if (opts.lane)
      // 本轮 ok 的签名 + 本轮被 REPEAT_CALL 拦下的签名都记住——
      // 只记 ok 的话熔断只挡一轮：拦截轮没有 ok，表被清空，第三轮同参重放
      // 就穿了（实拍：story.begin 同参连发，故事被开讲两次）。执念要换参数才放行
      turn.recordLane(opts.lane, results
        .filter(({ c, result }) => (result.status === 'ok' || result.code === 'REPEAT_CALL')
          && !Object.keys(interceptors).find(k => isMeta(c.name, k)))
        .map(({ c }) => `${registry.canonicalName(c.name)}|${JSON.stringify(c.args ?? {})}`))
    const biz = results.filter(({ c }) => !Object.keys(interceptors).find(k => isMeta(c.name, k)))
    const bizCalls = biz.length
    if (biz.length) actedGens.add(g)   // 这个 run 有副作用了——不再可被吞并
    const bizOk = biz.filter(({ result }) => result.status === 'ok').length
    // 快层的拒绝是常态（越权 → 转交），不算撞墙，别污染计数
    const bad = opts.quietRejects ? []
      : results.filter(({ result }) => result.status === 'rejected' || result.status === 'unavailable')
    const sig = bad.length === results.length && bad.length
      ? bad.map(({ c, result }) => `${registry.canonicalName(c.name)}|${result.code ?? ''}`).sort().join(',')
      : ''
    /**
     * 元工具轮不清洗撞墙计数（2026-08-19 实拍）：create 拒 2 次 →
     * tools.load 成功 → 又拒 2 次——计数在"成功轮"清零永远凑不满 3，
     * 模型同一堵墙撞了 7 次烧光轮次。load/skill 是准备动作不是进展，
     * 只有**业务调用**的成功才算走出了墙。
     */
    const metaOnly = results.every(({ c }) => Object.keys(interceptors).find(k => isMeta(c.name, k)))
    turn.noteFailSig(sig, metaOnly)
    const toolMsgs = results.map(({ c, result }) => ({
      role: 'tool' as const, tool_call_id: c.id, content: JSON.stringify(result),
    }))
    return { toolMsgs, denied, allDenied, bizCalls, bizOk }
  }
  /**
   * voice.ask 问出去还没人答（2026-08-19 实拍：绘本 ask 挂着，"结束"被
   * 快层接走当成故事内选项乱答）。跟 pending MRTR 确认同族：下一句直达慢层。
   */
  let askPending = false

  const asstMsg = (reply: { text?: string; toolCalls?: any[] }): Msg => ({
    role: 'assistant', content: reply.text ?? '',
    tool_calls: reply.toolCalls?.map(c => ({
      id: c.id, type: 'function' as const,
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    })),
  })

  /**
   * 快层视图分两段裁（§3.2）：**历史轮**只留原话与话术（承接感够了，执行细节
   * 会撑爆预算）；**本 turn**（boundary 起）完整保留含工具结果（截断）——
   * 不然话术轮看不见自己刚干的活，会说"马上查"其实早查完了（实拍）。
   */
  const fastView = (snapshot: Msg[]): Msg[] => {
    const past = snapshot.slice(0, boundary)
      .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content)
      .map(m => ({ role: m.role, content: m.content }))
      .slice(-5)
    const now = snapshot.slice(boundary)
      .map(m => (m.role === 'tool' ? { ...m, content: m.content.slice(0, 300) } : m))
    return [...past, ...now]
  }

  /**
   * 纯工具名形状的输出不是话（2026-08-25 实拍：快层把 "-agent.handoff-"
   * 当话术说了出来）。判据是数据形状——整句只是一个 xx.yy 标识符，
   * 不含任何自然语言；跟 {item} 展平同类，协议适配不是意图分支。
   */
  const toolNameShaped = (t: string) =>
    /^[-—·\s"'`]*[a-zA-Z][\w-]*[._][\w.-]+[-—·\s"'`]*$/.test(t.trim())
    // 序列化的调用也不是话（同日 pilot 实拍："agent_handoff: say=\"稍等\"
    // suggestedTools=[…] 云南有四条线…"整段上嘴）：以 工具名: 或 工具名( 开头
    // 的输出是模型把调用写成了文字——整段作废，快层的话让慢层接
    || /^\s*[a-zA-Z][\w-]*[._][\w-]+\s*[:(]/.test(t)
  /**
   * 序列化调用混在句中（同日再拍："滇西北经典线已生成，6天5晚。
   * agent_handoff: 行程计划已生成…"）：从调用处截断，前半句人话保留。
   * 判据仍是数据形状——空白后跟 工具名:/( 的序列化特征。
   */
  const stripSerialized = (t: string) => {
    const m = /\s[a-zA-Z][\w-]*[._][\w-]+\s*[:(]/.exec(t)
    return m ? t.slice(0, m.index).trim() : t
  }

  /** 快层：能干的立刻干、立刻说；收尾勾选转交。打断（世代变了）即弃场闭嘴 */
  async function runFast(g: number, trace: TraceStep[], turn: Turn):
    Promise<{ suggested: string[]; said: string; rounds: number; did: number; bizCalls: number; denied: string[]; allDenied: boolean }> {
    const fm = deps.fastManifest
    const allTools = [...registry.schemas('openai', fm.tools), HANDOFF_SCHEMA]
    let suggested: string[] = []
    let said = ''
    let rounds = 0
    /** 本 turn 快层办成了几件事（业务工具 ok 数）——慢层复述静音的判据之一 */
    let did = 0, bizCalls = 0
    /** handoff 是快层的**终止符**：调完就收尾，再开一轮只会再调一遍（实拍） */
    let handedOff = false
    /** 上一次 execRound 的越权结果——run() 拿它拼 handover 清单 */
    let denied: string[] = []
    let allDenied = false
    while (rounds < fm.maxRounds) {
      rounds++
      // 最后一轮撤业务工具逼话术（实测 GLM-flash 会两轮全用来重复调用），
      // 但 handoff 留着——撤了它，模型会把勾选写进话术念给用户听（实拍）
      const last = rounds === fm.maxRounds
      const tools = last ? [HANDOFF_SCHEMA] : allTools
      const system = buildSystemPrompt(fm, store, registry, {
        catalog: registry.briefCatalog(),
        catalogHint: '仅供你在 agent.handoff 里勾选转交。这些工具你自己一个都调不了，调了也白调',
      })
      const note = buildStateNote(fm, store, { signalFilter: registry.signalsFor(fm.tools) })
      const view = fastView(thread)
      const messages = note ? [...view, { role: 'system' as const, content: note }] : view
      const pEntry: TraceStep = { type: 'prompt', at: clock(), system, toolCount: tools.length, layer: 'fast', view: messages }
      pEntry.stateChars = note.length
      trace.push(pEntry)
      const tChat = clock()
      let reply
      // maxTokens 拦话术轮的"长思考狂写"（实拍 qwen-flash 撤工具后那轮 24s）：
      // 话术纪律 ≤15 字 + 一个 handoff 调用，300 token 顶天
      try { reply = await deps.fastLlm.chat({ system, messages, tools, maxTokens: last ? 300 : 800 }) }
      catch (e) { trace.push({ type: 'error', at: clock(), message: `快层：${e}` }); return { suggested, said, rounds, did, bizCalls, denied, allDenied } }
      ;(pEntry as any).llmMs = clock() - tChat
      ;(pEntry as any).llmReply = { text: reply.text, toolCalls: reply.toolCalls?.map(c => ({ name: c.name, args: c.args })) }
      /**
       * **作废分两种，处置完全相反**（四条纪律第 3 条）：
       *   · `discarded`（清空会话）→ 副作用一起作废，立刻收手
       *   · `stale`（barge-in，用户**追加**了一句）→ **活照干完**，只是不抢麦
       *
       * 实拍（2026-08-14）：用户连说「关闭空调」「关闭车窗」，两条都没执行。
       * 根因就是这一行原来写的是 `if (stale(g)) return` —— 模型已经决定要调
       * climate.set 了，却因为用户又说了一句而整轮丢掉。设计写的是
       * 「旧慢层活照干完、话术降级」，慢层做到了，快层没有；
       * 而快层挂的恰恰是车控这类**用户明说要做的事**，丢掉最刺眼。
       */
      if (discarded(g)) return { suggested, said, rounds, did, bizCalls, denied, allDenied }
      // 话术立刻出——先斩后奏的"奏"不等工具返回（车控是本地毫秒级，查询类模型自会下一轮再说）
      const cleanText = reply.text ? stripSerialized(reply.text) : ''
      if (cleanText && !stale(g) && !toolNameShaped(cleanText)) {
        said = cleanText
        trace.push({ type: 'reply', at: clock(), text: cleanText, layer: 'fast' })
        emit({ type: 'speaking', text: cleanText, layer: 'fast' })
      }
      if (!reply.toolCalls?.length) {
        if (reply.text) commit(g, { role: 'assistant', content: reply.text })
        return { suggested, said, rounds, did, bizCalls, denied, allDenied }
      }
      commit(g, asstMsg(reply))
      const outcome = await execRound(g, reply.toolCalls, fm.tools, trace, {
        'agent.handoff': args => {
          // {item:…} 是模型对数组的常见退化（三条模型接口纪律第 1 条），这里也要收
          const st = args?.suggestedTools
          const arr: string[] = Array.isArray(st) ? st
            : st && typeof st === 'object' && Object.keys(st).length === 1 && 'item' in st ? [st.item].flat()
            : []
          suggested = arr.filter((n: string) => registry.list().some(t => t.name === registry.canonicalName(n)))
          // say = 勾选顺带的话术。实拍：话术轮模型只调 handoff 不给 text，轮次用尽
          // 一声没吭——说话不能依赖模型"调完还记得说"，并进同一个调用
          const say = stripSerialized(String(args?.say ?? '').trim())
          if (say && !said && !stale(g) && !toolNameShaped(say)) {
            said = say
            trace.push({ type: 'reply', at: clock(), text: say, layer: 'fast' })
            emit({ type: 'speaking', text: say, layer: 'fast' })
          }
          handedOff = true
          return { status: 'ok', message: '已转交' }
        },
      }, turn, { quietRejects: true, lane: 'fast' })
      denied = outcome.denied; allDenied = outcome.allDenied
      did += outcome.bizOk
      bizCalls += outcome.bizCalls
      commit(g, ...outcome.toolMsgs)
      // 手头这批工具做完就收手：作废的那一轮不该再开新一轮 LLM，
      // 它的输出只会更没意义，还占着模型额度和时间
      if (stale(g)) return { suggested, said, rounds, did, bizCalls, denied, allDenied }
      if (handedOff) return { suggested, said, rounds, did, bizCalls, denied, allDenied }
      /**
       * **整轮都越权 = 这活归慢层，立刻转交。** 再跑一轮只是等模型
       * 把同一个结论说一遍（实拍那一轮 3.9 秒）。越权的工具名直接当
       * 转交建议 —— 慢层第一轮就能调，省掉一次 tools.load。
       */
      if (allDenied) {
        for (const n of denied) if (!suggested.includes(n)) suggested.push(n)
        return { suggested, said, rounds, did, bizCalls, denied, allDenied }
      }
    }
    return { suggested, said, rounds, did, bizCalls, denied, allDenied }
  }

  /* ── 子 Agent 委托（§6）：机制在此，拆不拆/拆几个/等不等全在慢层模型 ── */
  const taskPool: BgTask[] = []
  let taskSeq = 0
  let activeSubs = 0
  const tasks = (): BgTask[] => taskPool.map(t => ({ ...t, steps: t.steps.map(x => ({ ...x })) }))
  const cancelTask = (id: string) => {
    const t = taskPool.find(x => x.id === id)
    if (t?.status === 'running') { t.status = 'cancelled'; emit({ type: 'taskUpdate' }) }
  }

  /** 元工具的人话标签（业务工具用 brief，这几个管道工具不在 TOOLS 里） */
  const META_LABELS: Record<string, string> = {
    'tools.load': '装载工具', 'skill.use': '取设计规范', 'agent.handoff': '转交',
  }
  /** 步骤推进：结掉上一步的耗时、开新步、更新 current，taskUpdate 通知 UI */
  const step = (task: BgTask | undefined, label: string) => {
    if (!task || task.status !== 'running') return
    const now = clock()
    const last = task.steps[task.steps.length - 1]
    if (last && last.ms === undefined) last.ms = now - last.at
    task.steps.push({ label, at: now })
    task.current = label
    emit({ type: 'taskUpdate' })
  }
  const stepLabel = (name: string) => {
    const canonical = registry.canonicalName(name)
    const metaKey = Object.keys(META_LABELS).find(k => isMeta(name, k))
    return metaKey ? META_LABELS[metaKey]
      : (registry.list().find(t => t.name === canonical)?.brief ?? canonical)
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
    // 子 Agent 自己的 Turn：撞墙计数与主 turn 隔离（R-1）——以前是模块级共享，
    // 后台子任务撞墙会污染前台对话的撞墙计数，反过来也一样
    const subTurn = createTurn()
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
      step(task, `思考中（第 ${r + 1} 轮）`)
      const system = buildSystemPrompt(manifest, store, registry, {
        catalog: registry.briefCatalog(),
      })
      const note = buildStateNote(manifest, store, { signalFilter: registry.signalsFor([...loaded]) })
      const messages = note ? [...view, { role: 'system' as const, content: note }] : view.slice()
      const tools = r === sm.maxRounds - 1 ? [] : [...registry.schemas('openai', [...loaded]), LOAD_SCHEMA,
        ...(sm.skills?.length ? [SKILL_SCHEMA] : [])]
      const reply = await deps.slowLlm.chat({ system, messages, tools })
      if (task && task.status !== 'running') return { summary: '' }
      if (!reply.toolCalls?.length) return { summary: reply.text ?? '' }
      for (const c of reply.toolCalls) step(task, `正在${stepLabel(c.name)}`)
      view.push(asstMsg(reply))
      const outcome = await execRound(gen, reply.toolCalls, allow, trace, {
        'tools.load': mkLoader(loaded),
        'skill.use': mkSkillUse(loaded),
      }, subTurn, { background: true })
      view.push(...outcome.toolMsgs)
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
      const task: BgTask = { id: `task_${++taskSeq}`, label: goal.slice(0, 18), status: 'running', steps: [] }
      taskPool.push(task)
      emit({ type: 'taskUpdate' })
      void subRun(goal, preload, task)
        .then(({ summary }) => {
          if (task.status !== 'running') return    // 取消了就静默收场
          const last = task.steps[task.steps.length - 1]
          if (last && last.ms === undefined) last.ms = clock() - last.at
          task.status = 'done'; task.summary = summary; task.current = undefined
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
    // 同步分支以前没有 .catch：子 Agent 的 LLM 一挂（429/超时/网络），异常经
    // execRound 的 Promise.all 穿透 runSlow（那里的 await 在 try 之外）直到 run()，
    // 既不 emit error 也不 emit done——avatar 永远停在 thinking。
    // 子任务失败是**工具失败**，按工具契约返回 failed，让模型自己决定怎么办
    return subRun(goal, preload)
      .then(({ summary }) => ({ status: 'ok' as const, data: { summary } }))
      .catch(e => ({ status: 'failed' as const, code: 'SUBAGENT_ERROR',
        message: `子任务没跑成：${String(e)}`, suggestion: '可以自己直接查，或稍后再派一次' }))
      .finally(() => { activeSubs-- })
  }

  /** skill.use 拦截器工厂：正文以工具结果注入，附带工具顺路装载 */
  const mkSkillUse = (loaded: Set<string>) => (args: any): ToolResult => {
    const skill = (deps.slowManifest.skills ?? []).find(s => s.name === args?.name)
    if (!skill)
      return { status: 'rejected', code: 'UNKNOWN_SKILL', message: `技能目录里没有「${args?.name}」`, suggestion: '对照技能目录里的名字' }
    for (const n of skill.tools ?? []) {
      const c = registry.canonicalName(n)
      if (registry.list().some(t => t.name === c)) { loaded.add(c); rememberLoaded(c) }
    }
    return { status: 'ok', message: skill.inject, data: { unlocked: skill.tools ?? [] } }
  }

  /**
   * 会话级装载记忆（2026-08-25 审计）：loaded 集原来每个 run 重建——
   * 上一轮 tools.load 的工具下一轮就没了，跨轮重复补载白烧轮次（实拍
   * load travel.create 后下轮又 load travel.watch，每次 5–10s）。
   * load 过的记进会话集，下个 run 直接在手边；上限 FIFO 防会话后期
   * schema 无限膨胀；reset 清空。skill.use 解锁的工具同样记住。
   * 符合官方 tool search 的「append 不 swap」——还顺带保住 prompt 缓存前缀。
   */
  const SESSION_LOADED_MAX = 20
  /** 连续几个 run 没用就退出装载集——换话题后旧域工具自动轻装（2026-08-25 拍板） */
  const SESSION_IDLE_RUNS = 8
  /** name → 最后一次装载/使用的 run 序号。LRU：调用成功也触碰，常用的不被误逐 */
  const sessionLoaded = new Map<string, number>()
  /**
   * 议程位（2026-08-25 Hermes 对照拍板）：「只有话没有仓」的跨轮计划（功能巡演、
   * 分步引导）唯一的载体是对话本身，压缩一复印就丢线。agenda 是模型自己写给
   * 自己的主线备忘，每轮随状态注入回到眼前，不经过压缩。会话级，reset 清空。
   */
  const AGENDA_IDLE_RUNS = 12
  let agendaText = ''
  let agendaAt = 0
  /** 12 个 run 没更新就自动失效——忘了 clear 的议程不该永远缠着后面的闲聊 */
  const agendaNow = () => (agendaText && runSeq - agendaAt > AGENDA_IDLE_RUNS) ? (agendaText = '') : agendaText
  const rememberLoaded = (n: string) => {
    sessionLoaded.set(n, runSeq)
    if (sessionLoaded.size > SESSION_LOADED_MAX) {
      const oldest = [...sessionLoaded.entries()].sort((a, b) => a[1] - b[1])[0]
      sessionLoaded.delete(oldest[0])
    }
  }
  /** run 开始时的衰减扫：闲置过久的移出 */
  const decayLoaded = () => {
    for (const [n, at] of sessionLoaded)
      if (runSeq - at > SESSION_IDLE_RUNS) sessionLoaded.delete(n)
  }

  /** tools.load 拦截器工厂：快慢/子 Agent 各自的 loaded 集合 */
  const mkLoader = (loaded: Set<string>) => (args: any): ToolResult => {
    const names: string[] = ((args?.names ?? []) as string[]).map(n => registry.canonicalName(n))
    const known = names.filter(n => registry.list().some(t => t.name === n))
    known.forEach(n => { loaded.add(n); rememberLoaded(n) })
    const unknown = names.filter(n => !known.includes(n))
    return known.length
      ? { status: 'ok', message: `已装载：${known.join('、')}${unknown.length ? `；没有这些工具：${unknown.join('、')}` : ''}` }
      : { status: 'rejected', code: 'UNKNOWN_TOOL', message: `目录里没有：${names.join('、')}`,
          suggestion: (() => {
            const near = names.flatMap(n => registry.nearestTools?.(n, 1) ?? [])
            return near.length ? `是不是想装：${[...new Set(near)].join('、')}？` : '对照工具目录里的名字再试'
          })() }
  }

  /** 慢层：目录 + 预载 + 补载；校验、接力、静默判断都在模型的输出里 */
  async function runSlow(g: number, suggested: string[], trace: TraceStep[], turn: Turn,
                         handover: string[] = [], fastReported = false, fastSpoke = false,
                         fastSaid = '', fastBusy = false): Promise<{ said: string; rounds: number; stop: TurnResult['stopReason'] }> {
    /**
     * 慢层复述静音（2026-08-17 实拍）。屏端同文去重逮不住换说法的复述
     * （「车窗已打开」→「窗户也打开了」），persona 的"说过的不许再说"
     * 小模型照样违反。判据是**系统状态**不是语义：快层已报过结果、
     * 慢层全程零业务调用 → 最终话术必是复述，不出声。
     * 文本仍落 thread（上下文）、仍进 trace（排查）。干了活照说不误。
     */
    let slowActed = false
    /** 出声权：快层没替系统说过话，或慢层干了新活（新信息该说）。单一决策点 */
    const canSpeak = () => !fastReported || slowActed
    let turnOk = 0   // 本 turn 业务成功数——空收场兜底的措辞靠它分"办成没说"和"没办成"
    const sm = deps.slowManifest
    const loaded = new Set<string>([...(sm.resident ?? []), ...suggested.map(n => registry.canonicalName(n)), ...sessionLoaded.keys()])
    /**
     * 冻结视图 + **视角改写**（2026-08-18 实拍）：thread 里快层的
     * NOT_AUTHORIZED 记录对慢层是假的——被拒的是快层，慢层全权。
     * 实拍证明一条鲜活的错误记录比末尾的 system 提示重得多（工具预载了、
     * 提示也在，慢层照样说"权限没给到"）。每层该看到自己视角下的真相：
     * 慢层视图里把它改写成转交语义。thread 原文不动（快层的历史是真的），
     * trace 照旧真实——这只改模型看到的，不改人排查看到的。
     */
    const view = thread.slice().map(m => {
      /**
       * 快层话术的读者视角注释（交互总设计 R3-①，实拍："导航得同事来搞"
       * 进了 thread，慢层信了真有第三方，导航一个没调还说"同事在搞了"）。
       * 原文不动（thread/trace 是历史），只在慢层的视图里点破。
       */
      if (m.role === 'assistant' && fastSaid && m.content === fastSaid)
        /**
         * 分两版（2026-08-25 实拍）：快层零业务零接力时它的话就是纯填充
         * （"稍等""我看看"），老文案的"没办完的事由你办完"凭空制造悬案——
         * 用户说"好的"，慢层跟着"稍等"就散场，create 从没被调。
         * 判据全是系统状态：动过业务工具（含失败——解释失败是实事）或有接力。
         */
        return { ...m, content: fastBusy || handover.length
          ? `【你的快手分身刚对用户说】"${fastSaid}"（它口中的"同事/转交"都是指你自己，没有别人；它没办完的事由你办完再收尾）`
          : `【你的快手分身刚应了一声】"${fastSaid}"（没有别人，也没有悬着的事——正常接着办用户这句话的事就好）` }
      if (m.role !== 'tool' || !String(m.content).includes('NOT_AUTHORIZED')) return m
      try {
        const r = JSON.parse(String(m.content))
        if (r.code !== 'NOT_AUTHORIZED') return m
        const tool = /调用\s*([\w.]+)/.exec(String(r.message ?? ''))?.[1]
        return { ...m, content: JSON.stringify({ status: 'handover',
          message: `这条是权限受限的快层分身被拒后转交的——你有权限${tool ? `，直接调 ${tool} 继续` : '，直接调同名工具继续'}` }) }
      } catch { return m }
    })
    // 接力清单显式化（R3-②）：快层没办完、点名由你办的工具，一行摆在眼前——
    // 收场时它还在视野里，"没下文"的概率大降
    if (handover.length)
      view.push({ role: 'system', content: `快层没办完、点名由你办的：${handover.join('、')}——办完（或说明办不了）再收尾` })
    /**
     * **接力棒必须看得见**（2026-08-17 实拍回归）。「整轮越权立刻转交」把
     * 快层第二轮省掉之后，thread 的最后一幕是「调工具 → NOT_AUTHORIZED」——
     * 慢层看到的是"这工具刚被拒"，不知道被拒的是**权限受限的快层**、
     * 自己有权限：实拍它先模仿快层去调 agent_handoff，再认输"我没权限"。
     *
     * 注入只进**本轮视图**不落 thread —— 它是运行时状态注释，不是对话事实。
     */
    // 措辞刻意不点名 agent.handoff —— 否定句里的工具名对小模型是正向引力：
    // 实拍（打开后备箱）提示里写着"别调它"，慢层第一轮偏偏就调了它。
    // 它真调了由下面的拦截器扶正（LAST_STOP），这里只说正道
    if (handover.length)
      view.push({ role: 'system', content:
        `刚才的 NOT_AUTHORIZED 是权限受限的快层同事被拒，不是你——` +
        `**你有权限**，工具已装进你手边：${handover.join('、')}。` +
        `直接调它把事办完，转交到你为止，不用再转给任何人。` })
    let rounds = 0
    while (rounds < sm.maxRounds) {
      rounds++
      const system = buildSystemPrompt(sm, store, registry, {
        catalog: registry.briefCatalog(),
        soloSlow: deps.fastEnabled?.() === false,   // 快层关着：没有分身要交代
      })
      // 易变态贴消息尾（三层化）：每轮现拼现贴、不进 view 本体——进了本体就成了
      // 会堆积的历史；贴在末尾则它永远是最后一条，消息前缀不被它打破
      const note = buildStateNote(sm, store, {
        desktop: deps.desktopSummary?.(), prefs: deps.prefsList?.(), recent: deps.recentSummary?.(),
        signalFilter: registry.signalsFor([...loaded]),
        agenda: agendaNow(),
      })
      const messages = note ? [...view, { role: 'system' as const, content: note }] : view.slice()
      const pEntry: TraceStep = { type: 'prompt', at: clock(), system, toolCount: loaded.size, layer: 'slow', view: messages.slice() }
      pEntry.stateChars = note.length
      trace.push(pEntry)
      // 最后一轮撤工具逼话术——语音场景没有"静默耗尽轮次"这个选项
      const last = rounds === sm.maxRounds
      const tools = last ? [] : [...registry.schemas('openai', [...loaded]), LOAD_SCHEMA, DELEGATE_SCHEMA, CANCEL_SCHEMA,
        AGENDA_SET_SCHEMA, AGENDA_CLEAR_SCHEMA,
        ...(sm.skills?.length ? [SKILL_SCHEMA] : [])]
      // schema 字数进 trace（2026-08-25：「注入 X 字」只显示 system，砍掉的
      // schema 优化看不见，用户以为没优化）
      pEntry.schemaChars = JSON.stringify(tools).length
      const tChat = clock()
      let reply
      try { reply = await deps.slowLlm.chat({ system, messages, tools }) }
      catch (e) {
        trace.push({ type: 'error', at: clock(), message: `慢层：${e}` })
        /**
         * 已被 barge-in 判 stale 的错误不冒泡（四条纪律第 3 条：已经作废的
         * 工作，副作用不该照样落地）。实拍：120s LLM 超时挂起在旧 turn 上，
         * 用户已经追问了下一句，等超时终于 reject 时把"出错了：TimeoutError"
         * 弹到了用户正在问的新一轮对话上——这条 catch 以前是全函数里唯一
         * 一处不看 stale(g) 就直接 emit 的地方，跟同一文件里其它收尾分支
         * （lateNote、空话术兜底）的纪律不一致。trace 仍然记录，供排查。
         */
        /**
         * 快层已办成事并报过话、且没有待接力的活（2026-08-25 实拍：开车窗
         * 成功+已播报"主驾车窗已全开"，慢层例行接力时 429，"出错了：模型
         * 限流"弹给了一个已经得到完整反馈的用户）——此时慢层的失败是内部
         * 事，静默收尾。判据全是系统状态：fastReported（说过且办成）+
         * handover 空（没有越权工具等慢层干）。接力清单非空时活还没人干，
         * 失败必须报。
         */
        if (!stale(g)) {
          if (fastReported && !handover.length) emit({ type: 'done' })   // 静默也要收尾
          else emit({ type: 'error', message: String(e) })
        }
        return { said: '', rounds, stop: 'error' }
      }

      ;(pEntry as any).llmMs = clock() - tChat
      ;(pEntry as any).llmReply = { text: reply.text, toolCalls: reply.toolCalls?.map(c => ({ name: c.name, args: c.args })) }
      if (!reply.toolCalls?.length) {
        // 注释回环（2026-08-25 实拍）：模型把视角注释原文当回复吐回来
        // （"【你的快手分身刚对用户说】…"整段上屏）。系统自己注入的标记
        // 出现在输出里就是回环——按空话术处理，让兜底或合法静默接住。
        // 同族（同日 pilot 实拍）：把【前情摘要】连任务 ID 整段念给用户——
        // 摘要标记起截掉，正常的前半句保留
        const raw = String(reply.text ?? '')
        const text = raw.includes('你的快手分身') ? ''
          : raw.includes(SUM_MARK) ? raw.slice(0, raw.indexOf(SUM_MARK)).trim() : raw
        if (text) commit(g, { role: 'assistant', content: text })
        trace.push({ type: 'reply', at: clock(), text, layer: 'slow' })
        const echo = !canSpeak()   // 快层报过、慢层没干活 → 复述（与工具闸同一谓词）
        /**
         * 空话术收场的兜底（2026-08-19 实拍）：automation 撞墙跳到最后一轮后
         * 模型交了白卷——整个 turn 没人对用户说过一个字，静默结束，用户干等
         * 2 分钟。快层说过话（闲聊/已报结果）时空收场是合法静默，不兜。
         */
        // 慢层这轮已经用 mic 工具播过（2026-08-25 实拍：plan ok + speak 都成了，
        // 兜底又追一句"没弄成"把成功现场说成失败）→ 空收场是合法静默
        if (!text && !echo && !fastSpoke && !turn.spoke() && !stale(g)) {
          const fb = turnOk > 0 ? '办好了，结果在屏幕上' : '这件事我没弄成，换个说法我再试试'
          trace.push({ type: 'reply', at: clock(), text: fb, layer: 'slow' })   // 兜底也要可观测
          emit({ type: 'speaking', text: fb, layer: 'slow' })
          emit({ type: 'done' })
          return { said: fb, rounds, stop: 'reply' }
        }
        if (stale(g)) {
          // 迟到的话术不抢麦：降级为横幅素材（§4.1）。活已经干完，成果都在
          if (text && !echo) emit({ type: 'lateNote', text })
        } else {
          if (text && !echo) emit({ type: 'speaking', text, layer: 'slow' })
          emit({ type: 'done' })
        }
        return { said: echo ? '' : text, rounds, stop: 'reply' }
      }

      const am = asstMsg(reply)
      commit(g, am); view.push(am)
      const outcome = await execRound(g, reply.toolCalls, sm.tools, trace, {
        /**
         * 慢层迷路时扶正（2026-08-16 实拍「打开后备箱」）：它会模仿共享 thread
         * 里快层的调用记录来调 agent.handoff，以前吃 UNKNOWN_TOOL 就放弃，
         * 嘴上让用户"在屏幕上点确认"——那个确认弹窗根本不存在。
         * 回执指路（SELF_FIX 不上横幅），下一轮把工具真调起来。
         */
        'agent.handoff': (): ToolResult => ({
          status: 'rejected', code: 'LAST_STOP',
          message: '转交到你为止，没有下一棒。要用的工具就在手边，直接调它把事办完',
          suggestion: '需要用户确认的工具，调了系统会自动在屏幕上弹确认',
        }),
        'tools.load': mkLoader(loaded),
        'skill.use': mkSkillUse(loaded),
        'agenda.set': (args: any): ToolResult => {
          const t = String(args?.text ?? '').trim().slice(0, 80)
          if (!t) return { status: 'rejected', code: 'INVALID_PARAMS', message: 'text 不能为空——写清在干什么、做到哪、下一步' }
          agendaText = t; agendaAt = runSeq
          return { status: 'ok', message: '记下了，之后每轮你都会在状态注入里看到这条议程' }
        },
        'agenda.clear': (): ToolResult => {
          agendaText = ''
          return { status: 'ok', message: '议程清了' }
        },
        'task.delegate': delegateInterceptor,
        'task.cancel': (args: any): ToolResult => {
          const t = taskPool.find(x => x.status === 'running' &&
            (x.id === args?.taskId || (args?.label && x.label.includes(args.label))))
          if (!t) return { status: 'rejected', code: 'TASK_NOT_FOUND', message: '没有对得上的在跑任务' }
          cancelTask(t.id)
          return { status: 'ok', message: `已取消：${t.label}` }
        },
      }, turn, { lane: 'slow', canSpeak })
      commit(g, ...outcome.toolMsgs); view.push(...outcome.toolMsgs)
      if (outcome.bizCalls > 0) slowActed = true   // 动过业务工具（含被拒——解释失败是新信息）
      turnOk += outcome.bizOk
      // voice.ask 成功 = 问题挂出去了：下一句输入是答案，直达慢层（状态分支不是意图分支）
      if (reply.toolCalls.some((c: any) => registry.canonicalName(c.name) === 'voice.ask') && outcome.bizOk > 0)
        askPending = true
      // 撞墙了：直接跳到最后一轮 —— 那一轮撤工具，模型只能说话。
      // 复用既有机制而不是新开一条"熔断"路径，收场仍然是一句人话
      if (turn.hitWall() && rounds < sm.maxRounds - 1) rounds = sm.maxRounds - 1
    }
    /**
     * 轮次耗尽而模型一句话没说 —— **沉默是最糟的收场**。
     * 实拍：连着 9 轮同一个错误，最后「无话术」，屏幕空白、Agent 不吭声，
     * 用户完全不知道发生了什么。
     *
     * 说什么归模型，但"这一轮没办成"是**系统事实**不是内容决策，
     * 兜一句诚实的，跟拒绝必须携带人话原因是同一条。
     */
    const fallback = '这件事我没弄成，换个说法我再试试'
    trace.push({ type: 'reply', at: clock(), text: fallback, layer: 'slow' })   // 兜底也要可观测
    if (!stale(g)) {
      emit({ type: 'speaking', text: fallback, layer: 'slow' })
      emit({ type: 'done' })
    }
    return { said: fallback, rounds, stop: 'maxRounds' }
  }

  let runSeq = 0
  /** 在飞的 run：文本 + 是否已产生副作用（首个业务调用时置真）。R1-① 吞并判据 */
  let inflight: { gen: number; text: string; userMsg: Msg } | null = null
  const actedGens = new Set<number>()
  async function run(text: string, runOpts: { answer?: boolean; source?: string } = {}): Promise<TurnResult> {
    const trace: TraceStep[] = []
    // run 可观测（交互总设计 R1-②）：每个 run 有唯一 id 与来源标签——
    // double-run、幽灵 run 从"疑似"变"看得见"
    const runId = `r${++runSeq}`
    decayLoaded()   // 闲置过久的装载退场——每个 run 入口扫一次
    const source = runOpts.source ?? (runOpts.answer ? 'tap-answer' : 'voice')
    // 空输入直接返回：送进模型它会凭空发挥（实测会无端开窗）
    if (!text.trim()) return { reply: '', trace, rounds: 0, stopReason: 'empty' }
    /**
     * 未起飞输入合并（交互总设计 R1-①，实拍两次整轮蒸发：讲故事第一句、
     * 24点游戏+美股）：前句 run 还没产生任何副作用就来了新句 → 吞并——
     * 旧孤立 user 消息撤掉，两句合并成一条明示"连说两句"。
     * 已在执行的仍按既有 stale 规则（活干完、不抢麦）。
     */
    if (inflight && !actedGens.has(inflight.gen)
        && thread[thread.length - 1] === inflight.userMsg) {
      thread.pop()
      text = `${inflight.text}（用户紧接着又说）${text}`
    }
    const g = ++gen
    // 每个 run 一份新 Turn：撞墙计数、打转熔断表都从零开始——
    // 跨 turn 的重复是新意愿，不拦；上一轮的墙不带过来
    const turn = createTurn()
    deps.onTurnStart?.()
    trace.push({ type: 'userInput', at: clock(), text, runId, source } as any)
    boundary = thread.length
    const userMsg: Msg = { role: 'user', content: text }
    thread.push(userMsg)
    inflight = { gen: g, text, userMsg }
    emit({ type: 'thinking' })

    // pending 确认直达慢层（§4.2）：快层不知道有确认挂着，接了必错。
    // 状态分支不是意图分支——看的是系统状态，不是话的内容
    const pending = registry.pendingConfirm()
    // voice.ask 挂着时同理：这句就是答案（或对问题的回避），快层无事可做。
    // 消费即清——答了或岔开都算翻篇，别让它劫持后面每一句
    const askJump = askPending
    askPending = false
    let fast = { suggested: [] as string[], said: '', rounds: 0, did: 0, bizCalls: 0, denied: [] as string[], allDenied: false }
    /**
     * 这一轮结束后，上一轮悬着的确认就该作废——用户已经说了别的。
     * 不清的话那个未过期的 token 会继续劫持输入路由满 60 秒（见到 pending
     * 就跳过快层直送慢层），用户会觉得"怎么突然每句话都变慢了"。
     * 放在 finally 里：无论这轮怎么结束都清。
     */
    /**
     * **本轮的错误边界。** 以前 runFast/runSlow 的 await 有一段在 try 之外
     * （execRound 里元工具拦截器的异常不经 registry.invoke 的 try/catch），
     * 异常一路穿透到调用方：既不 emit error 也不 emit done，avatar 永远停在
     * thinking，用户以为还在想，其实这一轮已经死了，只能刷新页面。
     * 一轮无论怎么结束，UI 都必须收到收尾事件。
     */
    try {
      let handover: string[] = []
      let fastReported = false
      if (runOpts.answer) {
        /**
         * 屏端合成的回答（点选候选/问题卡）直达慢层（设计 §4）：快层对
         * "第4个"无事可做——实拍它编造 placeId 去调无权工具白烧 3.6 秒。
         * 跟「pending 确认直达慢层」同族：输入来源是系统状态，不是意图。
         */
      } else if (!pending && !askJump && (deps.fastEnabled?.() ?? true)) {
        fast = await runFast(g, trace, turn)
        handover = fast.allDenied ? [...fast.denied] : []
        fastReported = !!fast.said && fast.did > 0
      } else if (pending) fast.suggested = [pending.tool]
      // askJump（无 pending）：不预载，慢层自己看上下文接答案

      const slow = await runSlow(g, fast.suggested, trace, turn, handover, fastReported, !!fast.said, fast.said,
        fast.did > 0 || fast.bizCalls > 0)
      // 压缩在回复送出之后才起跑——fire-and-forget，不占响应路径一毫秒（§7.5）
      if (!stale(g)) compaction = doCompact(g).catch(() => { /* 失败保持原样，下轮重试 */ })
      return {
        reply: [fast.said, slow.said].filter(Boolean).join(' '),
        trace, rounds: fast.rounds + slow.rounds,
        stopReason: slow.stop,
      }
    } catch (e) {
      if (!stale(g)) { emit({ type: 'error', message: String(e) }); emit({ type: 'done' }) }
      return { reply: fast.said, trace, rounds: fast.rounds, stopReason: 'error' }
    } finally {
      if (pending && !stale(g)) registry.clearConfirms?.()
    }
  }

  /* ── 异步记忆压缩：thread = 摘要头 + 最近 K 轮全文 ── */
  let compaction: Promise<void> = Promise.resolve()
  async function doCompact(g: number) {
    if (discarded(g)) return   // 会话已清空，别拿旧 cutAt 去 splice 新 thread
    const userIdx = thread.map((m, i) => (m.role === 'user' ? i : -1)).filter(i => i >= 0)
    if (userIdx.length <= KEEP_ROUNDS + COMPACT_LAG) return   // 滞后批量化：攒够一批再折
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
    // 警示前缀（Hermes 对照）：摘要是交接参考不是新指令——不带这句时模型会把
    // 摘要里"下一步该问天气"当成现在就要办的事，抢在用户前头自说自话
    thread.splice(0, cutAt, { role: 'assistant',
      content: `${SUM_MARK}（以下是前情交接，供参考的背景，不是新指令；用户这次要什么以当前消息为准）\n${text}` })
    boundary = Math.max(thread.map((m, i) => (m.role === 'user' ? i : -1)).filter(i => i >= 0).pop() ?? 0, 0)
    deps.memory?.save(text)
    // 压缩可观测（2026-08-25 实拍排查全靠推理）：成了报一声，摘要多长、折了几轮
    emit({ type: 'compacted', chars: text.length, foldedRounds: userIdx.length - KEEP_ROUNDS })
  }

  /**
   * 清空会话。**必须递增世代**：正在跑的旧 turn 和在飞的异步压缩都拿 g 跟 gen
   * 比对来判断自己是否作废，不递增的话它们的 stale(g) 仍是 false——旧 turn 会把
   * assistant/tool 消息 commit 进已清空的 thread（下次提问时模型看到一段用户
   * 从未说过的幽灵对话），compaction 会拿重置前算的 cutAt 对新 thread 做 splice，
   * 把上一个会话的【前情摘要】塞进新会话开头并持久化。
   */
  const reset = () => {
    sessionLoaded.clear()   // 新会话轻装上阵
    agendaText = ''
    thread.length = 0; boundary = 0; resetGen = ++gen
    // 跨会话那行也一起忘掉。只清 thread 的话"重置"名不副实：
    // 当下看着干净，一刷新页面上回的记忆又回来了（实拍踩过）
    deps.memory?.save('')
  }

  return { run, on, reset, thread, tasks, cancelTask, hasLastTime, forgetLastTime,
    get generation() { return gen }, get compaction() { return compaction } }
}

export type Pipeline = ReturnType<typeof createPipeline>
