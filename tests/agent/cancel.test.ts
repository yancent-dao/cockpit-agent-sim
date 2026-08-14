import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { createPipeline, type PipelineEvent } from '../../src/agent/pipeline'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'
import { MAIN_AGENT } from '../../agents/main-agent/manifest'
import { FAST_AGENT } from '../../agents/main-agent/fast'
import type { LLM, LLMRequest, LLMReply } from '../../src/agent/llm'

/**
 * ══════════ 异步取消语义（2026-08-14 代码审查·第 3 组） ══════════
 *
 * 审查确认的一组问题共享同一个根因：**已经被判定作废的工作，其副作用照样落地**。
 * 超时只放弃等待不取消、reset 不递增世代、子 Agent 的事件不带来源——
 * 于是"超时后导航突然开始""重置后幽灵对话复活""后台任务的横幅弹到当前对话上"。
 */

const scripted = (fn: (req: LLMRequest, n: number) => LLMReply | Promise<LLMReply>) => {
  const seen: LLMRequest[] = []
  return { seen, async chat(req: LLMRequest) { seen.push(req); return fn(req, seen.length) },
    async models() { return [] } } as LLM & { seen: LLMRequest[] }
}

let store: ReturnType<typeof createStore>
let reg: ReturnType<typeof createRegistry>
beforeEach(() => {
  store = createStore(SIGNALS, CONSTRAINTS)
  reg = createRegistry(store, TOOLS)
})

const mk = (slowFn: (req: LLMRequest, n: number) => LLMReply | Promise<LLMReply>,
            fastFn: (req: LLMRequest, n: number) => LLMReply | Promise<LLMReply> = () => ({ text: '' })) => {
  const fast = scripted(fastFn)
  const slow = scripted(slowFn)
  const events: PipelineEvent[] = []
  const p = createPipeline({
    registry: reg, store, fastLlm: fast, slowLlm: slow,
    fastManifest: FAST_AGENT, slowManifest: MAIN_AGENT,
  })
  p.on(e => events.push(e))
  return { p, fast, slow, events }
}

/**
 * reset() 只清 thread 和 boundary，不递增 gen——正在跑的旧 turn 和在飞的
 * 异步压缩，其 stale(g) 判定仍为 false，会继续把消息 commit / splice 进
 * 本该空白的新会话：用户点了"重置会话"，下次提问时模型却看到一段
 * 自己从未说过的幽灵对话，或者上一个会话的【前情摘要】被塞回开头。
 */
describe('reset() 必须作废在飞的旧工作', () => {
  it('重置后，正在跑的旧 turn 不再往新会话里写消息', async () => {
    let release: (r: LLMReply) => void
    const gate = new Promise<LLMReply>(res => { release = res })
    const { p } = mk((_req, n) => (n === 1 ? gate : { text: '完事' }))

    const running = p.run('查个天气')          // 旧 turn 卡在第一次 LLM 调用上
    await new Promise(r => setTimeout(r, 0))
    p.reset()                                   // 用户点了"重置会话"
    release!({ text: '旧回答' })
    await running.catch(() => {})
    await new Promise(r => setTimeout(r, 0))

    // 新会话必须干净：旧 turn 的产物一条都不该在里面
    expect(p.thread.length, `重置后线程应为空，实际：${JSON.stringify(p.thread)}`).toBe(0)
  })
})

/**
 * 同步 task.delegate 的错误没人接：delegateInterceptor 的非 background 分支
 * `return subRun().then().finally()` 没有 .catch，subRun 内的 slowLlm.chat 也没有 try，
 * 而 execRound 里元工具拦截器的 await 在 registry.invoke 的 try/catch 之外——
 * 异常一路穿透到 run()，既不 emit error 也不 emit done，
 * avatar 永远停在 thinking，用户以为还在想，其实这一轮已经死了。
 */
describe('任何一轮都要收尾：不许既不报错也不结束', () => {
  it('同步子 Agent 抛错时，本轮仍然 emit done（UI 不会卡在 thinking）', async () => {
    const { p, events } = mk((_req, n) => {
      if (n === 1) return { text: '', toolCalls: [{ id: 'c1', name: 'task_delegate', args: { goal: '查行情' } }] }
      throw new Error('子 Agent 的 LLM 挂了')   // 子 Agent 第一轮就炸
    })
    await p.run('帮我查个行情').catch(() => {})
    expect(events.some(e => e.type === 'done' || e.type === 'error'),
      `必须有收尾事件，实际事件：${events.map(e => e.type).join(',')}`).toBe(true)
  })

  it('子 Agent 抛错不会让 run() 整体 reject', async () => {
    const { p } = mk((_req, n) => {
      if (n === 1) return { text: '', toolCalls: [{ id: 'c1', name: 'task_delegate', args: { goal: 'x' } }] }
      throw new Error('炸了')
    })
    await expect(p.run('x')).resolves.toBeDefined()
  })
})

/**
 * execRound 的 emit 既不看世代也不看来源（g 参数在函数体里根本没被用过）：
 * 后台子 Agent 的工具被业务规则拒绝时，会往**当前对话**弹一条红色拒绝横幅，
 * 用户正在进行的对话被一条跟上下文毫无关系的解释打断，且无从知道它来自哪个后台任务。
 */
describe('后台任务的拒绝不该打断当前对话', () => {
  it('后台子 Agent 的工具拒绝不往当前 UI 弹 rejected', async () => {
    // 主/子 Agent 的 LLM 调用会交错，不能按调用序号分支——用 system prompt 判别
    let subCalls = 0
    let mainCalls = 0
    const { p, events } = mk(req => {
      const isSub = req.system.includes('子任务模式')
      if (isSub) {
        subCalls++
        // 子 Agent：调一个必然被拒的工具（未选装的天窗）
        return subCalls === 1
          ? { text: '', toolCalls: [{ id: 'c2', name: 'sunroof_set', args: { position: 50 } }] }
          : { text: '查完了' }
      }
      mainCalls++
      return mainCalls === 1
        ? { text: '', toolCalls: [{ id: 'c1', name: 'task_delegate', args: { goal: '查行情', background: true } }] }
        : { text: '在查了' }
    })
    await p.run('后台查个行情')
    await new Promise(r => setTimeout(r, 20))
    const rejects = events.filter(e => e.type === 'rejected')
    expect(rejects.length, `后台任务的拒绝不该弹到当前对话，实际弹了 ${rejects.length} 条`).toBe(0)
  })
})

/**
 * 跨会话记忆的可控性（2026-08-14 实拍：用户说"打开车窗、打开空调、你有哪些功能"，
 * Agent 却接着上个会话的话头问"你要去哪个充电站"）。
 *
 * 根因是 pipeline 一创建就把 localStorage 里的上回摘要压进 thread 第 0 条。
 * 三条都得治：
 *   ① 它以 assistant 角色注入——模型看到的是"这是我自己刚说过的话"，
 *      牵引力远强于一条背景说明，宁可接着讲充电站也不理当前的三个明确指令
 *   ② reset() 不碰它，用户点了"重置会话"当下是干净的，一刷新它又回来了
 *   ③ 用户完全看不见自己带着上回的记忆，出了事只能翻代码才明白
 */
describe('跨会话记忆：注入得克制，清得掉，看得见', () => {
  const withMemory = (saved: string | null) => {
    const store2 = createStore(SIGNALS, CONSTRAINTS)
    const reg2 = createRegistry(store2, TOOLS)
    let mem = saved
    const p = createPipeline({
      registry: reg2, store: store2,
      fastLlm: scripted(() => ({ text: '' })), slowLlm: scripted(() => ({ text: 'ok' })),
      fastManifest: FAST_AGENT, slowManifest: MAIN_AGENT,
      memory: { load: () => mem, save: t => { mem = t } },
    })
    return { p, readMem: () => mem }
  }

  it('上回摘要以 system 角色注入，不冒充模型自己说过的话', () => {
    const { p } = withMemory('用户在找沿途的充电站')
    const first = p.thread[0]
    expect(first, '带记忆时该有第 0 条').toBeTruthy()
    expect(first.role, `实际角色：${first.role}`).toBe('system')
  })

  it('注入的文字要写明"以当前请求为准"，不然模型会接着上回讲', () => {
    const { p } = withMemory('用户在找沿途的充电站')
    expect(p.thread[0].content).toContain('用户在找沿途的充电站')
    expect(p.thread[0].content, '得明说这只是背景').toMatch(/当前|这次|以.*为准/)
  })

  it('没有上回记忆时不凭空塞消息', () => {
    const { p } = withMemory(null)
    expect(p.thread.length).toBe(0)
  })

  it('forgetLastTime() 把跨会话那行也清掉——刷新后不会再回来', () => {
    const { p, readMem } = withMemory('用户在找沿途的充电站')
    expect(p.thread.length).toBe(1)
    p.forgetLastTime()
    expect(p.thread.length, '当前会话里的也清掉').toBe(0)
    expect(readMem(), '持久化的那份也清掉').toBeFalsy()
  })

  it('hasLastTime() 让界面能显示"当前带着上回的记忆"', () => {
    expect(withMemory('上回的事').p.hasLastTime()).toBe(true)
    expect(withMemory(null).p.hasLastTime()).toBe(false)
  })
})
