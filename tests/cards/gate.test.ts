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
  /**
   * 2026-08-25 语义修订（pilot 两次实拍：模型给攻略卡传 frame、又传 tile，
   * 章法写了"size 不用传"还是传）：**建卡时 size 是三层优先级里最弱的
   * "建议"层**（物理>意愿>建议），一个不合法的建议合理的处置是落到
   * 模板默认档继续把卡建出来，不是整个调用拒掉让模型自纠白烧一轮。
   * resize（用户意愿层）保持拒绝——那是明确指令，错了要说。
   */
  it('handler 直调 desk.show 传模板不支持的尺寸 → 落到默认档照建，附说明', () => {
    const d = createDesk()
    // list 的下限是 box：chip 放不下一条带副标题的候选
    const r = d.show({ template: 'list', size: 'chip' as any, ttl: 60,
      data: { title: '候选', items: [{ label: 'a' }] } })
    expect(r.status).toBe('ok')
    const card = d.get((r as any).cardId)!
    expect(card.size).not.toBe('chip')
    expect(String((r as any).note ?? ''), '降级说明要带人话，模型看得见才不会下次还传').toContain('chip')
  })

  it('desk.render（规则/handler 的刷新路径）同样降级不拒', () => {
    const d = createDesk()
    const r = d.render({ key: 'x', template: 'confirm', size: 'chip' as any, ttl: 60,
      data: { title: 'q', question: '真的吗' } })
    expect(r.status).toBe('ok')
    expect(d.findByKey('x')!.size).not.toBe('chip')
  })

  it('desk.resize 也过同一个闸 —— reconcile 恢复时不会恢复出非法档', () => {
    const d = createDesk()
    const id = d.show({ template: 'list', size: 'tower', ttl: 60,
      data: { title: 'c', items: [{ label: 'a' }] } }).cardId!
    expect(d.resize(id, 'chip' as any, true).status).toBe('rejected')
  })

  /**
   * 归一化：'card' 和 'box' 是同一档的两个名字。模板声明用老名、
   * 调用方传新名（或反过来）必须互认 —— 裸字符串 includes 是踩过的坑
   * （LADDER.indexOf('panel') = -1 那次）。
   */
  it("模板声明 'box'，传 'card' 也认", () => {
    const d = createDesk()
    const r = d.show({ template: 'list', size: 'card' as any, ttl: 60,
      data: { title: 'c', items: [{ label: 'a' }] } })
    expect(r.status).toBe('ok')
  })

  it("模板声明 'tower'（新名），传 'tower' 认、乱写的降到默认档", () => {
    const d = createDesk()
    expect(d.show({ template: 'nav', size: 'hall' as any, kind: 'rule', evictable: false, ttl: 60,
      data: { destination: 'x' } }).status).toBe('ok')
    const r = d.show({ template: 'nav', size: '巨大' as any, kind: 'rule', evictable: false, ttl: 60,
      data: { destination: 'x' } })
    expect(r.status).toBe('ok')
    expect(d.get((r as any).cardId)!.size).not.toBe('巨大')
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
    const big = await reg.invoke('card.generate', {
      kind: 'canvas', size: 'stage', ttl: 'untilDismissed',
      data: { title: '对比', html: '<p>图</p>', text: '兜底' },
    })
    expect(big.status).toBe('ok')
    const fs = await reg.invoke('card.generate', {
      kind: 'canvas', size: 'full', ttl: 'untilDismissed',
      data: { title: '对比', html: '<p>图</p>', text: '兜底' },
    })
    // 降级语义（2026-08-25）：full 不给，但卡照建——降到白名单里的档，
    // 覆盖桌面的防御目的一样达成，模型不用为一个建议档白烧一轮
    expect(fs.status).toBe('ok')
    expect(String((fs.data as any)?.size ?? '')).not.toBe('full')
  })

  it('canvas 的模板 desc 与 sizes 白名单来自同一个数组 —— 不可能再打架', async () => {
    const { CARD_TEMPLATES } = await import('../../src/config/cards')
    const canvas = CARD_TEMPLATES.find(t => t.id === 'canvas')!
    expect(canvas.sizes).toBeTruthy()
    // desc 的像素契约至少覆盖白名单里的大档
    expect(canvas.desc).toContain('stage')
  })

  // 产品裁定（2026-08-13 两轮定稿）：生成式卡**不进覆盖层**（full 禁）——
  // 但最大可到 2/3（stage 竖向大块，走桌面仲裁），游戏这类竖向内容靠它
  it('生成式卡：full 禁（不覆盖桌面）、2/3 是上限（竖向大块）', async () => {
    const { CARD_TEMPLATES } = await import('../../src/config/cards')
    for (const id of ['canvas', 'canvas-app']) {
      const t = CARD_TEMPLATES.find(x => x.id === id)!
      expect(t.sizes, `${id} 不许 full`).not.toContain('full')
      expect(t.sizes, `${id} 上限 2/3`).toContain('stage')
      expect(t.sizes, `${id} 竖块 tower 可用`).toContain('tower')
    }
    const store = createStore(SIGNALS, CONSTRAINTS)
    const reg2 = createRegistry(store, TOOLS, Date.now, { desk: createDesk() })
    const r = await reg2.invoke('card.generate', { kind: 'canvas', size: 'full',
      ttl: 'untilDismissed', data: { title: 'x', html: '<p>1</p>', text: 'x' } })
    expect(r.status).toBe('ok')                 // 降级不拒
    expect((r.data as any)?.size).not.toBe('full')   // 但绝不以 full 上屏
  })

  it('模板 desc 教"按内容形状选尺寸"——游戏竖向内容指向 2/3', async () => {
    const { CARD_TEMPLATES } = await import('../../src/config/cards')
    const app = CARD_TEMPLATES.find(x => x.id === 'canvas-app')!
    expect(app.desc).toContain('stage')
    expect(app.desc).toMatch(/竖/)
  })
})

/**
 * 空列表判据走模板契约（2026-08-14 代码审查）。
 *
 * `isEmptyList` 原本硬编码 `template === 'list' || template === 'capability'`：
 * 判断本身是对的（一张列表卡的意思就是"这里有几条东西"，0 条时这句话是假的），
 * 但**声明放错了层**——模板特性该由模板契约声明，仲裁引擎只该读声明、
 * 不该点名具体模板。代价很实在：新增列表类模板（stagedlist 就是一个）时
 * 若忘了回 desk.ts 追加 `||` 分支，空卡壳照样上屏，正是跑批当年抓到的那个 bug
 * 换个模板重演。
 */
describe('空列表判据来自模板契约，不是引擎里点名', () => {
  it('声明了 requireItems 的模板，空 items 一律拒绝', async () => {
    const { CARD_TEMPLATES } = await import('../../src/config/cards')
    const d = createDesk()
    for (const t of CARD_TEMPLATES.filter(x => x.requireItems)) {
      const r = d.show({ template: t.id, size: t.defaultSize as any, kind: 'system',
        ttl: 60, data: { title: 'x', items: [] } })
      expect(r.status, `${t.id} 空列表该被拒`).toBe('rejected')
      expect(r.code).toBe('EMPTY_CARD')
    }
  })

  it('列表类模板都声明了 requireItems——包括后加的 stagedlist', async () => {
    const { CARD_TEMPLATES } = await import('../../src/config/cards')
    for (const id of ['list', 'capability', 'stagedlist']) {
      const t = CARD_TEMPLATES.find(x => x.id === id)!
      expect(t.requireItems, `${id} 该声明 requireItems`).toBe(true)
    }
  })

  it('不是列表类的模板不受影响：没有 items 也照常建卡', () => {
    const d = createDesk()
    expect(d.show({ template: 'feedback', size: 'box', ttl: 60, data: { title: '已开窗' } }).status).toBe('ok')
  })
})

/**
 * 模板契约的自洽性 —— 12×8 迁移时靠手改配置，漏一处就是运行时才炸的
 * SIZE_NOT_SUPPORTED。这几条是纯静态检查，跑一次就能挡住整类错误。
 */
describe('模板契约自洽', () => {
  it('每个模板的 defaultSize 都在自己的形状池里', async () => {
    const { CARD_TEMPLATES, COMMON_SIZES } = await import('../../src/config/cards')
    const { normalizeTier } = await import('../../src/config/grid')
    for (const t of CARD_TEMPLATES) {
      const pool = (t.sizes ?? COMMON_SIZES).map(normalizeTier)
      expect(pool, `${t.id} 的默认档 ${t.defaultSize} 不在自己的池子 ${pool.join('/')} 里`)
        .toContain(normalizeTier(t.defaultSize))
    }
  })

  it('规则里写死的尺寸也在对应模板的池子里', async () => {
    const { CARD_RULES } = await import('../../src/config/cardRules')
    const { CARD_TEMPLATES, COMMON_SIZES } = await import('../../src/config/cards')
    const { normalizeTier } = await import('../../src/config/grid')
    for (const r of CARD_RULES) {
      const size = (r.card as any)?.size
      if (!size) continue
      const t = CARD_TEMPLATES.find(x => x.id === (r.card as any).template)!
      const pool = (t.sizes ?? COMMON_SIZES).map(normalizeTier)
      expect(pool, `规则 ${r.id} 要 ${t.id}@${size}，池子只有 ${pool.join('/')}`)
        .toContain(normalizeTier(size))
    }
  })

  /** 形状池按占用单元数升序 —— 降级阶梯和右上角按钮都按它走 */
  it('形状池不含重复形状', async () => {
    const { CARD_TEMPLATES } = await import('../../src/config/cards')
    const { normalizeTier } = await import('../../src/config/grid')
    for (const t of CARD_TEMPLATES) {
      if (!t.sizes) continue
      const norm = t.sizes.map(normalizeTier)
      expect(new Set(norm).size, `${t.id} 的池子有重复：${t.sizes.join('/')}`).toBe(norm.length)
    }
  })
})
