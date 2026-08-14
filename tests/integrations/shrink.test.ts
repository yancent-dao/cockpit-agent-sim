import { describe, it, expect } from 'vitest'
import { planShrink, withShrink, MAX_EDGE, WEBP_Q } from '../../src/integrations/shrink'

/**
 * ══════════ 导出前的图片压缩 ══════════
 *
 * 真实跑通之后量到的（2026-08-14）：Gemini 出的一张图 358–588KB，
 * 三页的 H5 就 1.94MB，七页会到 4.5MB —— **微信发不出去**，
 * 而"发给爷爷奶奶"正是这个产品的交付方式。
 *
 * 压缩本身要用 canvas（浏览器 API），所以这里只放**决策**：缩到多大、压不压。
 * 纯函数才测得了。
 */

describe('决定缩到多大', () => {
  it('长边超过上限就等比缩 —— H5 是手机上看的，不需要 2K', () => {
    expect(planShrink(2048, 1152)).toMatchObject({ w: MAX_EDGE, h: 720 })
  })

  it('竖图按高度算长边', () => {
    const r = planShrink(1024, 2048)
    expect(r.h).toBe(MAX_EDGE)
    expect(r.w).toBe(640)
  })

  it('本来就够小就不放大 —— 放大只会让文件更大画质更糊', () => {
    expect(planShrink(800, 450)).toMatchObject({ w: 800, h: 450, skip: true })
  })

  it('正方形也处理得了', () => {
    expect(planShrink(2048, 2048)).toMatchObject({ w: MAX_EDGE, h: MAX_EDGE })
  })

  /** 定妆照实测就是 1024×1024 —— 已经在上限内，一个像素都不该动 */
  it('1024 见方的定妆照原样保留', () => {
    expect(planShrink(1024, 1024)).toMatchObject({ w: 1024, h: 1024, skip: true })
  })
})

describe('参数取值', () => {
  it('长边 1280 够手机看，也够横屏 H5', () => {
    expect(MAX_EDGE).toBeGreaterThanOrEqual(1024)
    expect(MAX_EDGE).toBeLessThanOrEqual(1600)
  })

  /** webp 质量太低会让插画的大色块出现色带，童书画风尤其明显 */
  it('webp 质量不低于 0.8', () => {
    expect(WEBP_Q).toBeGreaterThanOrEqual(0.8)
    expect(WEBP_Q).toBeLessThan(1)
  })
})

describe('坏输入', () => {
  it('尺寸测不出来时原样放行，不返回 0×0', () => {
    for (const [w, h] of [[0, 0], [NaN, 100], [-1, -1]])
      expect(planShrink(w, h), `${w}×${h}`).toMatchObject({ skip: true })
  })
})

/**
 * ══════════ 压缩要接在**出图那一刻**，不是导出那一刻 ══════════
 *
 * 第一版只在导出按钮上压，于是原始的 580KB base64 一路走完全程：
 * 进卡片（每次 render 拷一遍）、进 localStorage（**七页 4MB，配额直接爆**）、
 * 每一页还要把这么大的定妆照当参考图上传回去。
 *
 * 接在客户端后面，下游全都白捡：卡片轻、存得下、上传快、导出小。
 * 装饰器不认识"绘本"，只认识"生成图像的东西" —— 重采样怎么做（canvas）
 * 由调用方注入，这一层才测得了。
 */
describe('接在图像客户端后面：一出图就压', () => {
  const client = (dataUrl = 'RAW') => ({ generate: async (_o: any) => ({ dataUrl, cost: 0.07 }) })

  it('产出的图先过重采样再交出去', async () => {
    const c = withShrink(client(), async u => u + ':small')
    expect((await c.generate({ prompt: 'x' })).dataUrl).toBe('RAW:small')
  })

  it('花费原样带回 —— 压缩不改变已经花掉的钱', async () => {
    const c = withShrink(client(), async u => u)
    expect((await c.generate({ prompt: 'x' })).cost).toBe(0.07)
  })

  /** 压缩是锦上添花，压不动不该让一本正在讲的故事停下 */
  it('重采样失败时原图照出，不把故事带崩', async () => {
    const c = withShrink(client(), async () => { throw new Error('canvas 不支持 webp') })
    expect((await c.generate({ prompt: 'x' })).dataUrl).toBe('RAW')
  })

  it('参数原样透传 —— 参考图、画幅、模型一个都不能丢', async () => {
    const seen: any[] = []
    const c = withShrink({ generate: async (o: any) => (seen.push(o), { dataUrl: 'R', cost: 0 }) },
      async u => u)
    await c.generate({ prompt: 'p', refs: ['cast'], aspect: '16:9' })
    expect(seen[0]).toMatchObject({ prompt: 'p', refs: ['cast'], aspect: '16:9' })
  })

  it('生成本身失败时照样抛 —— 别把错误吞成一张空图', async () => {
    const c = withShrink({ generate: async (_o: any) => { throw Object.assign(new Error('没额度'), { code: 'UPSTREAM' }) } },
      async u => u)
    await expect(c.generate({ prompt: 'x' })).rejects.toMatchObject({ code: 'UPSTREAM' })
  })
})
