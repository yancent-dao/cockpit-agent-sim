import { describe, it, expect } from 'vitest'
import { createPrefs } from '../../src/state/prefs'
import { recentSummary } from '../../src/state/session'
import { createDomainState } from '../../src/state/domain'
import { createStore } from '../../src/core/store'
import { createDesk } from '../../src/cards/desk'
import { createRegistry } from '../../src/tools/registry'
import { buildSystemPrompt } from '../../src/agent/context'
import { MAIN_AGENT } from '../../agents/main-agent/manifest'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'

/**
 * 长期记忆：**显式记忆，不做自动学习**。
 * 显式记忆是数据（用户说"记住"就存一条），自动学习是策略——
 * 策略进代码违反"不许意图分支"。
 * 解 工程手册 已知待办的一半：Agent 从"这车不会记"变成"记住了，以后都这样"。
 */

const fakeStorage = () => {
  const m: Record<string, string> = {}
  return { get: (k: string) => m[k] ?? null, set: (k: string, v: string) => { m[k] = v } }
}

describe('偏好仓：持久化的显式记忆', () => {
  it('记一条，刷新还在', () => {
    const st = fakeStorage()
    createPrefs(st, () => 1000).remember('空调默认 24 度')
    expect(createPrefs(st, () => 2000).list().map(p => p.text)).toContain('空调默认 24 度')
  })

  it('忘掉按内容模糊匹配——用户不会一字不差复述', () => {
    const p = createPrefs(fakeStorage(), () => 0)
    p.remember('出风别对着脸吹')
    expect(p.forget('对着脸')).toBe(true)
    expect(p.list()).toHaveLength(0)
    expect(p.forget('不存在的')).toBe(false)
  })

  it('重复内容不追加', () => {
    const p = createPrefs(fakeStorage(), () => 0)
    p.remember('空调 24')
    expect(p.remember('空调 24')).toBe(false)
    expect(p.list()).toHaveLength(1)
  })
})

describe('memory.* 三件 Tool', () => {
  const boot = () => {
    const store = createStore(SIGNALS, CONSTRAINTS)
    const desk = createDesk()
    const prefs = createPrefs(fakeStorage(), () => 1000)
    const reg = createRegistry(store, TOOLS, Date.now, { desk, prefs })
    return { reg, desk, prefs }
  }

  it('remember 落仓 + 复述确认', async () => {
    const { reg, prefs } = boot()
    const r = await reg.invoke('memory.remember', { text: '以后空调默认 24 度' })
    expect(r.status).toBe('ok')
    expect(r.message).toContain('24')
    expect(prefs.list()).toHaveLength(1)
  })

  it('list 上屏一张列表卡', async () => {
    const { reg, desk } = boot()
    await reg.invoke('memory.remember', { text: '别对着脸吹' })
    await reg.invoke('memory.list', {})
    const card = desk.layout().cards.find(c => c.template === 'list' && c.key === 'memory')
    expect(card).toBeTruthy()
    expect(card!.data.items[0].label).toContain('脸')
  })

  it('forget 模糊匹配删除', async () => {
    const { reg, prefs } = boot()
    await reg.invoke('memory.remember', { text: '出风别对着脸吹' })
    const r = await reg.invoke('memory.forget', { text: '对着脸' })
    expect(r.status).toBe('ok')
    expect(prefs.list()).toHaveLength(0)
  })
})

describe('注入：偏好进 system，注入的是结论不是原始数据', () => {
  it('偏好列进 system prompt', () => {
    const store = createStore(SIGNALS, CONSTRAINTS)
    const reg = createRegistry(store, TOOLS, Date.now, {})
    const prefs = createPrefs(fakeStorage(), () => 0)
    prefs.remember('空调默认 24 度')
    const sys = buildSystemPrompt(MAIN_AGENT, store, reg, { prefs: prefs.list().map(p => p.text) })
    expect(sys).toContain('空调默认 24 度')
    expect(sys).toMatch(/偏好/)
  })

  it('偏好封顶 10 条，超出取最近——注入有预算', () => {
    const store = createStore(SIGNALS, CONSTRAINTS)
    const reg = createRegistry(store, TOOLS, Date.now, {})
    const texts = Array.from({ length: 15 }, (_, i) => `偏好${i}`)
    const sys = buildSystemPrompt(MAIN_AGENT, store, reg, { prefs: texts })
    expect(sys).toContain('偏好14')
    expect(sys).not.toContain('偏好0')
  })

  it('会话摘要：最近放过/查过压成一两行', () => {
    const d = createDomainState({ get: () => null, set: () => {} })
    d.history.push({ source: 'music', track: '晴天', artist: '周杰伦', streamUrl: 'u' })
    d.queries.push({ kind: 'weather', entity: '成都', brief: '31° 多云' })
    const lines = recentSummary(d)
    expect(lines).toContain('晴天')
    expect(lines).toContain('成都')
    expect(lines.split('\n').length).toBeLessThanOrEqual(3)
  })
})
