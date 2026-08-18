import { describe, it, expect } from 'vitest'
import { pickVoice, zhVoices, estimateMs, litUpto, CPS } from '../../src/screen/speech'

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

/**
 * ══════════ 音色由用户挑，默认女声 ══════════
 *
 * 实拍要求（2026-08-14）：「TTS 模型我想自己选一下，音色是女生」。
 *
 * 两件事：① 控制面板要能列出这台机器上的中文音色让人挑；
 * ② 没挑之前的默认值要是**女声** —— 讲儿童绘本，这不是可选项。
 * 性别名单是**数据**：音色 API 不暴露性别，只能按实测的名字表判断。
 */
const V = (name: string, lang = 'zh-CN') => ({ name, lang, localService: true })

describe('列出可选的中文音色', () => {
  it('只列中文的，英文音色不进下拉框', () => {
    const l = zhVoices([V('Alex', 'en-US'), V('Tingting'), V('Meijia', 'zh-TW')])
    expect(l.map(v => v.name)).toEqual(['Tingting', 'Meijia'])
  })

  it('每一项标出是不是女声 —— 家长挑的时候要看得见', () => {
    const l = zhVoices([V('Tingting'), V('Eddy (Chinese (China mainland))')])
    expect(l.find(v => v.name === 'Tingting')!.female).toBe(true)
    expect(l.find(v => v.name.startsWith('Eddy'))!.female).toBe(false)
  })

  it('名单外的音色不瞎猜性别', () => {
    expect(zhVoices([V('某某音色')])[0].female).toBeUndefined()
  })
})

describe('默认挑女声', () => {
  it('同为普通话时女声优先 —— 讲绘本这不是可选项', () => {
    expect(pickVoice([V('Eddy (Chinese (China mainland))'), V('Tingting')])?.name).toBe('Tingting')
  })

  it('已知男声排在没标性别的后面', () => {
    const got = pickVoice([V('Grandpa (Chinese (China mainland))'), V('某某音色')])
    expect(got?.name).toBe('某某音色')
  })

  it('只有男声时还是给一个，不至于没声音', () => {
    expect(pickVoice([V('Grandpa (Chinese (China mainland))')])?.name).toContain('Grandpa')
  })
})

describe('用户挑过就听用户的', () => {
  it('按名字选中，压过所有排序', () => {
    const vs = [V('Tingting'), V('Grandma (Chinese (China mainland))')]
    expect(pickVoice(vs, { name: 'Grandma (Chinese (China mainland))' })?.name).toContain('Grandma')
  })

  /** 换了台机器、系统升级删了音色 —— 别因为选过的那个没了就整个哑掉 */
  it('选过的音色不在了就退回默认，不是返回 undefined', () => {
    expect(pickVoice([V('Tingting')], { name: '已经卸载的音色' })?.name).toBe('Tingting')
  })

  it('用户能挑非中文音色（就是想听英文腔也随他）', () => {
    const vs = [V('Tingting'), V('Alex', 'en-US')]
    expect(pickVoice(vs, { name: 'Alex' })?.name).toBe('Alex')
  })
})

/**
 * **`SpeechSynthesisVoice` 的属性挂在原型上**（都是 getter），
 * 所以 `{...voice}` 展开出来是个空对象 —— 浏览器实测：下拉框里 18 个选项
 * 全都没有名字。假对象是普通字面量，展开正常，单测**永远抓不到这个**。
 */
describe('真实 voice 对象的属性在原型上', () => {
  it('展开原型上的属性也拿得到 name/lang', () => {
    class FakeVoice {                       // 模仿浏览器：属性全在原型
      get name() { return 'Tingting' }
      get lang() { return 'zh-CN' }
      get localService() { return true }
    }
    const l = zhVoices([new FakeVoice() as any])
    expect(l).toHaveLength(1)
    expect(l[0].name, '名字不能丢').toBe('Tingting')
    expect(l[0].lang).toBe('zh-CN')
    expect(l[0].female).toBe(true)
  })
})

/**
 * ══════════ 主对话话术要念出来（2026-08-16 实拍） ══════════
 *
 * 「车机上没有 TTS，avatar 后面展示的文字没有播报」—— speechSynthesis
 * 整条链路只给绘本接了，主对话的 voice 消息一直只写屏不开口。
 *
 * 决策抽成纯函数：一条 voice 总线消息进来，念（speak）、闭嘴让位（hush）、
 * 还是不动（ignore）。绘本正在朗读时 Agent 的衔接话术不抢麦 ——
 * 画外音把正文顶掉，孩子听到的故事就断了。
 */
import { voiceAct } from '../../src/screen/speech'

describe('voiceAct：主对话话术该不该念', () => {
  it('Agent 播报有文字 → 念', () => {
    expect(voiceAct({ s: 'speaking', text: '空调调到24度了', who: 'agent' }, false)).toBe('speak')
  })
  it('确认问句也要念 —— 灰权限的问题不出声，用户根本不知道要答', () => {
    expect(voiceAct({ s: 'confirming', text: '确定要打开车门吗', who: 'agent' }, false)).toBe('speak')
  })
  it('拒绝带文字 → 念；不带文字 → 不动', () => {
    expect(voiceAct({ s: 'rejected', text: '出错了：额度不足', who: 'agent' }, false)).toBe('speak')
    expect(voiceAct({ s: 'rejected' }, false)).toBe('ignore')
  })
  it('用户开口（listening）→ 闭嘴让位，这是 barge-in 的屏端半边', () => {
    expect(voiceAct({ s: 'listening', text: '等一下', who: 'user' }, false)).toBe('hush')
  })
  it('thinking 的 null 光标、idle 的清空 → 不动', () => {
    expect(voiceAct({ s: 'thinking', text: null }, false)).toBe('ignore')
    expect(voiceAct({ s: 'idle', text: '' }, false)).toBe('ignore')
    expect(voiceAct({ s: 'executing' }, false)).toBe('ignore')
  })
  it('绘本正在朗读 → Agent 话术不抢麦（只上屏不出声）', () => {
    expect(voiceAct({ s: 'speaking', text: '好，接着讲', who: 'agent' }, true)).toBe('ignore')
  })
  it('绘本正在朗读，用户开口也不 hush —— cancel 会误伤正文并触发翻页副作用', () => {
    expect(voiceAct({ s: 'listening', text: '停一下', who: 'user' }, true)).toBe('ignore')
  })
})

/**
 * ══════════ 快慢两层的话术会撞车（2026-08-17 实拍） ══════════
 *
 * 快层先说、慢层跟着说，旧行为是后到的直接掐断前一句 —— 快层话音未落
 * 被拦腰切断，而慢层说的常常还是同一句话（校验通过时原文接力），
 * 等于剪断一句去重复一遍。
 *
 * 三条规则：说话中 → 排队（一句话说完整）；同轮同文 → 不重念；
 * 用户插话 → 立刻闭嘴清队（hush 语义不变）。
 */
import { queueAct } from '../../src/screen/speech'

describe('queueAct：两层话术的排队与去重', () => {
  it('没在说话 → 直接说', () => {
    expect(queueAct('空调开好了', false, '')).toBe('speak')
  })
  it('正在说话 → 排队，不掐断', () => {
    expect(queueAct('外面在下雨，慢点开', true, '空调开好了')).toBe('queue')
  })
  it('同一句话不念两遍 —— 慢层原文接力是最常见的撞车形态', () => {
    expect(queueAct('主驾车窗已关。', true, '主驾车窗已关。')).toBe('skip')
    expect(queueAct('主驾车窗已关。', false, '主驾车窗已关。')).toBe('skip')
  })
  it('空文本不说也不排队', () => {
    expect(queueAct('  ', false, '')).toBe('skip')
  })
})

/**
 * 语音链路设计 §1：确认问句可以打断绘本——安全类问题（灰权限确认、
 * voice.ask）不能排在故事后面。普通话术仍然不抢麦（现状保持）。
 */
describe('voiceAct：确认问句穿透绘本占麦', () => {
  it('绘本朗读中，confirming 照说（由 mic 仲裁去打断绘本页）', () => {
    expect(voiceAct({ s: 'confirming', text: '确定要打开后备箱吗', who: 'agent' }, true)).toBe('speak')
  })
  it('绘本朗读中，普通播报仍然不抢麦', () => {
    expect(voiceAct({ s: 'speaking', text: '好，接着讲', who: 'agent' }, true)).toBe('ignore')
  })
})
