import { describe, it, expect } from 'vitest'
import { CARD_FORMS, navForm, capForm, weatherForm, listForm } from '../../src/config/forms'

/**
 * 形态函数 = 「这个模板在这个大小下显示哪些块」。
 *
 * 签名从 `(size)` 换成 `(cols, rows)`：档位从 4 个涨到 10 个之后，
 * 按名字查表要写 11×10=110 组，不可能维护。改成按**几何阈值**判断——
 * 宽度只有 5 种取值（2/4/6/8/12）、高度 3 种（1/2/4），每个模板实际只关心 2–3 个阈值。
 *
 * 这也是「加能力 = 加数据不加代码」的落点：以后加档位只改 TIERS 表，形态函数一行不动。
 */

/** 十个档位的实际尺寸，测试里直接按名字用，读起来才有画面 */
const D = {
  chip: [2, 1], strip: [4, 1], bar: [6, 1],
  card: [4, 2], wide: [6, 2], panel: [8, 2], banner: [12, 2],
  tower: [4, 4], stage: [8, 4], full: [12, 4],
} as const
const f = (fn: any, t: keyof typeof D) => fn(D[t][0], D[t][1])
const has = (fn: any, t: keyof typeof D, b: string) => f(fn, t).blocks.includes(b)

describe('导航卡：转向条是命根子，地图先被砍', () => {
  it('stage / full / banner 是完整形态：转向条 + 地图 + 底部数据', () => {
    for (const t of ['banner', 'stage', 'full'] as const)
      for (const b of ['turn', 'map', 'foot'])
        expect(has(navForm, t, b), `${t}.${b}`).toBe(true)
  })

  // 一格宽的地图看不出路，不如把空间让给转向指令——真车机的小卡模式
  it('panel（原 1/3）退成小卡：没有地图，转向条和 ETA 都留着', () => {
    expect(f(navForm, 'panel').blocks).toEqual(['turn', 'foot'])
  })

  it('card（原 1/6）只剩转向指令，连 ETA 都放不下', () => {
    expect(f(navForm, 'card').blocks).toEqual(['turn'])
  })

  it('tower 高但窄，地图会变成一条竖缝 —— 不给地图', () => {
    expect(has(navForm, 'tower', 'map')).toBe(false)
    expect(has(navForm, 'tower', 'foot')).toBe(true)
  })

  it('单行档也保住转向条 —— 任何时候都不能不告诉用户下一步做什么', () => {
    for (const t of ['chip', 'strip', 'bar'] as const)
      expect(has(navForm, t, 'turn'), t).toBe(true)
  })
})

describe('列表卡：能显示几条由几何算，不查表', () => {
  it('越大的档位放得越多，严格单调', () => {
    const seq = (['card', 'panel', 'banner', 'stage', 'full'] as const).map(t => f(listForm, t).maxItems)
    for (let i = 1; i < seq.length; i++) expect(seq[i], `第 ${i} 档`).toBeGreaterThan(seq[i - 1])
  })

  it('card 放四条 —— 这是实测过的数字，别改', () => {
    expect(f(listForm, 'card').maxItems).toBe(4)
  })

  it('宽到 8 列就分两栏，12 列分三栏', () => {
    expect(f(listForm, 'panel').cols).toBe(2)
    expect(f(listForm, 'banner').cols).toBe(3)
    expect(f(listForm, 'card').cols).toBe(1)
  })

  // 单行档连一条带副标题的候选都放不下，硬塞等于骗用户「屏上有」
  it('单行档只报数量，一条都不列', () => {
    for (const t of ['chip', 'strip', 'bar'] as const) {
      expect(f(listForm, t).overflow, t).toBe('count')
      expect(f(listForm, t).maxItems, t).toBe(0)
    }
  })

  it('放得下的档位用 more 策略 —— 截断并写明还剩几条', () => {
    expect(f(listForm, 'card').overflow).toBe('more')
  })
})

/**
 * grid / list / count 是三种**互斥的渲染方式**，不是块的超集 ——
 * 所以走 `mode` 而不是 `blocks`，下面那条「档位变大不掉块」的单调性才管得住 blocks。
 */
describe('能力目录：33 项塞不进小卡就老实报个数', () => {
  it('stage / full 铺成网格', () => {
    for (const t of ['stage', 'full'] as const) expect(f(capForm, t).mode, t).toBe('grid')
  })

  it('banner / panel 列得下，一列排', () => {
    for (const t of ['banner', 'panel'] as const) expect(f(capForm, t).mode, t).toBe('list')
  })

  /**
   * 能显示几项要按**实际列数**算。list 模式只有一列，
   * 按三列的容量给就会切掉半行 —— 用户看到一条被拦腰截断的能力，
   * 比不显示更糟（他会以为那就是全部）。
   */
  it('list 模式按一列算容量，不按三列', () => {
    expect(f(capForm, 'banner').maxItems).toBe(4)   // 12×2 一列 = 4 条
    expect(f(capForm, 'panel').maxItems).toBe(4)
  })

  it('grid 模式才按多列算', () => {
    expect(f(capForm, 'full').maxItems).toBeGreaterThan(f(capForm, 'banner').maxItems!)
  })

  it('card 及以下只报数量', () => {
    for (const t of ['card', 'chip'] as const) {
      expect(f(capForm, t).mode, t).toBe('count')
      expect(f(capForm, t).overflow, t).toBe('count')
    }
  })
})

describe('天气卡：温度当主角，预报按空间加', () => {
  // card 是它的默认档，也是最常出现的形态。挤 6 行小字就主次不分了
  it('card 只讲此刻：温度大字，不放预报', () => {
    const r = f(weatherForm, 'card')
    expect(r.blocks).toContain('temp')
    expect(r.blocks).not.toContain('forecast')
  })

  it('panel 放得下三天，纵向排', () => {
    const r = f(weatherForm, 'panel')
    expect(r.maxItems).toBe(3)
    expect(r.cols).toBe(1)
  })

  it('banner 横着排预报，别让内容缩在左上角', () => {
    expect(f(weatherForm, 'banner').cols).toBeGreaterThan(1)
  })

  it('stage / full 放得下五天', () => {
    expect(f(weatherForm, 'full').maxItems).toBe(5)
  })
})

describe('播放器卡：封面/歌名/播控任何档位都在，进度条和队列按空间加', () => {
  const m = CARD_FORMS.media

  // 用户实拍：最小档只剩一行歌名，"连图片都没有"，想停都没按钮。
  // 封面是媒体卡的身份证，播控是它存在的意义——这三样不许砍
  it('最小档也认得出在放什么、停得下来：封面+歌名+播控', () => {
    for (const t of ['chip', 'strip', 'card', 'panel', 'stage'] as const) {
      expect(has(m, t, 'art'), `${t} 封面`).toBe(true)
      expect(has(m, t, 'title'), `${t} 歌名`).toBe(true)
      expect(has(m, t, 'bar') || has(m, t, 'toggle'), `${t} 播控`).toBe(true)
    }
  })

  // 用户实拍：1/6 卡（786×470px）只给单键，大片空白。这个面积放得下三键+进度
  it('card 档（4×2）就放完整进度条三键，别只给单键', () => {
    expect(has(m, 'card', 'bar')).toBe(true)
    expect(has(m, 'bar', 'bar')).toBe(true)     // 6 列一行档也放
  })

  it('一行的小档（chip/strip）退到单键——三键挤不下', () => {
    expect(has(m, 'chip', 'bar')).toBe(false)
    expect(has(m, 'strip', 'bar')).toBe(false)
    expect(has(m, 'chip', 'toggle')).toBe(true)
    expect(has(m, 'strip', 'toggle')).toBe(true)
  })

  it('半高以上带一行「说换一台就行」的语音提示', () => {
    expect(has(m, 'panel', 'hint')).toBe(true)
    expect(has(m, 'strip', 'hint')).toBe(false)
  })

  it('panel 档起报"接下来"队列预告——大卡不许大片留白', () => {
    expect(has(m, 'panel', 'next')).toBe(true)
    expect(has(m, 'card', 'next')).toBe(false)
  })
})

describe('确认卡：要做什么永远在，为什么可以砍', () => {
  const c = CARD_FORMS.confirm

  it('任何档位都说得清「要做什么」和「怎么答」', () => {
    for (const t of ['card', 'panel', 'stage'] as const) {
      expect(has(c, t, 'what'), t).toBe(true)
      expect(has(c, t, 'hint'), t).toBe(true)
    }
  })

  it('panel 及以上补上「为什么要确认」', () => {
    expect(has(c, 'panel', 'why')).toBe(true)
    expect(has(c, 'card', 'why')).toBe(false)
  })
})

describe('11 个模板全覆盖，没有漏网的', () => {
  const NAMES = ['nav', 'control', 'confirm', 'feedback', 'notice',
    'list', 'info', 'media', 'weather', 'capability', 'generic']

  it('每个模板都有形态函数', () => {
    for (const n of NAMES) expect(typeof CARD_FORMS[n], n).toBe('function')
  })

  /** 任何档位都不能返回空 blocks —— 那是一张白卡，比不显示更糟 */
  it('10 档 × 11 模板，没有一组是空的', () => {
    for (const n of NAMES)
      for (const t of Object.keys(D) as (keyof typeof D)[])
        expect(f(CARD_FORMS[n], t).blocks.length, `${n}@${t}`).toBeGreaterThan(0)
  })

  it('块名不重复 —— 重复意味着同一块画两遍', () => {
    for (const n of NAMES)
      for (const t of Object.keys(D) as (keyof typeof D)[]) {
        const bs = f(CARD_FORMS[n], t).blocks
        expect(new Set(bs).size, `${n}@${t}`).toBe(bs.length)
      }
  })

  /** 单调性：大档位显示的块必须是小档位的超集，不能"变大了反而少一块" */
  it('档位变大不会掉块', () => {
    const chain = ['card', 'panel', 'banner', 'full'] as const
    for (const n of NAMES)
      for (let i = 1; i < chain.length; i++) {
        const small = f(CARD_FORMS[n], chain[i - 1]).blocks
        const big = f(CARD_FORMS[n], chain[i]).blocks
        for (const b of small)
          expect(big, `${n}: ${chain[i]} 掉了 ${chain[i - 1]} 有的 ${b}`).toContain(b)
      }
  })
})
