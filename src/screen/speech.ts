/**
 * 中文朗读的两个决策 —— 纯函数，机制不是策略。
 *
 * 实拍反馈「TTS 对中文的支持很不好」。查下来是两件事叠在一起：
 *
 * ① **只设了 `u.lang='zh-CN'`，没挑音色。** 浏览器并不保证据此换音色 ——
 *    拿英文音色念中文，出来就是一串"拼音式"的怪音。挑音色得自己来。
 * ② **`onboundary` 对中文基本不发事件。** 逐字点亮是这个产品最讨喜的一秒
 *    （孩子跟着字读），靠边界事件在中文上等于没有 —— 得能纯靠时间推进。
 *
 * 抽成纯函数是因为车机屏那半边是 DOM 操作跑不了单测，而这两个判断错了
 * 就是"念得像机器人"和"字亮完了声音还在念"。
 */

/** 只要能拿到 name 和 lang 就够，不依赖 SpeechSynthesisVoice 这个具体类型 */
export interface VoiceLike {
  name: string
  lang: string
  localService?: boolean
  default?: boolean
}

/**
 * 已知音质更好的中文音色。**这是数据不是逻辑** ——
 * 各家浏览器暴露的高质量中文音色就那么几个，实测出来记在这。
 * 名单外的普通话音色照样能用，只是排在后面。
 */
export const PREFERRED_SRC = 'google|普通话|tingting|ting-ting|婷婷|siri|微软|xiaoxiao|yunxi'
const PREFERRED = new RegExp(PREFERRED_SRC, 'i')

/**
 * 挑一个能好好念中文的音色。
 *
 * **没有中文音色就返回 undefined**，让引擎自己按 lang 决定 ——
 * 硬塞一个英文音色去念中文比什么都不做更糟。
 */
export function pickVoice(voices: VoiceLike[], want = 'zh'): VoiceLike | undefined {
  const zh = (voices ?? []).filter(v => String(v?.lang ?? '').toLowerCase().startsWith(want))
  if (!zh.length) return undefined
  const score = (v: VoiceLike) => {
    let s = 0
    // 讲给大陆小孩听的故事，普通话优先于粤语和台湾腔
    if (/^zh([-_]cn)?$/i.test(v.lang)) s += 40
    if (PREFERRED.test(v.name)) s += 20
    if (v.default) s += 2
    return s
  }
  return zh.slice().sort((a, b) => score(b) - score(a))[0]
}

/**
 * 中文朗读的字/秒（rate=1 时）。用来估一句话要念多久 ——
 * `onboundary` 不来的时候，逐字点亮只能靠时间推。
 */
export const CPS = 4.2

/**
 * 估这句话要念多久。**必须跟着 rate 走** —— 不然调慢语速之后
 * 字会先亮完、声音还在后面念，比不亮更糟，孩子会跟丢。
 */
export function estimateMs(text: string, rate: number): number {
  const n = (text ?? '').length
  if (!n) return 0
  // rate 传 0 或负数（配置传错）时退到 1 倍速，别除出 Infinity 卡死点亮
  const r = Number.isFinite(rate) && rate > 0 ? rate : 1
  return (n / CPS / r) * 1000
}

/** 已过 elapsed 毫秒时该亮到第几个字。估不出时长就全亮 —— 卡在不亮是最糟的 */
export function litUpto(len: number, elapsed: number, totalMs: number): number {
  if (!Number.isFinite(totalMs) || totalMs <= 0) return len
  return Math.max(0, Math.min(len, Math.floor(len * (elapsed / totalMs))))
}
