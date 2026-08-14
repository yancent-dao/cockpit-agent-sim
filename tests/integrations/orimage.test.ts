import { describe, it, expect } from 'vitest'
import { createImageClient, ImageError, REF_CAP } from '../../src/integrations/orimage'

/**
 * ══════════ OpenRouter 统一图像 API ══════════
 *
 * 2026-06 上线的 `POST /api/v1/images`。选它的理由不是它最好，
 * 是**它是唯一不用给项目开例外的方案**：同一个 host、同一个 Key，
 * `src/agent/openrouter.ts` 已经在调它了 —— 对着「零后端」和
 * 「运行时依赖为零」两条硬约束，加一个图像服务商就要加一个 Key、
 * 一套鉴权、一份 CORS 风险。
 *
 * 三个特性正好命中儿童绘本的要害：
 *   · `input_references` 接受参考图 → **角色一致性直接由 API 解决**，不用自建推理
 *   · 返回 base64 → 不碰跨域、不用下载，直接进 <img> 和导出的 H5
 *   · SSE 流式 → 第一页可以边画边出（本轮先不用，接口留着）
 */

/** 造一个假的 fetcher，记下请求体供断言 */
const mk = (reply: any, ok = true) => {
  const seen: any[] = []
  const fetcher = async (url: string, init?: any) => {
    seen.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined })
    return { ok, json: async () => reply }
  }
  return { fetcher, seen }
}

const okReply = (b64 = 'AAAA') => ({
  data: [{ b64_json: b64, media_type: 'image/png' }],
  usage: { cost: 0.04 },
})

describe('生成一张图', () => {
  it('base64 拼成 data: URL —— 调用方拿到就能直接用', async () => {
    const { fetcher } = mk(okReply('SGVsbG8='))
    const c = createImageClient(fetcher as any, () => 'k')
    const img = await c.generate({ prompt: '一个小女孩在雨中的桥上' })
    expect(img.dataUrl).toBe('data:image/png;base64,SGVsbG8=')
  })

  /** 图像比文本贵一个量级，不显示的话跑几轮就烧掉额度还不知道 */
  it('带回这一张的花费，供控制面板累加', async () => {
    const { fetcher } = mk(okReply())
    const c = createImageClient(fetcher as any, () => 'k')
    expect((await c.generate({ prompt: 'x' })).cost).toBe(0.04)
  })

  it('打的是 OpenRouter 的图像端点，Key 走 Authorization 头', async () => {
    const { fetcher, seen } = mk(okReply())
    const c = createImageClient(fetcher as any, () => 'sk-abc')
    await c.generate({ prompt: 'x' })
    expect(seen[0].url).toContain('/api/v1/images')
    expect(seen[0].init.method).toBe('POST')
    expect(seen[0].init.headers.Authorization).toBe('Bearer sk-abc')
  })
})

describe('角色一致性：参考图', () => {
  it('参考图原样进 input_references', async () => {
    const { fetcher, seen } = mk(okReply())
    const c = createImageClient(fetcher as any, () => 'k')
    await c.generate({ prompt: 'x', refs: ['data:image/png;base64,AAA'] })
    expect(seen[0].body.input_references).toEqual(['data:image/png;base64,AAA'])
  })

  it('没有参考图时不发这个字段 —— 别给服务端塞空数组', async () => {
    const { fetcher, seen } = mk(okReply())
    const c = createImageClient(fetcher as any, () => 'k')
    await c.generate({ prompt: 'x' })
    expect(seen[0].body).not.toHaveProperty('input_references')
  })

  /**
   * 服务端上限 14 张。超了不该整个失败 —— 绘本的定妆照只有一张，
   * 会超限的只有调用方传错，截断比报错更有用。
   */
  it('参考图超过上限时截断，不是整个失败', async () => {
    const { fetcher, seen } = mk(okReply())
    const c = createImageClient(fetcher as any, () => 'k')
    await c.generate({ prompt: 'x', refs: Array.from({ length: 20 }, (_, i) => `r${i}`) })
    expect(seen[0].body.input_references).toHaveLength(REF_CAP)
  })
})

describe('参数', () => {
  it('画幅比例和模型可以指定', async () => {
    const { fetcher, seen } = mk(okReply())
    const c = createImageClient(fetcher as any, () => 'k')
    await c.generate({ prompt: 'x', aspect: '16:9', model: 'bytedance-seed/seedream-4.5' })
    expect(seen[0].body.aspect_ratio).toBe('16:9')
    expect(seen[0].body.model).toBe('bytedance-seed/seedream-4.5')
  })

  it('不指定就走默认模型', async () => {
    const { fetcher, seen } = mk(okReply())
    const c = createImageClient(fetcher as any, () => 'k')
    await c.generate({ prompt: 'x' })
    expect(seen[0].body.model, '默认得是个真模型名').toMatch(/\//)
  })
})

/**
 * 拒绝必须携带机器可读原因 —— `{code, message}`，message 写人话不写日志，
 * 它会直接进模型上下文（项目核心原则第 4 条）。
 */
describe('出错时说人话', () => {
  it('没配 Key：明说是没配，不是"生成失败"', async () => {
    const { fetcher } = mk(okReply())
    const c = createImageClient(fetcher as any, () => '')
    await expect(c.generate({ prompt: 'x' })).rejects.toMatchObject({ code: 'NO_KEY' })
    await expect(c.generate({ prompt: 'x' })).rejects.toThrow(/Key/)
  })

  it('服务端报错：带上它给的原因', async () => {
    const { fetcher } = mk({ error: { message: '余额不足' } }, false)
    const c = createImageClient(fetcher as any, () => 'k')
    await expect(c.generate({ prompt: 'x' })).rejects.toThrow(/余额不足/)
  })

  /**
   * 返回 200 但没有图。**不能返回空串** —— 那会让绘本页面渲染成一张白卡，
   * 用户以为还在加载。宁可报错让上层重试或降级为纯文字。
   */
  it('返回里没有图：明确报错，绝不返回空串', async () => {
    const { fetcher } = mk({ data: [] })
    const c = createImageClient(fetcher as any, () => 'k')
    await expect(c.generate({ prompt: 'x' })).rejects.toMatchObject({ code: 'NO_IMAGE' })
  })

  /**
   * per-request 超时。项目已知待办里记着「工具超时的残留窗口」——
   * registry 那层的 60 秒总超时只是 Promise.race，落败的 handler 收不到取消。
   * 在客户端这层做超时，fetch 先抛错，副作用根本走不到。
   */
  it('超时抛 TIMEOUT，不是无限等', async () => {
    const fetcher = () => new Promise<never>(() => {})   // 永远不 resolve
    const c = createImageClient(fetcher as any, () => 'k', { timeoutMs: 20 })
    await expect(c.generate({ prompt: 'x' })).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
})

describe('媒体类型', () => {
  it('服务端说是什么类型就用什么类型', async () => {
    const { fetcher } = mk({ data: [{ b64_json: 'AA', media_type: 'image/webp' }], usage: {} })
    const c = createImageClient(fetcher as any, () => 'k')
    expect((await c.generate({ prompt: 'x' })).dataUrl).toContain('data:image/webp;base64,')
  })

  it('没说类型时退到 png，不留空的 mime', async () => {
    const { fetcher } = mk({ data: [{ b64_json: 'AA' }], usage: {} })
    const c = createImageClient(fetcher as any, () => 'k')
    expect((await c.generate({ prompt: 'x' })).dataUrl).toContain('data:image/png;base64,')
  })
})

describe('ImageError', () => {
  it('是个 Error，带 code', () => {
    const e = new ImageError('炸了', 'BOOM')
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('BOOM')
  })
})
