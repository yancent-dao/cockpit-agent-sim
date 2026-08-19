import { describe, it, expect, vi } from 'vitest'
import { createScheduler } from '../../src/agent/scheduler'

/**
 * Scheduler = run() 的唯一准入入口（R-2，调度与呈现重构方案 §03）。
 *
 * 动机是一个真实存在的 bug：director.ts 里 automation 触发的 `ask()`
 * 调用没有打 source 标签（默认落 'voice'），而 storyChapterDone 甚至绕开
 * `ask()` 直接裸调 `pipeline.run()`——两条路径都能在用户正说着话的时候
 * 抢着调 pipeline.run，而 pipeline 内部每次 run() 都会 `++gen` 让上一个
 * 还没跑完的 run 立刻变 stale。系统事件因此能打断一个真实用户的对话。
 *
 * Scheduler 不改 pipeline 的 barge-in 语义（同优先级之间抢麦是设计好的
 * 常态），只管**跨优先级**：语音/点选（用户）永远立即执行；系统事件/
 * 自动化永远排队等所有在跑的用户回合结束才轮到自己。
 */

const wait = (ms = 0) => new Promise(r => setTimeout(r, ms))

/** 只有第一次调用是手动控制何时 resolve；之后每次调用立即 resolve——
 * 用来摆出"用户回合还没结束"这一个时间窗，同时让排队里的项能自然依次流转 */
function deferredFirstRun() {
  const calls: Array<{ text: string; opts: any }> = []
  let first = true
  let resolveFirst: ((v: any) => void) | null = null
  const run = vi.fn((text: string, opts: any) => {
    calls.push({ text, opts })
    if (first) { first = false; return new Promise(res => { resolveFirst = res }) }
    return Promise.resolve({ reply: 'ok' })
  })
  return { run, calls, resolveFirst: (v: any = { reply: 'ok' }) => resolveFirst!(v) }
}

describe('Scheduler：同优先级抢麦语义不变', () => {
  it('voice/tap-answer 永远立即执行，不排队', async () => {
    const { run, calls } = deferredFirstRun()
    const sch = createScheduler(run)
    sch.submit('第一句', { source: 'voice' })
    await wait()
    sch.submit('插一句', { source: 'tap-answer' })
    await wait()
    expect(calls.map(c => c.text)).toEqual(['第一句', '插一句'])
  })
})

describe('Scheduler：系统/自动化排队等用户回合结束', () => {
  it('用户回合在跑时，automation 请求先排队，不立即调用底层 run', async () => {
    const { run, calls, resolveFirst } = deferredFirstRun()
    const sch = createScheduler(run)
    sch.submit('用户在说话', { source: 'voice' })
    sch.submit('[自动任务] 开空调', { source: 'automation' })
    await wait()
    expect(calls.map(c => c.text)).toEqual(['用户在说话'])   // automation 还没被调用
    resolveFirst()
    await wait()
    expect(calls.map(c => c.text)).toEqual(['用户在说话', '[自动任务] 开空调'])
  })

  it('用户回合在跑时，system:* 请求同样排队', async () => {
    const { run, calls, resolveFirst } = deferredFirstRun()
    const sch = createScheduler(run)
    sch.submit('用户在说话', { source: 'voice' })
    sch.submit('章末唤醒', { source: 'system:chapterDone' })
    await wait()
    expect(calls).toHaveLength(1)
    resolveFirst()
    await wait()
    expect(calls.map(c => c.text)).toEqual(['用户在说话', '章末唤醒'])
  })

  it('没有用户回合在跑时，system/automation 直接执行，不无谓等待', async () => {
    const { run, calls } = deferredFirstRun()
    const sch = createScheduler(run)
    sch.submit('[自动任务] 开空调', { source: 'automation' })
    await wait()
    expect(calls.map(c => c.text)).toEqual(['[自动任务] 开空调'])
  })
})

describe('Scheduler：排队内部按优先级，不是纯 FIFO', () => {
  it('automation 先排队，system:* 后到——system:* 优先级更高，先执行', async () => {
    const { run, calls, resolveFirst } = deferredFirstRun()
    const sch = createScheduler(run)
    sch.submit('用户在说话', { source: 'voice' })
    sch.submit('[自动任务]', { source: 'automation' })
    sch.submit('章末唤醒', { source: 'system:chapterDone' })
    resolveFirst()
    await wait()
    expect(calls.map(c => c.text)).toEqual(['用户在说话', '章末唤醒', '[自动任务]'])
  })

  it('同优先级排队按先来后到', async () => {
    const { run, calls, resolveFirst } = deferredFirstRun()
    const sch = createScheduler(run)
    sch.submit('用户在说话', { source: 'voice' })
    sch.submit('自动任务A', { source: 'automation' })
    sch.submit('自动任务B', { source: 'automation' })
    resolveFirst()
    await wait()
    expect(calls.map(c => c.text)).toEqual(['用户在说话', '自动任务A', '自动任务B'])
  })
})

describe('Scheduler：结果透传', () => {
  it('submit 的返回值就是底层 run 的返回值', async () => {
    const run = vi.fn(async (text: string) => ({ reply: `echo:${text}` }))
    const sch = createScheduler(run)
    const r = await sch.submit('你好', { source: 'voice' })
    expect(r).toEqual({ reply: 'echo:你好' })
  })

  it('底层 run 拒绝时，submit 的 promise 也拒绝', async () => {
    const run = vi.fn(async () => { throw new Error('挂了') })
    const sch = createScheduler(run)
    await expect(sch.submit('x', { source: 'voice' })).rejects.toThrow('挂了')
  })

  it('排队的调用同样透传拒绝，且不卡住队列', async () => {
    const { run: userRun, resolveFirst } = deferredFirstRun()
    const sch = createScheduler(async (text: string, opts: any) => {
      if (opts.source === 'automation') throw new Error('自动任务挂了')
      return userRun(text, opts)
    })
    const userP = sch.submit('用户在说话', { source: 'voice' })
    const autoP = sch.submit('自动任务', { source: 'automation' })
    resolveFirst()
    await expect(userP).resolves.toBeDefined()
    await expect(autoP).rejects.toThrow('自动任务挂了')
  })
})

describe('Scheduler：source 缺省时按 answer 推断（对齐 pipeline.run 既有约定）', () => {
  it('不给 source 但 answer:true → 当 tap-answer（优先级最高，立即执行）', async () => {
    const { run, calls } = deferredFirstRun()
    const sch = createScheduler(run)
    sch.submit('用户在说话', {})
    await wait()
    sch.submit('第4个', { answer: true })
    await wait()
    expect(calls.map(c => c.text)).toEqual(['用户在说话', '第4个'])
  })
})
