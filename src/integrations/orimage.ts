/**
 * OpenRouter 统一图像 API（2026-06 上线的 `POST /api/v1/images`）。
 *
 * ## 为什么是它
 *
 * 不是因为它最好，是因为**它是唯一不用给项目开例外的方案**：同一个 host、
 * 同一个 Key，`src/agent/openrouter.ts` 已经在调它了。对着「零后端」和
 * 「运行时依赖为零」两条硬约束，换任何一家图像服务商都意味着多一个 Key、
 * 一套鉴权、一份跨域风险 —— 而这些成本换不来任何东西。
 *
 * ## 三个特性正好命中儿童绘本的要害
 *
 *   · `input_references` 接受 0–14 张参考图 → **角色一致性直接由 API 解决**，
 *     不用自建 IP-Adapter 之类的推理（那个需要后端，直接出局）
 *   · 返回 base64 → 不碰跨域、不用下载，直接进 `<img src>`，
 *     也直接能内嵌进导出的自包含 H5
 *   · 支持 SSE 流式部分图像 → 第一页可以边画边出（本轮先不用，接口留着）
 *
 * ## 边界
 *
 * 这一层**只做协议适配**，不认识"绘本""定妆照""第几页"。
 * 提示词怎么写、锁哪几个形象不变量、每章几页 —— 全是技能包里的章法，
 * 归模型管（协议客户端 < 200 行的预算口径就是这么守住的）。
 */
import type { Fetcher } from './amap'

/** 服务端上限。超了截断而不是整个失败 —— 绘本只用一张定妆照，会超的只有调用方传错 */
export const REF_CAP = 14

/**
 * 默认模型：Gemini 3.1 Flash Image（Nano Banana 2）。
 * 角色保持最强，约 10 秒一张、$0.04。要更快可传 lite，中文场景可传 Seedream。
 */
const DEFAULT_MODEL = 'google/gemini-3.1-flash-image'
const ENDPOINT = 'https://openrouter.ai/api/v1/images'
/**
 * per-request 超时。项目「已知待办」里记着工具超时的残留窗口：registry 那层的
 * 总超时只是 `Promise.race`，落败的 handler 收不到取消信号、副作用照样落地。
 * 在客户端这层卡超时，fetch 先抛错，根本走不到副作用 —— 跟 radio/itunes 同一个思路。
 */
const TIMEOUT_MS = 60_000

export interface GenOptions {
  prompt: string
  /** 参考图（角色一致性的命根子）。data: URL 或 http URL */
  refs?: string[]
  /** '16:9' / '1:1' / '4:3'… 不传就听模型的 */
  aspect?: string
  model?: string
}

export interface GenImage {
  /** data: URL，直接能进 `<img src>` 和导出的 H5 */
  dataUrl: string
  /** 这一张的花费（美元）。图像比文本贵一个量级，控制面板要能累加显示 */
  cost: number
}

export class ImageError extends Error {
  constructor(message: string, readonly code?: string) { super(message) }
}

export interface ImageClientOpts { timeoutMs?: number }

export function createImageClient(
  fetcher: Fetcher, key: () => string, opts: ImageClientOpts = {},
) {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS

  async function generate(o: GenOptions): Promise<GenImage> {
    const k = key()
    if (!k) throw new ImageError('还没配 OpenRouter 的 Key，画不了图', 'NO_KEY')

    const body: Record<string, unknown> = { model: o.model ?? DEFAULT_MODEL, prompt: o.prompt }
    // 空数组也别发 —— 服务端对"给了这个字段但是空的"和"没给"未必一视同仁
    if (o.refs?.length) body.input_references = o.refs.slice(0, REF_CAP)
    if (o.aspect) body.aspect_ratio = o.aspect

    let timer!: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new ImageError('画图超时了，等太久', 'TIMEOUT')), timeoutMs)
    })
    const res = await Promise.race([
      fetcher(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      timeout,
    ]).finally(() => clearTimeout(timer))

    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      const why = json?.error?.message || json?.message || '画图服务没接受这次请求'
      throw new ImageError(why, json?.error?.code ?? 'UPSTREAM')
    }

    const first = json?.data?.[0]
    /**
     * 返回 200 但没有图。**绝不返回空串** —— 那会让绘本页渲染成一张白卡，
     * 用户以为还在加载。宁可报错，让上层重试或降级为纯文字。
     */
    if (!first?.b64_json) throw new ImageError('画图服务没给出图片', 'NO_IMAGE')

    return {
      dataUrl: `data:${first.media_type || 'image/png'};base64,${first.b64_json}`,
      cost: Number(json?.usage?.cost ?? 0),
    }
  }

  return { generate }
}
