import { describe, it, expect } from 'vitest'
import { pickVoice, estimateMs, litUpto, CPS } from '../../src/screen/speech'

/**
 * ══════════ 中文朗读：挑音色 + 逐字点亮的兜底 ══════════
 *
 * 实拍反馈「TTS 对中文的支持很不好」。查下来是两件事叠在一起：
 *
 * ① **只设了 `u.lang='zh-CN'`，没挑音色。** 浏览器并不保证据此换音色 ——
 *    拿英文音色念中文，出来就是一串"拼音式"的怪音。
 * ② **`onboundary` 对中文基本不发事件。** 逐字点亮是这个产品最讨喜的一秒
 *    （孩子跟着字读），靠边界事件在中文上等于没有。
 *
 * 决策抽成纯函数才测得了：车机屏那半边是 DOM 操作，跑不了单测。
 */

const v = (name: string, lang: string, localService = true) => ({ name, lang, localService })

describe('挑一个能好好念中文的音色', () => {
  /**
   * **没有中文音色就返回 undefined**，让引擎自己按 lang 决定 ——
   * 硬塞一个英文音色去念中文，比什么都不做更糟。
   */
  it('一个中文音色都没有时不硬塞，返回 undefined', () => {
    expect(pickVoice([v('Alex', 'en-US'), v('Daniel', 'en-GB')])).toBeUndefined()
  })

  it('空列表不炸 —— 音色是异步加载的，第一次调用常常是空的', () => {
    expect(pickVoice([])).toBeUndefined()
  })

  it('只认中文音色，英文的再"默认"也不选', () => {
    const got = pickVoice([{ ...v('Alex', 'en-US'), default: true } as any, v('Ting-Ting', 'zh-CN')])
    expect(got?.name).toBe('Ting-Ting')
  })

  /** 讲给大陆小孩听的故事，普通话优先于粤语和台湾腔 */
  it('zh-CN 优先于 zh-TW / zh-HK', () => {
    const got = pickVoice([v('美嘉', 'zh-TW'), v('Sin-ji', 'zh-HK'), v('Ting-Ting', 'zh-CN')])
    expect(got?.lang).toBe('zh-CN')
  })

  /**
   * 同为 zh-CN 时挑已知音质更好的那个。名单是**数据不是逻辑** ——
   * 各家浏览器暴露的高质量中文音色就那么几个，实测出来记在表里。
   */
  it('同为普通话时挑已知音质更好的', () => {
    const got = pickVoice([v('Chinese (China)', 'zh-CN'), v('Google 普通话（中国大陆）', 'zh-CN', false)])
    expect(got?.name).toContain('普通话')
  })

  it('没有名单内的音色时，退到任意一个普通话音色而不是放弃', () => {
    expect(pickVoice([v('某某中文音色', 'zh-CN')])?.lang).toBe('zh-CN')
  })

  it('zh 开头就算中文 —— 有些内核只报 zh 不带地区', () => {
    expect(pickVoice([v('中文', 'zh')])?.name).toBe('中文')
  })
})

/**
 * ══════════ 逐字点亮的时间兜底 ══════════
 *
 * `onboundary` 在中文上基本不来，所以要能纯靠时间推进。
 * 估时长必须**跟着 rate 走**，不然调慢语速之后字会先亮完，
 * 声音还在后面念 —— 比不亮更糟，孩子会跟丢。
 */
describe('估一句话要念多久', () => {
  it('中文按每秒几个字估，字越多越久', () => {
    expect(estimateMs('下雨了', 1)).toBeLessThan(estimateMs('下雨了妞妞撑着伞走在回家的路上', 1))
  })

  it('语速加倍，时长减半', () => {
    expect(estimateMs('下雨了妞妞撑着伞', 2)).toBeCloseTo(estimateMs('下雨了妞妞撑着伞', 1) / 2, 0)
  })

  it('空句子是 0，不要给一个凭空的等待', () => {
    expect(estimateMs('', 1)).toBe(0)
  })

  /** rate 传 0 或负数（模型/配置传错）时别除出 Infinity 卡死点亮 */
  it('语速为 0 时退到 1 倍速，不返回 Infinity', () => {
    expect(Number.isFinite(estimateMs('下雨了', 0))).toBe(true)
  })

  it('每秒字数取在正常朗读区间', () => {
    expect(CPS).toBeGreaterThan(2)
    expect(CPS).toBeLessThan(8)
  })
})

describe('某一刻该亮到第几个字', () => {
  it('刚开始一个字都不亮', () => {
    expect(litUpto(10, 0, 1000)).toBe(0)
  })

  it('念完就全亮', () => {
    expect(litUpto(10, 1000, 1000)).toBe(10)
    expect(litUpto(10, 9999, 1000)).toBe(10)
  })

  it('中间按比例，且单调不回退', () => {
    expect(litUpto(10, 500, 1000)).toBe(5)
    let last = 0
    for (let t = 0; t <= 1000; t += 50) {
      const n = litUpto(10, t, 1000)
      expect(n).toBeGreaterThanOrEqual(last)
      last = n
    }
  })

  /** 估不出时长（空句子、坏数据）时直接全亮 —— 卡在不亮是最糟的 */
  it('总时长为 0 或坏数据时全亮，不卡住', () => {
    expect(litUpto(10, 0, 0)).toBe(10)
    expect(litUpto(10, 0, NaN)).toBe(10)
  })
})
