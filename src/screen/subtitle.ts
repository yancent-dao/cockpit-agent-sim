/**
 * 字幕分句窗（Avatar 角落蒙层定稿 §03 超长播报）。
 *
 * 顶栏只有一行，TTS 却可能说一段。三道闸的第二道在这：按标点切句，
 * **跟着播放进度逐句换页**——讲到哪句显示哪句。不跑马灯：行驶中
 * 持续移动的文字是 HMI 大忌。时间点拿不到就用 speech.ts 的字速估算
 * （跟绘本逐字点亮同一套推法）。
 *
 * 全是纯函数：切句错一次就是"字幕和声音对不上"，放这配测试；
 * 定时器和 DOM 留在车机屏。
 */
import { estimateMs } from './speech'

/** 单行容量（字）。角落一行在 2560 宽实屏上约 20 个全角字号舒适可读 */
const MAX_LEN = 20
/** 比这短的碎片并进邻句——「好的」单独闪一页 400ms 是噪音 */
const MIN_LEN = 5

/**
 * 按标点切句：先按句读拆成带标点的小段，再贪心合并到不超过单行容量。
 * 尾部标点剥掉（显示用），没有标点的长串按容量硬切——内容一个字不丢。
 */
export function splitClauses(text: string, maxLen = MAX_LEN): string[] {
  const t = (text ?? '').trim()
  if (!t) return []
  // 带着分隔符切段（分隔符留在段尾，合并时天然保住句内标点）
  const segs = t.split(/(?<=[，。！？；、…\n])/).map(s => s.trim()).filter(Boolean)
  const out: string[] = []
  let cur = ''
  const flush = () => {
    const c = cur.replace(/[，。！？；、…\s]+$/, '')
    if (c) out.push(c)
    cur = ''
  }
  for (const seg of segs) {
    // 单段本身超宽：先清当前，再硬切
    if (seg.length > maxLen) {
      flush()
      let rest = seg.replace(/[，。！？；、…\s]+$/, '')
      while (rest.length > maxLen) { out.push(rest.slice(0, maxLen)); rest = rest.slice(maxLen) }
      if (rest) cur = rest
      continue
    }
    if (cur && (cur + seg).length > maxLen) flush()
    cur += seg
    // 攒够下限就可以出片了——再攒会把两句无关的话挤在一行
    if (cur.replace(/[，。！？；、…\s]+$/, '').length >= MIN_LEN &&
        segs.indexOf(seg) === segs.length - 1) flush()
  }
  flush()
  // 收尾合并：最后一片太短就并回前一片（前提是并完不超宽）
  if (out.length > 1) {
    const lastIdx = out.length - 1
    if (out[lastIdx].length < MIN_LEN && (out[lastIdx - 1] + out[lastIdx]).length <= maxLen + MIN_LEN) {
      out[lastIdx - 1] += '，' + out[lastIdx]
      out.pop()
    }
  }
  return out
}

/** 每片的开播时刻（ms）。首片 0，之后按前面各片的估算时长累加——语速变了表跟着变 */
export function clauseStarts(clauses: string[], rate: number): number[] {
  const starts: number[] = []
  let acc = 0
  for (const c of clauses) { starts.push(acc); acc += estimateMs(c, rate) }
  return starts
}

/** 已播 elapsed 毫秒时该显示第几片。播完停在最后一片；空表回 -1 */
export function clauseAt(starts: number[], elapsed: number): number {
  if (!starts.length) return -1
  let i = 0
  while (i + 1 < starts.length && starts[i + 1] <= elapsed) i++
  return i
}

/**
 * 思考态活动胶囊：只留最近 max 条（角落一行摆不下流水账，
 * 要的是"它此刻在干什么"不是完整日志——完整轨迹在 trace 里）。
 * 连续同文不重复，返回新数组不改入参。
 */
export function pushChip(list: string[], text: string, max = 2): string[] {
  const t = (text ?? '').trim()
  if (!t || list[list.length - 1] === t) return list
  return [...list, t].slice(-max)
}
