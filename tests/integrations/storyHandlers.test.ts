import { describe, it, expect, beforeEach } from 'vitest'
import { createStoryHandlers } from '../../src/integrations/storyHandlers'
import { createStore } from '../../src/core/store'
import { createDesk } from '../../src/cards/desk'
import { createStoryStore } from '../../src/state/story'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'

/**
 * ══════════ 「路上的故事」的机制半边 ══════════
 *
 * handler 只做机制：存档案、画图、拼卡片、推信号。
 * **决策全在模型**——每章几页、什么时候问孩子、怎么收尾都是技能包的章法。
 * 这个测试盯的就是那条界线：handler 里不许出现"第一章给 3 页"这类判断。
 */

let store: ReturnType<typeof createStore>
let desk: ReturnType<typeof createDesk>
let story: ReturnType<typeof createStoryStore>
let drawn: string[]
let h: ReturnType<typeof createStoryHandlers>

/** 假的图像客户端：记下每次画图的提示词与参考图 */
const fakeImage = (fail = false) => {
  const refs: string[][] = []
  return {
    refs,
    client: {
      async generate(o: any) {
        drawn.push(o.prompt)
        refs.push(o.refs ?? [])
        if (fail) throw Object.assign(new Error('画不出来'), { code: 'NO_IMAGE' })
        return { dataUrl: 'data:image/png;base64,IMG' + drawn.length, cost: 0.04 }
      },
    },
  }
}

const memStore = () => {
  const m = new Map<string, string>()
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => m.set(k, v) }
}

const boot = (opts: { fail?: boolean } = {}) => {
  store = createStore(SIGNALS, CONSTRAINTS)
  desk = createDesk()
  story = createStoryStore(memStore())
  drawn = []
  const img = fakeImage(opts.fail)
  h = createStoryHandlers(store, () => desk, () => story, () => img.client as any)
  return img
}

beforeEach(() => { boot() })

const pages = (...lines: string[]) => lines.map(l => ({ line: l, scene: l + ' 的画面' }))

describe('孩子档案', () => {
  it('存进域仓，下次不用再填', async () => {
    await h.storyProfile({ name: '妞妞', age: 5, lesson: '分享' })
    expect(story.profile()).toMatchObject({ name: '妞妞', age: 5, lesson: '分享' })
  })
})

describe('定妆', () => {
  it('没授权过就先要授权，不偷偷把孩子照片发出去', async () => {
    story.savePhoto('data:image/jpeg;base64,PHOTO')
    const r = await h.storyCast({ look: '短发女孩' })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('NEED_CONSENT')
    expect(drawn, '一次都不该调画图').toHaveLength(0)
  })

  it('没有照片时明说缺照片，不是"生成失败"', async () => {
    story.consent()
    const r = await h.storyCast({ look: '短发女孩' })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('NO_PHOTO')
    expect(r.message).toMatch(/照片/)
  })

  it('拿原始照片当参考图画定妆照，存下来', async () => {
    const img = boot()
    story.savePhoto('data:image/jpeg;base64,PHOTO'); story.consent()
    const r = await h.storyCast({ look: '短发、齐刘海、黄裙子' })
    expect(r.status).toBe('ok')
    expect(img.refs[0], '参考图就是家长给的那张').toEqual(['data:image/jpeg;base64,PHOTO'])
    expect(drawn[0], '锁死的形象要进提示词').toContain('短发、齐刘海、黄裙子')
    expect(story.cast()).toBe('data:image/png;base64,IMG1')
  })

  it('定妆时进 cast 阶段并出卡，家长要能对照"像不像"', async () => {
    story.savePhoto('p'); story.consent()
    await h.storyCast({ look: 'x' })
    expect(store.get('story.phase')).toBe('cast')
    const card = desk.layout().cards.find(c => c.template === 'storybook')
    expect(card, '定妆卡该在桌面上').toBeTruthy()
    expect(card!.data.photo, '并排要有原图').toBe('p')
  })
})

describe('开篇', () => {
  const begin = async (n = 3) => {
    story.savePhoto('p'); story.consent()
    await h.storyCast({ look: 'x' })
    return h.storyBegin({ title: '妞妞和小熊的雨天', pages: pages(...Array.from({ length: n }, (_, i) => '第' + i + '句')) })
  }

  it('页数完全听模型的 —— 给几页就是几页', async () => {
    await begin(3)
    await h.storyFinish({ ending: '完' })
    expect(story.books()[0].pages, '3 页正文 + 1 页结尾').toHaveLength(4)
    boot()
    story.savePhoto('p'); story.consent(); story.saveCast('c')
    await h.storyBegin({ title: 'T', pages: pages('a', 'b') })
    await h.storyFinish({ ending: '完' })
    expect(story.books()[0].pages, '给 2 页就是 2 页 —— 没有任何按章节号的硬编码').toHaveLength(3)
  })

  /**
   * **角色一致性的核心**：每页都拿**定妆照**当参考，不是拿上一页。
   * 每页独立锚在同一个点上，误差不累积；某页画歪单页重画就行。
   */
  it('每一页都锚在定妆照上，不是锚在上一页', async () => {
    const img = boot()
    story.savePhoto('p'); story.consent()
    await h.storyCast({ look: 'x' })
    const cast = story.cast()!
    await h.storyBegin({ title: 'T', pages: pages('a', 'b', 'c') })
    // 第 0 次是定妆本身，之后每一次的参考图都必须是定妆照
    for (let i = 1; i < img.refs.length; i++)
      expect(img.refs[i], `第 ${i} 次画图`).toEqual([cast])
  })

  it('文字先出、图片后到 —— 第一页立刻能讲', async () => {
    await begin(3)
    const card = desk.layout().cards.find(c => c.template === 'storybook')!
    expect(card.data.line, '第一句话立刻就有').toContain('第0句')
  })

  /**
   * **开篇不等图画完**。实测一章两页要 22 秒（每张 11 秒串行），
   * 而设计是"文字先出（约 2 秒）立刻开讲，图片后台流式补齐" ——
   * 等图画完再返回，用户就是干等 22 秒看着空屏。
   *
   * 节奏由车机屏的 `afterRead` 接住：pending > 0 时它返回 wait，让画面追上声音。
   */
  it('开篇立刻返回，不等图 —— pending 还大于 0 就已经能讲了', async () => {
    boot()
    story.savePhoto('p'); story.consent(); story.saveCast('c')
    // 卡住画图，模拟真实的 11 秒/张
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    h = createStoryHandlers(store, () => desk, () => story, () => ({
      async generate(o: any) { drawn.push(o.prompt); await gate; return { dataUrl: 'data:image/png;base64,X', cost: 0 } },
    }) as any)
    const r = await h.storyBegin({ title: 'T', pages: pages('第一句', '第二句') })
    expect(r.status).toBe('ok')
    expect(store.get('story.pending'), '图还在画').toBeGreaterThan(0)
    expect(desk.layout().cards.find(c => c.template === 'storybook')!.data.line,
      '但第一句话已经在屏幕上了').toBe('第一句')
    release()
  })

  /**
   * **一章的图并发画，不是一张画完再画下一张**（2026-08-14 真实跑通后改）。
   *
   * 实测一张 9–10 秒。串行的话第一章 3 页要 30 秒才画齐，而一句童书正文
   * 念出来只要 6–8 秒 —— 讲到第二页图还没到，`afterRead` 就把节奏卡住，
   * 孩子对着空画框等。并发之后三张一起在 ~10 秒到齐，钱一分不多花。
   *
   * 上限是一章的页数（2–3 张），不是无限并发。
   */
  it('一章的图并发画 —— 三张同时在飞，不是排队', async () => {
    boot()
    story.savePhoto('p'); story.consent(); story.saveCast('c')
    let live = 0, peak = 0
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    h = createStoryHandlers(store, () => desk, () => story, () => ({
      async generate() {
        live++; peak = Math.max(peak, live)
        await gate
        live--
        return { dataUrl: 'data:image/png;base64,X', cost: 0 }
      },
    }) as any)
    await h.storyBegin({ title: 'T', pages: pages('一', '二', '三') })
    await Promise.resolve()
    expect(peak, '三张该同时在画').toBe(3)
    release()
  })

  /** 并发之后先画完的先落位 —— 图必须落到自己那一页，不能按完成顺序错位 */
  it('乱序返回时每张图仍落在自己那一页', async () => {
    boot()
    story.savePhoto('p'); story.consent(); story.saveCast('c')
    const gates: Array<() => void> = []
    let n = 0
    h = createStoryHandlers(store, () => desk, () => story, () => ({
      async generate() {
        const i = n++
        await new Promise<void>(r => gates.push(r))
        return { dataUrl: 'IMG' + i, cost: 0 }
      },
    }) as any)
    await h.storyBegin({ title: 'T', pages: pages('一', '二', '三') })
    await new Promise(r => setTimeout(r, 0))
    // 倒着放行：第三张先画完
    gates.reverse().forEach(g => g())
    await new Promise(r => setTimeout(r, 0))
    await h.storyPage({ dir: 'next' })
    await h.storyPage({ dir: 'next' })
    const card = desk.layout().cards.find(c => c.template === 'storybook')!
    expect(card.data.image, '第三页拿的该是第三张').toBe('IMG2')
  })

  it('进 telling 阶段，story.active 置真', async () => {
    await begin()
    expect(store.get('story.active')).toBe(true)
    expect(store.get('story.phase')).toBe('telling')
  })

  it('没定妆就开篇 → 明说要先定妆', async () => {
    const r = await h.storyBegin({ title: 'T', pages: pages('a') })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('NO_CAST')
  })

  /**
   * 画不出图不该让整个故事停下 —— 断网、额度用完都会遇到。
   * **文字全文先落本地**，图缺就缺，纯语音继续讲。
   */
  it('画图失败时故事照常开讲，不整个失败', async () => {
    boot({ fail: true })
    story.savePhoto('p'); story.consent(); story.saveCast('c')
    const r = await h.storyBegin({ title: 'T', pages: pages('从前有座桥') })
    expect(r.status).toBe('ok')
    expect(desk.layout().cards.find(c => c.template === 'storybook')!.data.line).toContain('从前有座桥')
  })
})

describe('续章：一起写', () => {
  const upTo = async () => {
    story.savePhoto('p'); story.consent(); story.saveCast('c')
    await h.storyBegin({ title: 'T', pages: pages('a', 'b', 'c') })
  }

  it('孩子说的话记进书里 —— 封底要单列出来', async () => {
    await upTo()
    await h.storyContinue({ idea: '会飞的自行车', pages: pages('d', 'e') })
    await h.storyFinish({ ending: '完' })
    expect(story.books()[0].ideas).toContain('会飞的自行车')
  })

  it('章节号递增', async () => {
    await upTo()
    expect(store.get('story.chapter')).toBe(1)
    await h.storyContinue({ idea: 'x', pages: pages('d', 'e') })
    expect(store.get('story.chapter')).toBe(2)
  })

  it('还没开篇就续章 → 拒绝，说清要先开篇', async () => {
    const r = await h.storyContinue({ idea: 'x', pages: pages('a') })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('NO_STORY')
  })
})

describe('收尾成书', () => {
  const full = async () => {
    story.savePhoto('p'); story.consent(); story.saveCast('c')
    await h.storyBegin({ title: '妞妞和小熊的雨天', pages: pages('a', 'b', 'c') })
    await h.storyContinue({ idea: '会飞的自行车', pages: pages('d', 'e') })
    return h.storyFinish({ ending: '他们回到了外婆家' })
  }

  it('存进历史，页数是所有章加结尾', async () => {
    await full()
    const b = story.books()[0]
    expect(b.title).toBe('妞妞和小熊的雨天')
    expect(b.pages).toHaveLength(6)   // 3 + 2 + 结尾
    expect(b.pages[5].text).toBe('他们回到了外婆家')
  })

  /**
   * **存不下必须说出来**。域仓的降级阶梯（图文 → 只剩文字 → 存不下）
   * 结果要走到模型的上下文里 —— 不然用户听到"讲完了"，转头点导出
   * 拿到的是上一本书，或者干脆没有。交付物没了还没人知道，是最坏的失败。
   */
  it('只存下文字时，收尾播报要说清楚图没留住', async () => {
    boot()
    const fake = { ...story, saveBook: () => 'text' as const }
    h = createStoryHandlers(store, () => desk, () => fake as any, () => ({
      async generate() { return { dataUrl: 'IMG', cost: 0 } },
    }) as any)
    story.savePhoto('p'); story.consent(); story.saveCast('c')
    await h.storyBegin({ title: 'T', pages: pages('a') })
    const r = await h.storyFinish({ ending: '完' })
    expect(r.status).toBe('ok')
    expect(r.message, '得让模型知道图没了').toMatch(/图|插图/)
  })

  it('整本都存不下时不假装存好了', async () => {
    boot()
    const fake = { ...story, saveBook: () => 'failed' as const }
    h = createStoryHandlers(store, () => desk, () => fake as any, () => ({
      async generate() { return { dataUrl: 'IMG', cost: 0 } },
    }) as any)
    story.savePhoto('p'); story.consent(); story.saveCast('c')
    await h.storyBegin({ title: 'T', pages: pages('a') })
    const r = await h.storyFinish({ ending: '完' })
    expect(r.message, '得说没存下').toMatch(/存不下|没存|没能存/)
    /**
     * 存不下也要**能导出**。刚讲完的这本还在内存里，导出（Blob + download）
     * 根本不需要经过 localStorage —— 让配额问题连带毁掉交付物，
     * 是把两件不相干的事绑在了一起。
     */
    const e = await h.storyExport()
    expect(e.status, '刚讲完的这本必须导得出来').toBe('ok')
    expect((e.data as any).book.title).toBe('T')
  })

  it('顺利存下时不提存储的事 —— 别拿实现细节烦用户', async () => {
    const r = await full()
    expect(r.message).not.toMatch(/存不下|没存/)
  })

  it('进 done 阶段，active 归假', async () => {
    await full()
    expect(store.get('story.phase')).toBe('done')
    expect(store.get('story.active')).toBe(false)
  })
})

describe('翻页：屏幕按钮直调，不叫醒模型', () => {
  const three = async () => {
    story.savePhoto('p'); story.consent(); story.saveCast('c')
    await h.storyBegin({ title: 'T', pages: pages('一', '二', '三') })
  }

  it('next 往后翻，卡片文字跟着换', async () => {
    await three()
    await h.storyPage({ dir: 'next' })
    expect(desk.layout().cards.find(c => c.template === 'storybook')!.data.line).toBe('二')
  })

  it('翻到头就停住，不绕回也不报错', async () => {
    await three()
    for (let i = 0; i < 9; i++) await h.storyPage({ dir: 'next' })
    expect(desk.layout().cards.find(c => c.template === 'storybook')!.data.line).toBe('三')
  })

  it('第一页时 prev 停在第一页', async () => {
    await three()
    await h.storyPage({ dir: 'prev' })
    expect(store.get('story.page')).toBe(1)
  })
})

describe('机制与策略的界线', () => {
  /**
   * 「每章几页」「什么时候该问」「快到站怎么收」全部是**模型按技能包做的决策**。
   * 源码里出现按章节号决定页数、或者关键词匹配「结束吧」，都算把策略写进了机制。
   */
  it('handler 源码里没有章节页数的硬编码，也没有对用户原话的比对', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('src/integrations/storyHandlers.ts', 'utf8'))
    expect(src, '页数不许按章节号分支').not.toMatch(/chapter\s*[=<>!]=/)
    /**
     * 查的是**比对**不是出现：`message: '讲完了'` 是说给用户的话，合法；
     * `text.includes('结束吧')` 是拿用户原话做分支，违规。
     * 只匹配"出现了这几个词"的话会把人话消息也一起判死，那才是假阳性。
     */
    expect(src, '不许拿用户原话做意图分支')
      .not.toMatch(/(includes|indexOf|match|startsWith|===)\s*\(?\s*['"`][^'"`]*(结束|不玩|停下|讲完)/)
  })
})
