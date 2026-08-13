import { describe, it, expect } from 'vitest'
import { createDesk } from '../../src/cards/desk'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'

/**
 * 校验闸下沉：卡片创建有三条路（规则 / Tool / handler 直调 desk），
 * 之前只有 Tool 那条过 checkSize —— 每加一个 handler 都是一个绕闸的机会。
 * 尺寸是**几何契约**，归 desk 管；desk 是唯一咽喉（空壳卡检查的先例）。
 */
describe('尺寸闸在 desk：三条路一个闸', () => {
  it('handler 直调 desk.show 传模板不支持的尺寸 → 拒绝', () => {
    const d = createDesk()
    // list 的下限是 card：chip 放不下一条带副标题的候选
    const r = d.show({ template: 'list', size: 'chip', ttl: 60,
      data: { title: '候选', items: [{ label: 'a' }] } })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('SIZE_NOT_SUPPORTED')
    expect(r.message, '报错要带人话').toMatch(/支持/)
  })

  it('desk.render（规则/handler 的刷新路径）同样被拦', () => {
    const d = createDesk()
    const r = d.render({ key: 'x', template: 'confirm', size: 'strip', ttl: 60,
      data: { title: 'q', question: '真的吗' } })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('SIZE_NOT_SUPPORTED')
  })

  it('desk.resize 也过同一个闸 —— reconcile 恢复时不会恢复出非法档', () => {
    const d = createDesk()
    const id = d.show({ template: 'list', size: '1/3', ttl: 60,
      data: { title: 'c', items: [{ label: 'a' }] } }).cardId!
    expect(d.resize(id, 'chip' as any, true).status).toBe('rejected')
  })

  /**
   * 归一化：'card' 和 '1/6' 是同一档的两个名字。模板声明用老名、
   * 调用方传新名（或反过来）必须互认 —— 裸字符串 includes 是踩过的坑
   * （LADDER.indexOf('1/3') = -1 那次）。
   */
  it("模板声明 '1/6'，传 'card' 也认", () => {
    const d = createDesk()
    const r = d.show({ template: 'list', size: 'card' as any, ttl: 60,
      data: { title: 'c', items: [{ label: 'a' }] } })
    expect(r.status).toBe('ok')
  })

  it("模板声明 'wide'（新名），传 'wide' 认、传乱写的不认", () => {
    const d = createDesk()
    expect(d.show({ template: 'list', size: 'wide' as any, ttl: 60,
      data: { title: 'c', items: [{ label: 'a' }] } }).status).toBe('ok')
    expect(d.show({ template: 'list', size: '巨大' as any, ttl: 60,
      data: { title: 'c', items: [{ label: 'a' }] } }).status).toBe('rejected')
  })
})

/**
 * 修实测 bug：像素契约向模型承诺了 2/3（1638×1044）与 full 的画布，
 * 但 canvas 模板没写 sizes 落到 COMMON_SIZES —— 模型按契约要 2/3
 * 被 SIZE_NOT_SUPPORTED 打回。**合同和门卫必须说同一套话。**
 */
describe('canvas 尺寸白名单开全档', () => {
  const mk = async () => {
    const store = createStore(SIGNALS, CONSTRAINTS)
    const desk = createDesk()
    const reg = createRegistry(store, TOOLS, Date.now, { desk })
    return reg
  }

  it('canvas 可用 2/3 竖向大块；full 被拒（覆盖层资格已取消）', async () => {
    const reg = await mk()
    const big = await reg.invoke('card.show', {
      template: 'canvas', size: '2/3', ttl: 'untilDismissed',
      data: { title: '对比', html: '<p>图</p>', text: '兜底' },
    })
    expect(big.status).toBe('ok')
    const fs = await reg.invoke('card.show', {
      template: 'canvas', size: 'full', ttl: 'untilDismissed',
      data: { title: '对比', html: '<p>图</p>', text: '兜底' },
    })
    expect(fs.status).toBe('rejected')
  })

  it('canvas 的模板 desc 与 sizes 白名单来自同一个数组 —— 不可能再打架', async () => {
    const { CARD_TEMPLATES } = await import('../../src/config/cards')
    const canvas = CARD_TEMPLATES.find(t => t.id === 'canvas')!
    expect(canvas.sizes).toBeTruthy()
    // desc 的像素契约至少覆盖白名单里的大档
    expect(canvas.desc).toContain('1/2')
  })

  // 产品裁定（2026-08-13 两轮定稿）：生成式卡**不进覆盖层**（full 禁）——
  // 但最大可到 2/3（stage 竖向大块，走桌面仲裁），游戏这类竖向内容靠它
  it('生成式卡：full 禁（不覆盖桌面）、2/3 是上限（竖向大块）', async () => {
    const { CARD_TEMPLATES } = await import('../../src/config/cards')
    for (const id of ['canvas', 'canvas-app']) {
      const t = CARD_TEMPLATES.find(x => x.id === id)!
      expect(t.sizes, `${id} 不许 full`).not.toContain('full')
      expect(t.sizes, `${id} 上限 2/3`).toContain('2/3')
      expect(t.sizes, `${id} 竖块 tower 可用`).toContain('tower')
    }
    const store = createStore(SIGNALS, CONSTRAINTS)
    const reg2 = createRegistry(store, TOOLS, Date.now, { desk: createDesk() })
    const r = await reg2.invoke('card.show', { template: 'canvas', size: 'full',
      ttl: 'untilDismissed', data: { title: 'x', html: '<p>1</p>', text: 'x' } })
    expect(r.status).toBe('rejected')
  })

  it('模板 desc 教"按内容形状选尺寸"——游戏竖向内容指向 2/3', async () => {
    const { CARD_TEMPLATES } = await import('../../src/config/cards')
    const app = CARD_TEMPLATES.find(x => x.id === 'canvas-app')!
    expect(app.desc).toContain('2/3')
    expect(app.desc).toMatch(/竖/)
  })
})
