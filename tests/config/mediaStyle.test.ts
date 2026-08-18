import { describe, it, expect } from 'vitest'
import { SOURCE_STYLE, sourceStyle } from '../../src/config/mediaStyle'
import { routeOf } from '../../src/config/interactions'

/**
 * 媒体卡分源样式表（媒体卡重设计 v2 §03）：五源共用同一套骨架，
 * 差异全部由 data.source 查表驱动——渲染代码里不许出现
 * if source === 'music' 的散逻辑，加新源 = 表里加一行。
 */

describe('SOURCE_STYLE 五源表', () => {
  it('五个源都有完整的一行', () => {
    for (const s of ['music', 'radio', 'podcast', 'news', 'video']) {
      const st = SOURCE_STYLE[s]
      expect(st, s).toBeTruthy()
      for (const k of ['badge', 'accent', 'glow', 'progress', 'ctl'] as const)
        expect(st[k], `${s}.${k}`).toBeTruthy()
    }
  })

  it('进度带形态各归其位：音乐可拖、电台直播无进度、视频浮层', () => {
    expect(SOURCE_STYLE.music.progress).toBe('bar')
    expect(SOURCE_STYLE.podcast.progress).toBe('bar')
    expect(SOURCE_STYLE.radio.progress).toBe('live')
    expect(SOURCE_STYLE.video.progress).toBe('overlay')
  })

  it('主控语义各归其位：播客 ±15s，新闻上下条，电台单键', () => {
    expect(SOURCE_STYLE.podcast.ctl).toBe('skip')
    expect(SOURCE_STYLE.radio.ctl).toBe('single')
    expect(SOURCE_STYLE.music.ctl).toBe('tracks')
    expect(SOURCE_STYLE.news.ctl).toBe('tracks')
  })

  it('未知源回退音乐样式，不炸', () => {
    expect(sourceStyle('nonsense')).toEqual(SOURCE_STYLE.music)
  })
})

describe('媒体卡交互声明（全部直调工具，不叫醒模型）', () => {
  it('进度点按 → media.seek，值参进 position', () => {
    const d = routeOf('media', 'tap:seek')
    expect(d?.route).toBe('tool')
    expect(d?.tool).toBe('media.seek')
    expect(d?.valueParam).toBe('position')
  })
  it('音量点按 → media.volume，值参进 level', () => {
    const d = routeOf('media', 'tap:vol')
    expect(d?.tool).toBe('media.volume')
    expect(d?.valueParam).toBe('level')
  })
  it('模式/收藏/倍速/±15s 都是真按钮', () => {
    expect(routeOf('media', 'tap:mode')?.tool).toBe('media.mode')
    expect(routeOf('media', 'tap:fav')?.tool).toBe('media.favorite')
    expect(routeOf('media', 'tap:speed')?.tool).toBe('media.control')
    expect(routeOf('media', 'tap:back15')?.tool).toBe('media.seek')
    expect(routeOf('media', 'tap:fwd30')?.tool).toBe('media.seek')
    expect((routeOf('media', 'tap:back15')?.args as any)?.delta).toBe(-15)
    expect((routeOf('media', 'tap:fwd30')?.args as any)?.delta).toBe(30)
  })
  it('队列点播 → media.control jump，值参进 index', () => {
    const d = routeOf('media', 'tap:item')
    expect(d?.tool).toBe('media.control')
    expect((d?.args as any)?.action).toBe('jump')
    expect(d?.valueParam).toBe('index')
  })
})
