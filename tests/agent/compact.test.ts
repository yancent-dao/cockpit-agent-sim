import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { createPipeline } from '../../src/agent/pipeline'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'
import { MAIN_AGENT } from '../../agents/main-agent/manifest'
import { FAST_AGENT } from '../../agents/main-agent/fast'
import type { LLM, LLMRequest, LLMReply } from '../../src/agent/llm'

/**
 * 异步分层记忆（设计文档 §7.5）：
 * thread = [ epoch 摘要（含实体索引）] + 最近 K=4 轮全文。
 * 压缩在回复送出**之后**由小模型后台跑——响应路径零占用。
 * "上回说到"落盘，下次会话接得上。
 */

function scriptedLLM(fn: (req: LLMRequest, n: number) => LLMReply | Promise<LLMReply>) {
  const seen: LLMRequest[] = []
  return {
    seen,
    async chat(req: LLMRequest) { seen.push(req); return fn(req, seen.length) },
    async models() { return [] },
  } as LLM & { seen: LLMRequest[] }
}

let store: ReturnType<typeof createStore>
let reg: ReturnType<typeof createRegistry>
beforeEach(() => {
  store = createStore(SIGNALS, CONSTRAINTS)
  reg = createRegistry(store, TOOLS)
})

const memStore = () => {
  let v: string | null = null
  return { load: () => v, save: (t: string) => { v = t }, get: () => v }
}

/** 快层答一句、慢层沉默的最小管线；压缩请求也走 fastLlm（它就是那个小模型） */
const mk = (opts: { memory?: ReturnType<typeof memStore>; compactReply?: (req: LLMRequest) => LLMReply } = {}) => {
  const fast = scriptedLLM(req => {
    // 压缩请求没有 tools 且 system 带摘要指令——用这个特征区分（测试侧的判定，不是产品逻辑）
    if (!req.tools?.length && req.system.includes('前情摘要'))
      return opts.compactReply?.(req) ?? { text: '聊过空调和导航。\n提到过：天府广场、周杰伦' }
    return { text: '好' }
  })
  const slow = scriptedLLM(() => ({ text: '' }))
  const p = createPipeline({
    registry: reg, store, fastLlm: fast, slowLlm: slow,
    fastManifest: FAST_AGENT, slowManifest: MAIN_AGENT, memory: opts.memory,
  })
  return { p, fast, slow }
}

describe('K 轮滑动窗口 + epoch 摘要', () => {
  it('超过 6 轮后旧轮次折叠成摘要头，最近 6 轮保持全文（2026-08-25 从 4 上调：拿一点 token 换记忆窗口）', async () => {
    const { p } = mk()
    for (const s of ['一', '二', '三', '四', '五', '六', '七', '八']) await p.run(`第${s}句`)
    await p.compaction
    const users = p.thread.filter(m => m.role === 'user').map(m => m.content)
    expect(users.length).toBeLessThanOrEqual(6)
    expect(users).toContain('第八句')
    expect(p.thread[0].role).toBe('assistant')
    expect(p.thread[0].content).toContain('前情摘要')
    expect(p.thread[0].content, '摘要含实体索引行').toContain('提到过')
  })

  it('6 轮以内不压缩——短对话不花这笔钱', async () => {
    const { p, fast } = mk()
    for (const s of ['一', '二', '三', '四', '五']) await p.run(`第${s}句`)
    await p.compaction
    expect(fast.seen.filter(r => r.system.includes('前情摘要'))).toHaveLength(0)
  })

  it('压缩不占响应路径：run 返回时话术已出，压缩晚于它', async () => {
    const { p } = mk()
    for (const s of ['一', '二', '三', '四', '五', '六', '七']) await p.run(`第${s}句`)
    // run 已全部返回，此刻压缩可能仍在跑——thread 里的用户轮次仍可能超窗
    await p.compaction
    expect(p.thread.filter(m => m.role === 'user').length).toBeLessThanOrEqual(6)
  })
})

describe('压缩的健壮性', () => {
  it('压缩失败保持原样，不丢一条消息', async () => {
    const { p } = mk({ compactReply: () => { throw new Error('小模型挂了') } })
    for (const s of ['一', '二', '三', '四', '五', '六', '七']) await p.run(`第${s}句`)
    const before = p.thread.length
    await p.compaction
    expect(p.thread.length).toBe(before)
    expect(p.thread.filter(m => m.role === 'user')).toHaveLength(7)
  })

  it('压缩期间用户开口 → 放弃本次，thread 不被旧压缩改写', async () => {
    let release!: (r: LLMReply) => void
    const gate = new Promise<LLMReply>(res => { release = res })
    let first = true
    const { p } = mk({ compactReply: () => {
      if (first) { first = false; return gate as any }   // 第一次压缩挂住
      return { text: '新的摘要\n提到过：无' }              // 新 turn 的重压正常
    } })
    for (const s of ['一', '二', '三', '四', '五']) await p.run(`第${s}句`)
    const t6 = p.run('第六句')                    // 压缩还挂着，新 turn 来了
    release({ text: '过期的摘要' })
    await t6; await p.compaction
    expect(p.thread[0]?.content ?? '', '过期摘要不落盘').not.toContain('过期的摘要')
  })
})

describe('上回说到：跨会话一行', () => {
  it('压缩时顺手落盘', async () => {
    const memory = memStore()
    const { p } = mk({ memory })
    for (const s of ['一', '二', '三', '四', '五', '六', '七']) await p.run(`第${s}句`)
    await p.compaction
    expect(memory.get()).toContain('空调')
  })

  it('新会话启动注入上回摘要，慢层看得见', async () => {
    const memory = memStore()
    memory.save('聊过去天府广场的路线')
    const { p, slow } = mk({ memory })
    await p.run('接着昨天那个')
    expect(p.thread[0].content).toContain('天府广场')
    const msgs = slow.seen[0].messages
    expect(msgs[0].content).toContain('天府广场')
  })
})

describe('操作史必须活过压缩（2026-08-25 实拍：「我刚才对空调的操作是什么」答「没操作过」——旧提示词只留结论与未完成的事，已办完的操作被判可丢）', () => {
  it('压缩提示词要求保留做过的操作清单', async () => {
    const { p, fast } = mk()
    for (const s of ['一', '二', '三', '四', '五', '六', '七']) await p.run(`第${s}句`)
    await p.compaction
    const req = fast.seen.find(r => r.system.includes('前情摘要'))!
    expect(req.system).toMatch(/做过|操作|执行/)
    expect(req.system).toMatch(/次序|顺序|时间/)
  })

  it('压缩完成 emit compacted 事件——不再盲飞', async () => {
    const { p } = mk()
    const events: any[] = []
    p.on(e => events.push(e))
    for (const s of ['一', '二', '三', '四', '五', '六', '七']) await p.run(`第${s}句`)
    await p.compaction
    const c = events.find(e => e.type === 'compacted')
    expect(c).toBeTruthy()
    expect(c.chars).toBeGreaterThan(0)
  })
})
