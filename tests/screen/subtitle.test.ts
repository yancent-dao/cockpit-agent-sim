import { describe, it, expect } from 'vitest'
import { splitClauses, clauseStarts, clauseAt, pushChip } from '../../src/screen/subtitle'
import { estimateMs } from '../../src/screen/speech'

/**
 * 字幕分句窗（Avatar 角落蒙层设计 §03 超长播报）。
 * 顶栏只有一行，TTS 却可能说一段——按标点切句，跟着播放进度逐句换页。
 * 不跑马灯：行驶中持续移动的文字是 HMI 大忌。
 */

describe('splitClauses：按标点切句，短段并邻，超长硬切', () => {
  it('一段多句话切成中等长度的句片', () => {
    const cls = splitClauses('好的，路线设好了，全程 12 公里预计 28 分钟。顺路有两个充电桩，都放在屏幕上了')
    expect(cls.length).toBeGreaterThan(1)
    // 每片都不超过单行容量
    for (const c of cls) expect(c.length).toBeLessThanOrEqual(20)
    // 内容一个字不丢（去掉标点后拼回去等于原文去标点）
    const strip = (s: string) => s.replace(/[，。！？；、…\s]/g, '')
    expect(cls.map(strip).join('')).toBe(strip('好的，路线设好了，全程 12 公里预计 28 分钟。顺路有两个充电桩，都放在屏幕上了'))
  })

  it('短句不切：整句就是一片，尾部句号剥掉', () => {
    expect(splitClauses('路线设好了。')).toEqual(['路线设好了'])
  })

  it('太短的碎片并进邻句，不单独占一页', () => {
    // 「好的」只有 2 个字，单独闪一页 400ms 是噪音
    const cls = splitClauses('好的，空调开到 24 度了')
    expect(cls[0]).toContain('好的')
    expect(cls[0].length).toBeGreaterThan(2)
  })

  it('没有标点的长串也要硬切，不许单片超宽', () => {
    const long = '一二三四五六七八九十'.repeat(4) // 40 字无标点
    const cls = splitClauses(long)
    expect(cls.length).toBeGreaterThan(1)
    for (const c of cls) expect(c.length).toBeLessThanOrEqual(20)
    expect(cls.join('')).toBe(long)
  })

  it('空文本回空表', () => {
    expect(splitClauses('')).toEqual([])
    expect(splitClauses('  ')).toEqual([])
  })
})

describe('clauseStarts：按字速估算每片的开播时刻', () => {
  it('首片从 0 开始，之后按前面各片的时长累加', () => {
    const cls = ['路线设好了', '全程 12 公里', '预计 28 分钟']
    const starts = clauseStarts(cls, 1)
    expect(starts[0]).toBe(0)
    expect(starts[1]).toBeCloseTo(estimateMs(cls[0], 1), 5)
    expect(starts[2]).toBeCloseTo(estimateMs(cls[0], 1) + estimateMs(cls[1], 1), 5)
  })

  it('语速调慢，时间表跟着拉长——不然字幕先跑完声音还在念', () => {
    const cls = ['路线设好了', '全程 12 公里']
    expect(clauseStarts(cls, 0.5)[1]).toBeGreaterThan(clauseStarts(cls, 1)[1])
  })
})

describe('clauseAt：已播 elapsed 毫秒时该显示第几片', () => {
  const starts = [0, 1000, 2500]
  it('落在哪片的窗口就显示哪片', () => {
    expect(clauseAt(starts, 0)).toBe(0)
    expect(clauseAt(starts, 999)).toBe(0)
    expect(clauseAt(starts, 1000)).toBe(1)
    expect(clauseAt(starts, 2499)).toBe(1)
    expect(clauseAt(starts, 2500)).toBe(2)
  })
  it('播完之后停在最后一片，不回卷不越界', () => {
    expect(clauseAt(starts, 99999)).toBe(2)
  })
  it('空表回 -1（调用方据此不渲染）', () => {
    expect(clauseAt([], 500)).toBe(-1)
  })
})

describe('pushChip：思考态活动胶囊，只留最近几条', () => {
  it('新胶囊追加在尾部，超出上限从头淘汰', () => {
    let l: string[] = []
    l = pushChip(l, '查天气')
    l = pushChip(l, '搜路线')
    l = pushChip(l, '算绕路')
    expect(l).toEqual(['搜路线', '算绕路'])
  })
  it('连续同文不重复入列，空文本不动', () => {
    let l = pushChip([], '查天气')
    expect(pushChip(l, '查天气')).toEqual(['查天气'])
    expect(pushChip(l, '')).toEqual(['查天气'])
  })
  it('不改入参（防御性）', () => {
    const l = ['a']
    pushChip(l, 'b')
    expect(l).toEqual(['a'])
  })
})
