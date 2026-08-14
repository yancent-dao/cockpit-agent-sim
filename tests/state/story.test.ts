import { describe, it, expect } from 'vitest'
import { createStoryStore } from '../../src/state/story'

/**
 * ══════════ 绘本域仓（记忆系统第三级：领域） ══════════
 *
 * 孩子档案、定妆照、成书历史。它们不是车辆状态（信号 store 对齐 VSS，
 * 那条界线不划清车速转速都会往里挤），也不是会话记忆 ——
 * 是"下次上车接着讲"和"再讲一个妞妞的故事"能成立的地基。
 *
 * 存储可注入，沿用域仓与 clock 的先例。
 */

const mem = () => {
  const m = new Map<string, string>()
  return { store: { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => m.set(k, v) }, m }
}

describe('孩子档案', () => {
  it('一次录入，之后每次只说一句话就够', () => {
    const s = createStoryStore(mem().store)
    s.saveProfile({ name: '妞妞', age: 5, interests: ['小熊', '下雨'], lesson: '分享' })
    expect(s.profile()).toMatchObject({ name: '妞妞', age: 5, lesson: '分享' })
  })

  it('没录过时返回 null，不是一个空壳对象', () => {
    expect(createStoryStore(mem().store).profile()).toBeNull()
  })

  it('跨会话还在 —— 换一个 store 实例读同一份存储', () => {
    const { store } = mem()
    createStoryStore(store).saveProfile({ name: '妞妞', age: 5 })
    expect(createStoryStore(store).profile()?.name).toBe('妞妞')
  })

  it('改档案是合并不是覆盖 —— 只改教育目标不该丢掉名字', () => {
    const s = createStoryStore(mem().store)
    s.saveProfile({ name: '妞妞', age: 5, interests: ['小熊'] })
    s.saveProfile({ lesson: '勇敢' })
    expect(s.profile()).toMatchObject({ name: '妞妞', age: 5, lesson: '勇敢' })
    expect(s.profile()?.interests).toEqual(['小熊'])
  })
})

describe('定妆照：全书每一页的锚', () => {
  /**
   * **角色一致性靠它**。之后每一页都拿这张当参考图 —— 不是拿上一页，
   * 所以误差不累积（调研里反复提到的失败模式就是"以上一页为参考"
   * 导致越画越不像，一页坏了整本重来）。
   */
  it('存下来之后每次都能取到同一张', () => {
    const s = createStoryStore(mem().store)
    s.saveCast('data:image/png;base64,AAA')
    expect(s.cast()).toBe('data:image/png;base64,AAA')
  })

  it('家长说"换一个"就覆盖 —— 定妆只有一张，不做历史版本', () => {
    const s = createStoryStore(mem().store)
    s.saveCast('data:image/png;base64,A')
    s.saveCast('data:image/png;base64,B')
    expect(s.cast()).toBe('data:image/png;base64,B')
  })

  it('没定妆时返回 null', () => {
    expect(createStoryStore(mem().store).cast()).toBeNull()
  })
})

describe('原始照片：家长给的那张', () => {
  it('跟定妆照分开存 —— 家长要能对照"像不像"，也要能重新定妆', () => {
    const s = createStoryStore(mem().store)
    s.savePhoto('data:image/jpeg;base64,PHOTO')
    s.saveCast('data:image/png;base64,TOON')
    expect(s.photo()).toContain('PHOTO')
    expect(s.cast()).toContain('TOON')
  })

  /**
   * 儿童影像是最敏感的一类数据。**授权是一次性的明确动作**，
   * 不是埋在设置里的默认开关 —— 照片不存我们这（没有后端），
   * 但会发给第三方模型，这件事必须家长点过头。
   */
  it('没授权过时明确是 false，不靠"undefined 当假"', () => {
    expect(createStoryStore(mem().store).consented()).toBe(false)
  })

  it('授权之后记住，不用每次都问', () => {
    const s = createStoryStore(mem().store)
    s.consent()
    expect(s.consented()).toBe(true)
  })

  it('撤回授权时连照片和定妆照一起清 —— 只关开关等于没撤回', () => {
    const s = createStoryStore(mem().store)
    s.savePhoto('p'); s.saveCast('c'); s.consent()
    s.revoke()
    expect(s.consented()).toBe(false)
    expect(s.photo()).toBeNull()
    expect(s.cast()).toBeNull()
  })
})

describe('成书历史', () => {
  const book = (title: string) => ({
    title, createdAt: 1000,
    pages: [{ text: '从前有座桥', image: 'data:image/png;base64,A' }],
    ideas: ['会飞的自行车'],
  })

  it('存下来能列出来 —— "再讲一遍那个"要有东西可指', () => {
    const s = createStoryStore(mem().store)
    s.saveBook(book('妞妞和小熊的雨天'))
    expect(s.books().map(b => b.title)).toEqual(['妞妞和小熊的雨天'])
  })

  it('最新的排最前 —— 孩子想接着讲的多半是刚才那本', () => {
    const s = createStoryStore(mem().store)
    s.saveBook({ ...book('旧的'), createdAt: 1000 })
    s.saveBook({ ...book('新的'), createdAt: 2000 })
    expect(s.books()[0].title).toBe('新的')
  })

  /**
   * 每本书带 7 页 base64 图，一本就一两 MB。localStorage 通常只有 5–10MB，
   * 不设上限的话第三本就写不进去 —— 而且**写失败是静默的**，
   * 用户会以为存上了。留最近的几本，老的自然淘汰。
   */
  it('超过上限时淘汰最老的，不让 localStorage 撑爆', () => {
    const s = createStoryStore(mem().store)
    for (let i = 0; i < 10; i++) s.saveBook({ ...book('第' + i), createdAt: 1000 + i })
    expect(s.books().length).toBeLessThanOrEqual(5)
    expect(s.books().map(b => b.title)).not.toContain('第0')
    expect(s.books().map(b => b.title)).toContain('第9')
  })

  it('存储写不进去时不抛 —— 讲了一路的故事不该因为存不下而报错', () => {
    const s = createStoryStore({ get: () => null, set: () => { throw new Error('QuotaExceeded') } })
    expect(() => s.saveBook(book('x'))).not.toThrow()
  })

  it('存储里是坏数据时当没有，不把整个功能带崩', () => {
    const s = createStoryStore({ get: () => '{不是 json', set: () => {} })
    expect(s.books()).toEqual([])
    expect(s.profile()).toBeNull()
  })
})

describe('孩子贡献的点子', () => {
  /**
   * 这是整个产品最该被记住的一秒钟：让孩子看见**这本书里有他写的部分**。
   * 所以它是书的一等字段，不是从正文里事后猜出来的。
   */
  it('跟着书一起存，导出封底要用', () => {
    const s = createStoryStore(mem().store)
    s.saveBook({ title: 'x', createdAt: 1, pages: [], ideas: ['会飞的自行车', '会说话的路灯'] })
    expect(s.books()[0].ideas).toEqual(['会飞的自行车', '会说话的路灯'])
  })
})
