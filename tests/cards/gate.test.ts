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

  it('canvas 可以要 2/3 的大画布', async () => {
    const reg = await mk()
    const r = await reg.invoke('card.show', {
      template: 'canvas', size: '2/3', ttl: 'untilDismissed',
      data: { title: '对比', html: '<p>图</p>', text: '兜底' },
    })
    expect(r.status).toBe('ok')
  })

  it('canvas 的模板 desc 与 sizes 白名单来自同一个数组 —— 不可能再打架', async () => {
    const { CARD_TEMPLATES } = await import('../../src/config/cards')
    const canvas = CARD_TEMPLATES.find(t => t.id === 'canvas')!
    expect(canvas.sizes).toBeTruthy()
    // desc 里承诺的每一档都在白名单里
    for (const z of ['2/3', 'full']) expect(canvas.sizes).toContain(z)
    // desc 的像素契约至少覆盖白名单里的大档
    expect(canvas.desc).toContain('2/3')
  })
})
