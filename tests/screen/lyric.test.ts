import { describe, it, expect } from 'vitest'
import { parseLrc, lyricAt } from '../../src/screen/lyric'

/**
 * 歌词（媒体卡重设计 v2）：lrclib 返回标准 LRC 文本，解析与定位是纯函数。
 * 屏上只显两句：当前句深色 + 下一句淡色；行驶中只换句不滚动。
 */

const LRC = `[00:12.00]也许世间所有的路
[00:17.50]都通向光亮
[00:23.00]于是山川湖海
[00:28.80]都有了方向`

describe('parseLrc', () => {
  it('时间戳转秒，按时间排序', () => {
    const lines = parseLrc(LRC)
    expect(lines).toHaveLength(4)
    expect(lines[0]).toEqual({ t: 12, text: '也许世间所有的路' })
    expect(lines[1].t).toBeCloseTo(17.5)
  })
  it('乱序行排回来，空行/无戳行丢掉', () => {
    const lines = parseLrc('[00:20.00]后\n乱七八糟\n[00:10.00]前\n[00:15.00]')
    expect(lines.map(l => l.text)).toEqual(['前', '后'])
  })
  it('一行多戳（副歌复用）展开成多行', () => {
    const lines = parseLrc('[00:10.00][00:50.00]副歌')
    expect(lines).toHaveLength(2)
    expect(lines[1].t).toBe(50)
  })
  it('坏输入回空表', () => {
    expect(parseLrc('')).toEqual([])
    expect(parseLrc('not lrc at all')).toEqual([])
  })
})

describe('lyricAt', () => {
  const lines = parseLrc(LRC)
  it('落在哪句窗口给哪句 + 下一句', () => {
    expect(lyricAt(lines, 13)).toEqual({ cur: '也许世间所有的路', next: '都通向光亮' })
    expect(lyricAt(lines, 24)).toEqual({ cur: '于是山川湖海', next: '都有了方向' })
  })
  it('前奏（第一句之前）：预告第一句', () => {
    expect(lyricAt(lines, 3)).toEqual({ cur: '', next: '也许世间所有的路' })
  })
  it('最后一句之后停在最后一句，next 为空', () => {
    expect(lyricAt(lines, 999)).toEqual({ cur: '都有了方向', next: '' })
  })
  it('空表回空', () => {
    expect(lyricAt([], 10)).toEqual({ cur: '', next: '' })
  })
})
