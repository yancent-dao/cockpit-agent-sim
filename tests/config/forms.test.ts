import { describe, it, expect } from 'vitest'
import {
  CARD_FORMS, navForm, capForm, weatherForm, listForm, mediaForm,
  controlForm, confirmForm, noticeForm, feedbackForm, storybookForm, suggestSize,
} from '../../src/config/forms'
import { dimsOf, tierNames } from '../../src/config/grid'
import { CARD_TEMPLATES } from '../../src/config/cards'

/**
 * 形态函数 = 「这个模板在这个形状下显示哪些块」。
 *
 * 签名是 `(cols, rows)` 而不是 `(size)`：形状从 4 个涨到 14 个之后，
 * 按名字查表要写 14×14=196 组，不可能维护。改成按**几何阈值**判断——
 * 宽度只有 5 种取值（2/4/6/8/12）、高度 4 种（2/4/6/8），每个模板只关心 2–3 个阈值。
 *
 * 这也是「加能力 = 加数据不加代码」的落点：加形状只改 TIERS 表，形态函数一行不动。
 */

/**
 * 形状尺寸**从 grid 派生**，不再手抄一张表。
 * 上一版这里硬编码了十个档位的 [w,h]，栅格一改就是两份真相打架 ——
 * 12×8 迁移时这张表整个失效，而测试还在按旧数字断言"通过"。
 */
const f = (fn: any, t: string) => fn(...dimsOf(t))
const has = (fn: any, t: string, b: string) => f(fn, t).blocks.includes(b)
/** 某个模板实际声明的形状池 —— 断言只在模板真会用到的形状上做 */
const poolOf = (id: string) => CARD_TEMPLATES.find(t => t.id === id)!.sizes!

/* ══════════════ 通用不变量 ══════════════ */
describe('形态的通用不变量', () => {
  /**
   * **相邻两档的内容必须不同** —— 这一版最核心的判据。
   *
   * 上一轮只改了尺寸数组没同步改形态函数，于是确认卡/提示卡/反馈卡三档
   * 在屏幕上长得一模一样：用户点放大，卡变大了，内容没变。靠人眼守不住，
   * 必须有测试盯着。
   */
  it('每个模板相邻两档的内容都不一样', () => {
    for (const t of CARD_TEMPLATES) {
      const fn = CARD_FORMS[t.id]
      if (!fn) continue                       // canvas 类没有形态函数，内容由模型生成
      const sizes = t.sizes ?? []
      for (let i = 1; i < sizes.length; i++) {
        const a = f(fn, sizes[i - 1]), b = f(fn, sizes[i])
        const same = JSON.stringify([a.blocks, a.maxItems, a.mode, a.cols, a.hours])
          === JSON.stringify([b.blocks, b.maxItems, b.mode, b.cols, b.hours])
        expect(same, `${t.id} 的 ${sizes[i - 1]} 和 ${sizes[i]} 内容完全相同 —— 这一档白给`).toBe(false)
      }
    }
  })

  /** 块只增不减：档位变大不该掉块，否则放大反而看得更少 */
  it('形状变大不掉块', () => {
    for (const t of CARD_TEMPLATES) {
      const fn = CARD_FORMS[t.id]
      if (!fn || !t.sizes) continue
      for (let i = 1; i < t.sizes.length; i++) {
        const prev = f(fn, t.sizes[i - 1]).blocks as string[]
        const next = f(fn, t.sizes[i]).blocks as string[]
        // mode 型模板（能力目录）走互斥渲染，不适用叠加单调性
        if (f(fn, t.sizes[i]).mode) continue
        for (const b of prev)
          expect(next, `${t.id} 从 ${t.sizes[i - 1]} 放大到 ${t.sizes[i]} 反而掉了 ${b}`).toContain(b)
      }
    }
  })

  it('任何形状都算得出形态，不会抛', () => {
    for (const id of Object.keys(CARD_FORMS))
      for (const s of tierNames())
        expect(() => f(CARD_FORMS[id], s), `${id}@${s}`).not.toThrow()
  })
})

/* ══════════════ 导航 ══════════════ */
describe('导航卡：转向条是命根子，中档必须有地图', () => {
  /**
   * 2026-08-14 实拍反馈："中等尺寸的情况下没有地图不合理，中间看着非常空"。
   * 根因是上一版判据要求宽 ≥8，而中档 tower 只有 4 列宽 —— 条件永远不满足。
   * 换成 hall(6×6) 之后地图有 500px 高，正好是"前方一段路"的形状。
   */
  it('中档 hall 和最大档 stage 都有地图', () => {
    for (const t of ['hall', 'stage'])
      for (const b of ['turn', 'map', 'eta'])
        expect(has(navForm, t, b), `${t}.${b}`).toBe(true)
  })

  it('最小档 strip 没有地图，但转向和到达时刻都留着', () => {
    expect(f(navForm, 'strip').blocks).toEqual(['dest', 'turn', 'eta'])
  })

  /**
   * 到达时刻是 Android for Cars 的 TravelEstimate 里的**必填**字段 ——
   * 人真正想知道的是"几点到"，不是"还要多久"。所以最小档也给。
   */
  it('到达时刻任何档位都在', () => {
    for (const t of poolOf('nav')) expect(has(navForm, t, 'eta'), t).toBe(true)
  })

  /** 车道指引跟着地图走：没地图的扁条档放不下五个车道箭头 */
  it('车道指引只在有地图的档出现', () => {
    for (const t of poolOf('nav'))
      expect(has(navForm, t, 'lane'), t).toBe(has(navForm, t, 'map'))
  })

  it('窄而高的形状不给地图 —— 一格宽的地图看不出路', () => {
    expect(has(navForm, 'tower', 'map'), 'tower 4×8 只有 797px 宽').toBe(false)
  })

  /**
   * dest 是恒在块：没有高德 Key 的降级演示里 turn 是空串，
   * 只声明 turn 的话所有块 display:none，桌面上留一条只有边框的空玻璃条。
   */
  it('目的地名任何档位都在 —— 否则降级演示会留一条空玻璃条', () => {
    for (const s of tierNames()) expect(f(navForm, s).blocks, s).toContain('dest')
  })
})

/* ══════════════ 列表 ══════════════ */
describe('列表卡：条数由几何算，且形状一律是竖的', () => {
  /**
   * 2026-08-14 实拍反馈："列表类的内容最好使用竖的卡片，不要使用很长的
   * 横向卡，比例很不协调"。上一版最大档是 12×4 的通栏横条，16 条铺 4 栏，
   * 每条 600px 宽却只有 100px 高，而且眼睛要在四列之间来回跳。
   */
  it('三档全是竖的或近方的 —— 没有宽高比超过 2 的', () => {
    for (const s of poolOf('list')) {
      const [c, r] = dimsOf(s)
      expect(c / r, `${s} 的单元宽高比 ${c}:${r}`).toBeLessThanOrEqual(1)
    }
  })

  it('条数 4 → 8 → 16，栏数 1 → 1 → 2', () => {
    expect(f(listForm, 'box')).toMatchObject({ maxItems: 4, cols: 1 })
    expect(f(listForm, 'tower')).toMatchObject({ maxItems: 8, cols: 1 })
    expect(f(listForm, 'court')).toMatchObject({ maxItems: 16, cols: 2 })
  })

  /** 两栏是上限：再多就回到"横向扫描"的老问题 */
  it('列表最多两栏，宽度再大也不给三栏', () => {
    for (const s of tierNames()) expect(f(listForm, s).cols, s).toBeLessThanOrEqual(2)
  })

  it('越大的形状放得越多，严格单调', () => {
    const caps = poolOf('list').map(s => f(listForm, s).maxItems!)
    for (let i = 1; i < caps.length; i++)
      expect(caps[i], `第 ${i} 档`).toBeGreaterThan(caps[i - 1])
  })

  it('放得下就用 more 策略 —— 截断并写明还剩几条', () => {
    for (const s of poolOf('list')) expect(f(listForm, s).overflow, s).toBe('more')
  })

  /** 单行档（231px 高）连一条带副标题的候选都放不下，老实报个数 */
  it('单行形状容量为零，走 count', () => {
    for (const s of ['chip', 'strip', 'bar'])
      expect(f(listForm, s)).toMatchObject({ maxItems: 0, overflow: 'count' })
  })
})

/* ══════════════ 能力目录 ══════════════ */
describe('能力目录：两档，砍掉了"只报个数"的最小档', () => {
  /** 用户问"你能做什么"，屏幕回答一个数字「33 项」不是答案 */
  it('两档都是网格模式，不再有 count 档', () => {
    for (const s of poolOf('capability'))
      expect(f(capForm, s).mode, s).toBe('grid')
  })

  it('court 两栏 16 项，full 四栏 32 项', () => {
    expect(f(capForm, 'court')).toMatchObject({ mode: 'grid', cols: 2, maxItems: 16 })
    expect(f(capForm, 'full')).toMatchObject({ mode: 'grid', cols: 4, maxItems: 32 })
  })

  /**
   * 容量按**实际列数**算。照多列的容量给而只排一列，会切掉半行 ——
   * 用户看到一条被拦腰截断的能力比不显示更糟，他会以为那就是全部。
   */
  it('容量跟实际列数一致，不会算多', () => {
    for (const s of tierNames()) {
      const form = f(capForm, s)
      if (form.mode === 'count') { expect(form.maxItems, s).toBe(0); continue }
      expect(form.maxItems! % form.cols!, `${s} 容量 ${form.maxItems} 不是 ${form.cols} 的整数倍`).toBe(0)
    }
  })
})

/* ══════════════ 天气 ══════════════ */
describe('天气卡：主角是逐小时不是多日', () => {
  /**
   * 2026-08-14 调研结论：车里最想知道的是"接下来一两小时会不会下雨"，
   * 5 天预报是手机首页的逻辑。通行判据是「一秒读懂：当前温度、
   * 下一次降水、今日温差、预警状态」。
   */
  it('三档差异是 0 / 6 / 12 小时', () => {
    expect(f(weatherForm, 'tile').hours).toBe(0)
    expect(f(weatherForm, 'wide').hours).toBe(6)
    expect(f(weatherForm, 'band').hours).toBe(12)
  })

  /** 今日最高/最低是最基本的一项，上一版连大档都没有 */
  it('今日温差任何档位都在', () => {
    for (const s of poolOf('weather')) expect(has(weatherForm, s, 'range'), s).toBe(true)
  })

  /**
   * 5 天预报以前要求面积 ≥32，而天气卡最大档面积只有 24 —— **永远走不到**。
   * 判据改成看宽度：只有通栏才排得下 5 天。
   */
  it('5 天预报只在通栏出现，而且真的到得了', () => {
    expect(f(weatherForm, 'band').days).toBe(5)
    expect(f(weatherForm, 'wide').days).toBe(0)
  })
})

/* ══════════════ 播放器（2026-08-19 重设计 v2：blocks 改版）══════════════ */
describe('播放器卡：封面/歌名/播控任何档位都在', () => {
  it('封面/标题/进度/主控是命根子，三档都有', () => {
    for (const s of poolOf('media'))
      for (const b of ['art', 'title', 'bar', 'ctl'])
        expect(has(mediaForm, s, b), `${s}.${b}`).toBe(true)
  })

  /** 4×4 的卡实际有 745×442px，三键+进度绰绰有余——只给单键就是大片空白 */
  it('最小档就给完整进度条，不是单键', () => {
    expect(has(mediaForm, 'box', 'bar')).toBe(true)
  })

  /**
   * 上一版最大档跟中档的 blocks **完全相同**而高度翻倍，一半是空的。
   * 现在每档都有独占的块。
   */
  it('中档多出全套播控与队列预告，最大档再多出完整队列', () => {
    expect(has(mediaForm, 'box', 'extras'), 'box 不该有次控排').toBe(false)
    expect(has(mediaForm, 'box', 'meta'), 'box 不该有元信息带').toBe(false)
    expect(has(mediaForm, 'hall', 'extras'), 'hall 该有次控排').toBe(true)
    expect(has(mediaForm, 'hall', 'meta'), 'hall 该有元信息带').toBe(true)
    expect(has(mediaForm, 'hall', 'aux'), 'hall 该有辅助内容区（歌词/shownotes/电平）').toBe(true)
    expect(has(mediaForm, 'hall', 'next'), 'hall 该有接下来预告').toBe(true)
    expect(has(mediaForm, 'hall', 'queue'), 'hall 放不下完整队列').toBe(false)
    expect(has(mediaForm, 'court', 'queue'), 'court 该有完整队列').toBe(true)
  })
})

/**
 * ══════════ 绘本卡：翻页是主交互，不是宽了才配有 ══════════
 *
 * 实拍反馈「也没有翻页，我想我自己可以点击翻页」。查下来根因在这：
 * `ctl` 原来只在 c>=12（full 档）才给，而**默认档是 stage（8 列）** ——
 * 用户看到的那张卡上根本没有翻页键。
 *
 * 翻页之于绘本，等同于播控之于播放器卡：那条测试写的是"封面和播控是命根子，
 * 三档都有"，绘本卡该守同一条。
 */
describe('绘本卡：翻页键三档都在', () => {
  it('每个档位都有翻页控制', () => {
    for (const s of poolOf('storybook'))
      expect(has(storybookForm, s, 'ctl'), `${s} 缺翻页键`).toBe(true)
  })

  it('画面和正文任何档都在 —— 少一个就不是绘本了', () => {
    for (const s of poolOf('storybook'))
      for (const b of ['art', 'line', 'dots'])
        expect(has(storybookForm, s, b), `${s}.${b}`).toBe(true)
  })

  /** 三档的差异仍要落在内容密度上，不能因为补了 ctl 就变成同一张 */
  it('档位差异仍在：章节名 → 孩子的点子', () => {
    expect(has(storybookForm, 'court', 'chapter'), 'court 放不下章节行').toBe(false)
    expect(has(storybookForm, 'stage', 'chapter')).toBe(true)
    expect(has(storybookForm, 'stage', 'lesson'), 'stage 放不下点子行').toBe(false)
    expect(has(storybookForm, 'full', 'lesson')).toBe(true)
  })
})

/* ══════════════ 车控 / 确认 / 提示 / 反馈 ══════════════ */
describe('车控卡：车身图终于画得出来了', () => {
  /**
   * 这块图要求高度 ≥4 行，而上一版车控卡的档位只有 1/2/2 行 ——
   * **条件不可能满足**，图画好了从没在屏幕上出现过（代码审查发现的死代码）。
   */
  it('只有通高的 tower 画车身图', () => {
    expect(has(controlForm, 'tower', 'vehicle')).toBe(true)
    expect(has(controlForm, 'box', 'vehicle')).toBe(false)
    expect(has(controlForm, 'tile', 'vehicle')).toBe(false)
  })

  it('状态列表任何档位都在', () => {
    for (const s of poolOf('control')) expect(has(controlForm, s, 'items'), s).toBe(true)
  })
})

describe('确认卡与提示卡：两档，且真的不一样', () => {
  it('确认卡大档多出「为什么要问你」', () => {
    expect(has(confirmForm, 'box', 'why')).toBe(false)
    expect(has(confirmForm, 'wide', 'why')).toBe(true)
  })

  it('确认卡两档都说清"做什么"和"怎么答"', () => {
    for (const s of poolOf('confirm'))
      for (const b of ['what', 'hint'])
        expect(has(confirmForm, s, b), `${s}.${b}`).toBe(true)
  })

  /**
   * 「拒绝必须携带机器可读原因」是项目核心原则之一 ——
   * 只说"不行"不说"怎么办"等于原则没落地。所以 suggestion 是恒在块，
   * 最小档也不能砍，这也是它的最小档从 chip 抬到 tile 的原因。
   */
  it('提示卡的「怎么办」任何档位都不砍', () => {
    for (const s of poolOf('notice')) expect(has(noticeForm, s, 'suggestion'), s).toBe(true)
  })

  it('提示卡大档才多出「为什么」', () => {
    expect(has(noticeForm, 'tile', 'why')).toBe(false)
    expect(has(noticeForm, 'wide', 'why')).toBe(true)
  })

  it('反馈卡小档只有结论，大档多一句说明', () => {
    expect(f(feedbackForm, 'chip').blocks).toEqual(['text'])
    expect(has(feedbackForm, 'box', 'detail')).toBe(true)
  })
})

/* ══════════════ 尺寸建议 ══════════════ */
describe('suggestSize：内容 → 建议形状', () => {
  it('按条数挑得下的最小档', () => {
    expect(suggestSize('list', 3)).toBe('box')
    expect(suggestSize('list', 6)).toBe('tower')
    expect(suggestSize('list', 12)).toBe('court')
  })

  it('全装不下就取最大档，交给截断策略', () => {
    expect(suggestSize('list', 999)).toBe('court')
  })

  /**
   * 2026-08-14 代码审查修的：它靠 `maxItems` 挑档，而播放器、天气、导航、
   * 信息卡都没有这个字段 —— 循环一次都不进，直接返回最大档，
   * "按内容挑尺寸"这个机制对**一半模板**是失效的。
   */
  it('不按条数计量的模板走模板自己的默认档，不是一律最大', () => {
    for (const id of ['media', 'weather', 'nav']) {
      const t = CARD_TEMPLATES.find(x => x.id === id)!
      expect(suggestSize(id, 0), id).toBe(t.defaultSize)
    }
  })
})

/**
 * ══════════ 绘本卡：宽档改左图右文 ══════════
 *
 * 实拍（2026-08-14）：「图片没有显示全，建议左图右文，文字可以稍微多一点」。
 *
 * 上图下文在 1.63 宽高比的卡上把图压成一条 —— 图要么被裁要么很小。
 * 左右分栏之后图能整张放下（contain 不裁），右边那一栏又高又窄，
 * 正好放两三句话。
 *
 * 但**只有够宽才分栏**：court(6×8) 本来就是竖卡，强行分栏文字栏只剩两百来像素。
 * 这正是形态函数按几何阈值判断的用途。
 */
describe('绘本卡：够宽才左图右文', () => {
  it('stage / full 分栏', () => {
    expect(has(storybookForm, 'stage', 'side')).toBe(true)
    expect(has(storybookForm, 'full', 'side')).toBe(true)
  })

  it('court 是竖卡，维持上图下文 —— 分栏后文字栏太窄', () => {
    expect(has(storybookForm, 'court', 'side')).toBe(false)
  })
})
