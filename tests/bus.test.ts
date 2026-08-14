import { describe, it, expect } from 'vitest'
import { createDedupe, DEDUPE_CAP } from '../src/bus'

/**
 * 跨窗口消息去重（2026-08-14 代码审查）。
 *
 * send() 同时向 peer / opener / BroadcastChannel 三条通道投递同一条消息，
 * 而接收端 window 的 'message' 事件与 bc.onmessage 挂的是同一个 handle——
 * 同源 dev 环境（window.open 打开车机屏，正是日常演示的用法）下每条消息
 * 对端会收到两次。后果不是"闪一下"级别的：
 *   · 用户在屏上点一次「下一曲」→ media.control 被 invoke 两次 → 一次点击跳两首歌
 *   · 点尺寸按钮 → desk.step 走两档
 *   · 点关闭 → desk.dismiss 调两次
 * 消息带 id、接收端记住最近见过的 id 即可。放这里做纯函数是因为 createBus
 * 依赖 window/BroadcastChannel，node 测试环境跑不起来。
 */
describe('bus 消息去重：一条消息只该被处理一次', () => {
  it('同一个 id 第二次到达判为重复', () => {
    const dup = createDedupe()
    expect(dup('a1'), '第一次见，放行').toBe(false)
    expect(dup('a1'), '第二次见，丢弃').toBe(true)
  })

  it('不同 id 互不影响', () => {
    const dup = createDedupe()
    expect(dup('a1')).toBe(false)
    expect(dup('a2')).toBe(false)
    expect(dup('a1')).toBe(true)
  })

  // 兼容：没有 id 的消息（外部来源、旧版本页面）一律放行，
  // 宁可重复也不能把正常消息吞掉
  it('没有 id 的消息一律放行，不参与去重', () => {
    const dup = createDedupe()
    expect(dup(undefined)).toBe(false)
    expect(dup(undefined)).toBe(false)
    expect(dup('')).toBe(false)
  })

  // 长会话下不能无界增长——记住的 id 有上限，老的自然淘汰
  it('记忆有上限，超出后最老的 id 被淘汰（不会无限增长）', () => {
    const dup = createDedupe()
    for (let i = 0; i < DEDUPE_CAP; i++) dup(`m${i}`)
    expect(dup(`m${DEDUPE_CAP - 1}`), '刚见过的还记得').toBe(true)
    dup('新消息')                                   // 挤掉最老的 m0
    expect(dup('m0'), '最老的已被淘汰，重新放行').toBe(false)
  })
})
