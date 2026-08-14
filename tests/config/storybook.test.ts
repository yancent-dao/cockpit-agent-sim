import { describe, it, expect } from 'vitest'
import { SIGNALS } from '../../src/config/signals'
import { CARD_TEMPLATES } from '../../src/config/cards'
import { CARD_FORMS } from '../../src/config/forms'
import { TOOLS } from '../../src/config/tools'
import { INTERACTIONS } from '../../src/config/interactions'
import { dimsOf } from '../../src/config/grid'

/**
 * ══════════ 「路上的故事」的配置面 ══════════
 *
 * 加能力 = 加数据不加代码。这一整个功能在配置层的落点：
 * 5 个信号 + 1 张模板 + 1 个形态函数 + 6 个 Tool + 1 组交互声明。
 * 这个测试盯的是**它们互相对得上**——信号有人写、模板有形态、
 * Tool 的参数枚举跟模板的形状池一致。
 */

const sig = (a: string) => SIGNALS.find(s => s.alias === a)
const tool = (n: string) => TOOLS.find(t => t.name === n)
const tmpl = CARD_TEMPLATES.find(t => t.id === 'storybook')

describe('信号：故事进行到哪了', () => {
  it('五个信号齐全', () => {
    for (const a of ['story.active', 'story.phase', 'story.page', 'story.chapter', 'story.pending'])
      expect(sig(a), a).toBeTruthy()
  })

  /**
   * `phase` 是状态机的当前节点，卡片按它换版式（定妆 / 讲述 / 提问 / 成书）。
   * 用枚举不用裸字符串——车机屏拿它挑版式，拼错一个字就是空白卡。
   */
  it('phase 是枚举，四个阶段', () => {
    expect(sig('story.phase')!.type).toBe('enum')
    expect(sig('story.phase')!.values).toEqual(['idle', 'cast', 'telling', 'asking', 'done'])
  })

  it('pending 说还有几页在画 —— 进度点里的虚线靠它', () => {
    expect(sig('story.pending')!.type).toBe('number')
  })

  it('都是彩权限：讲故事不涉及不可逆/安全/金钱/他人', () => {
    for (const a of ['story.active', 'story.phase', 'story.page', 'story.chapter', 'story.pending'])
      expect(sig(a)!.permission, a).toBe('彩')
  })
})

describe('模板：绘本卡', () => {
  it('有这张模板', () => {
    expect(tmpl).toBeTruthy()
  })

  /**
   * 普通卡片是数据的一个投影，随时能被挤走；绘本是一次**有始有终的会话**，
   * 中途被挤下桌就是故事断了。所以给它跟导航卡同级的保护。
   */
  it('不可被挤下桌 —— 故事不能被打断', () => {
    expect(tmpl!.evictable).toBe(false)
  })

  /** 它由 story.* 的 handler 驱动，模型手动 card.show 建的话数据是编的 */
  it('只能由系统建', () => {
    expect(tmpl!.systemOnly).toBe(true)
  })

  it('三档 stage / court / full，默认 stage（行驶中给副驾看）', () => {
    expect(tmpl!.sizes, '按占用单元数升序').toEqual(['court', 'stage', 'full'])
    expect(tmpl!.defaultSize).toBe('stage')
  })

  it('有形态函数', () => {
    expect(CARD_FORMS.storybook).toBeTruthy()
  })

  /**
   * 三档不是大小差异是**场景差异**：行驶中给副驾/后排看的、竖版、
   * 停车时全屏沉浸的。所以每一档的内容必须不同（全局不变量也会查这条，
   * 这里再点名一次是因为它是新模板最容易漏的地方）。
   */
  it('相邻两档内容不同', () => {
    const f = (s: string) => CARD_FORMS.storybook(...dimsOf(s))
    expect(JSON.stringify(f('stage').blocks)).not.toBe(JSON.stringify(f('court').blocks))
    expect(JSON.stringify(f('court').blocks)).not.toBe(JSON.stringify(f('full').blocks))
  })

  it('画面和文字任何档位都在 —— 少了哪个都不是绘本', () => {
    for (const s of tmpl!.sizes!)
      for (const b of ['art', 'line'])
        expect(CARD_FORMS.storybook(...dimsOf(s)).blocks, `${s}.${b}`).toContain(b)
  })
})

describe('六个 Tool', () => {
  const NAMES = ['story.profile', 'story.cast', 'story.begin', 'story.continue', 'story.finish', 'story.export']

  it('都注册了', () => {
    for (const n of NAMES) expect(tool(n), n).toBeTruthy()
  })

  it('都有 brief —— 工具目录每行一句，慢层常驻靠它', () => {
    for (const n of NAMES) expect(tool(n)!.brief, n).toBeTruthy()
  })

  /**
   * 每章几页归**模型**按技能包决定（第一章 3 页、之后 2 页），
   * 所以页数是 Tool 参数不是代码里的常量。代码里出现
   * `if (chapter === 1) pages = 3` 就是把策略写进了机制。
   */
  it('开篇和续章都把页数交给模型填', () => {
    expect(tool('story.begin')!.params!.pages).toBeTruthy()
    expect(tool('story.continue')!.params!.pages).toBeTruthy()
  })

  it('续章要带上孩子说了什么 —— 这是"一起写"的落点', () => {
    expect(tool('story.continue')!.params!.idea).toBeTruthy()
  })

  it('都是彩权限，孩子说话不需要二次确认', () => {
    for (const n of NAMES) expect(tool(n)!.permission, n).toBe('彩')
  })

  /** 导出会往本地存一个文件，是一次明确的用户动作，但不可逆性谈不上 */
  it('导出返回可打开的东西，不是静默存盘', () => {
    expect(tool('story.export')!.desc).toMatch(/H5|网页|打开/)
  })
})

describe('交互声明', () => {
  it('绘本卡声明了交互', () => {
    expect(INTERACTIONS.storybook).toBeTruthy()
  })

  /**
   * 翻页是**机械的桌面动作**，直调不叫醒模型 —— 点一下要等 LLM 转一圈是灾难
   * （跟播放器的上一曲/下一曲同一条路由）。
   */
  it('翻页走 tool 路由，不进对话', () => {
    const prev = INTERACTIONS.storybook.find(d => d.on === 'tap:prev')
    expect(prev?.route).toBe('tool')
  })

  /** 讲到一半划走整张卡＝故事没了，风险跟导航卡一样，所以不给 swipe:away */
  it('没有滑撤 —— 跟导航卡同理，误触代价太大', () => {
    expect(INTERACTIONS.storybook.some(d => d.on === 'swipe:away')).toBe(false)
  })

  it('右上角仍有缩放和关闭', () => {
    for (const on of ['tap:shrink', 'tap:grow', 'tap:close'])
      expect(INTERACTIONS.storybook.some(d => d.on === on), on).toBe(true)
  })
})
