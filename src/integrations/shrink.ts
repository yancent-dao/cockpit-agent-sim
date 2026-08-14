/**
 * 图片压缩 —— **决策部分**（纯函数，测得了）+ 接在图像客户端后面的装饰器。
 *
 * 真实跑通之后量到的（2026-08-14）：Gemini 出的一张图 358–588KB，
 * 三页的 H5 就 1.94MB，七页会到 4.5MB —— **微信发不出去**，
 * 而"家长发给爷爷奶奶"正是这个产品的交付方式。不压等于交付不了。
 *
 * 真正的重采样要用 canvas（浏览器 API），在 `director` 那边做；
 * 这里只回答"缩到多大、压不压"，以及"在哪一刻压"。
 */

/** 长边上限。H5 是手机上看的，2K 是浪费；1280 横屏满屏也够清晰 */
export const MAX_EDGE = 1280
/** webp 质量。再低插画的大色块会出色带，童书画风尤其明显 */
export const WEBP_Q = 0.82

export interface ShrinkPlan { w: number; h: number; skip?: boolean }

export function planShrink(w: number, h: number): ShrinkPlan {
  // 测不出尺寸（图还没解码 / 坏数据）时原样放行，别返回 0×0 把图压没了
  if (![w, h].every(n => Number.isFinite(n) && n > 0)) return { w, h, skip: true }
  const long = Math.max(w, h)
  // 本来就够小就不动 —— 放大只会让文件更大、画质更糊
  if (long <= MAX_EDGE) return { w, h, skip: true }
  const k = MAX_EDGE / long
  return { w: Math.round(w * k), h: Math.round(h * k) }
}

/**
 * 压缩接在**出图那一刻**，不是导出那一刻。
 *
 * 第一版只在导出按钮上压，原始的 580KB base64 于是一路走完全程：
 * 进卡片、进 localStorage（**七页 4MB，配额直接爆，书静默丢失**）、
 * 每一页还要把这么大的定妆照当参考图上传回去。接在客户端后面，
 * 下游全都白捡：卡片轻、存得下、上传快、导出小。
 *
 * 这一层不认识"绘本"，只认识"能生成图像的东西"；重采样怎么做由调用方注入
 * （浏览器给 canvas，测试给假的），所以它测得了 —— 跟 `Fetcher` 同一个套路。
 */
export interface Generating {
  generate(o: any): Promise<{ dataUrl: string; cost: number }>
}

export function withShrink<T extends Generating>(
  client: T, resample: (dataUrl: string) => Promise<string>,
): T {
  return {
    ...client,
    async generate(o: any) {
      const r = await client.generate(o)   // 生成失败照样抛，别吞成一张空图
      try { return { ...r, dataUrl: await resample(r.dataUrl) } }
      catch { return r }                   // 压不动就用原图，别让故事停下
    },
  }
}
