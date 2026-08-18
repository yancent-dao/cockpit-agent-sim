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
 * 性别名单。**音色 API 不暴露性别**，只能按实测的名字表判断 ——
 * 所以这是数据不是逻辑，装不下的音色就"不知道"，别瞎猜。
 *
 * 讲儿童绘本默认要女声（产品要求，不是可选项）。macOS 那一串
 * Eddy/Reed/Rocko/Grandpa 是男声，Flo/Sandy/Shelley/Grandma/Tingting/Meijia 是女声。
 */
const FEMALE = /tingting|ting-ting|婷婷|meijia|美嘉|sin-?ji|xiaoxiao|xiaoyi|yaoyao|huihui|flo|sandy|shelley|grandma|普通话|female|女/i
const MALE = /eddy|reed|rocko|grandpa|yunxi|yunyang|kangkang|male|男/i

/** 名字表判断性别。判不出来就是 undefined —— "不知道"是个合法答案 */
const femaleOf = (name: string): boolean | undefined =>
  MALE.test(name) ? false : FEMALE.test(name) ? true : undefined

export interface VoiceChoice extends VoiceLike {
  /** 是不是女声。判不出来时缺省 —— 下拉框里就不标 */
  female?: boolean
}

/**
 * 这台机器上能挑的中文音色，供控制面板列出来。
 *
 * **逐个字段抄，不用 `{...v}`** —— 浏览器的 `SpeechSynthesisVoice` 把属性
 * 全放在原型上（都是 getter），展开出来是个空对象。实测下拉框里 18 个选项
 * 一个名字都没有；而单测里的假对象是普通字面量，展开正常，**永远抓不到**。
 */
export function zhVoices(voices: VoiceLike[]): VoiceChoice[] {
  return (voices ?? [])
    .filter(v => String(v?.lang ?? '').toLowerCase().startsWith('zh'))
    .map(v => ({
      name: v.name, lang: v.lang, localService: v.localService, default: v.default,
      female: femaleOf(v.name),
    }))
}

export interface PickOpts {
  /** 用户在控制面板里挑过的音色名。**压过所有排序** —— 挑过就听他的 */
  name?: string
}

/**
 * 挑一个能好好念中文的音色。
 *
 * **没有中文音色就返回 undefined**，让引擎自己按 lang 决定 ——
 * 硬塞一个英文音色去念中文比什么都不做更糟。
 *
 * 用户挑过就用他挑的（哪怕是英文音色，就是想听也随他）；挑的那个
 * 已经不在了（换机器、系统升级删了音色）就退回默认，不是整个哑掉。
 */
export function pickVoice(voices: VoiceLike[], opts: PickOpts = {}): VoiceLike | undefined {
  const all = voices ?? []
  if (opts.name) {
    const hit = all.find(v => v.name === opts.name)
    if (hit) return hit
  }
  const zh = all.filter(v => String(v?.lang ?? '').toLowerCase().startsWith('zh'))
  if (!zh.length) return undefined
  const score = (v: VoiceLike) => {
    let s = 0
    // 讲给大陆小孩听的故事，普通话优先于粤语和台湾腔
    if (/^zh([-_]cn)?$/i.test(v.lang)) s += 40
    // 女声优先。讲儿童绘本这不是可选项，所以权重压过"音质名单"
    const f = femaleOf(v.name)
    if (f === true) s += 30
    else if (f === false) s -= 30      // 已知男声排到"不知道性别"的后面
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

/* ══════════ 主对话话术的开口决策（2026-08-16 实拍补） ══════════
 *
 * speechSynthesis 以前只给绘本接了，主对话的 voice 消息一直只写屏不出声。
 * 念不念是决策，放这配测试；张嘴（speechSynthesis 调用）留在车机屏。
 */
export interface VoiceMsg { s?: string; text?: string | null; who?: string }
export type VoiceAct = 'speak' | 'hush' | 'ignore'

/**
 * 一条 voice 总线消息 → 念 / 闭嘴让位 / 不动。
 *
 * - Agent 的播报、确认问句、报错都念 —— 确认问句尤其不能哑：
 *   灰权限的问题不出声，用户根本不知道要答
 * - 用户开口（listening）→ hush：barge-in 的屏端半边，Agent 立刻闭嘴
 * - 绘本正在朗读时一律不动：cancel 是单通道全局的，会误伤正文
 *   并触发"读完翻页"的副作用；Agent 的衔接话术上屏就够了，不抢麦
 */
export function voiceAct(m: VoiceMsg, storyReading: boolean): VoiceAct {
  // 确认问句穿透绘本占麦（语音链路设计 §1）：安全类问题不排在故事后面。
  // 打断与恢复由 mic 仲裁的执行层管，这里只放行
  if (storyReading && m.s !== 'confirming') return 'ignore'
  if (m.who === 'user') return m.text ? 'hush' : 'ignore'
  if (m.who !== 'agent' || !m.text) return 'ignore'
  return (m.s === 'speaking' || m.s === 'confirming' || m.s === 'rejected') ? 'speak' : 'ignore'
}

/**
 * 两层话术的排队与去重（2026-08-17 实拍：快层话音未落被慢层拦腰切断，
 * 而慢层说的常常还是同一句 —— 校验通过时原文接力）。
 * 说话中 → 排队说完整；同轮同文 → 不重念；空文本 → 不动。
 * 用户插话的打断不走这里 —— hush 是 voiceAct 的事，语义不变。
 */
export function queueAct(text: string, speaking: boolean, lastText: string): 'speak' | 'queue' | 'skip' {
  const t = text.trim()
  if (!t || t === lastText) return 'skip'
  return speaking ? 'queue' : 'speak'
}
