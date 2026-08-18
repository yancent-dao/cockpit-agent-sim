/**
 * 歌词（媒体卡重设计 v2）：lrclib 给标准 LRC 文本，解析与定位是纯函数。
 * 屏上只显两句：当前句深色 + 下一句淡色。行驶中只换句不滚动——
 * 持续移动的文字是 HMI 大忌（同字幕分句窗一条纪律）。
 */

export interface LrcLine { t: number; text: string }

/** [mm:ss.xx] 时间戳；一行多戳（副歌复用）展开成多行 */
export function parseLrc(raw: string): LrcLine[] {
  const out: LrcLine[] = []
  for (const line of String(raw ?? '').split('\n')) {
    const stamps = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g)]
    if (!stamps.length) continue
    const text = line.replace(/\[[^\]]*\]/g, '').trim()
    if (!text) continue
    for (const m of stamps) {
      const t = Number(m[1]) * 60 + Number(m[2]) + Number(`0.${m[3] ?? '0'}`)
      out.push({ t, text })
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

/** 播放到 sec 秒时该显示的两句。前奏期 cur 空、next 预告第一句 */
export function lyricAt(lines: LrcLine[], sec: number): { cur: string; next: string } {
  if (!lines.length) return { cur: '', next: '' }
  let i = -1
  while (i + 1 < lines.length && lines[i + 1].t <= sec) i++
  return { cur: i >= 0 ? lines[i].text : '', next: lines[i + 1]?.text ?? '' }
}
