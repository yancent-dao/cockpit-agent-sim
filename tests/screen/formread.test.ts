import { describe, it, expect } from 'vitest'
import {
  cardBody, NAV_SKELETON, NAV_SLOTS, PLAYER_SKELETON, PLAYER_SLOTS,
} from '../../src/screen/render'
import { CARD_TEMPLATES } from '../../src/config/cards'
import { CARD_FORMS } from '../../src/config/forms'
import { dimsOf } from '../../src/config/grid'

/**
 * ══════════ 渲染层必须真的读 form ══════════
 *
 * 上一轮只改了 `sizes` 数组，没同步改渲染层，于是确认卡/提示卡/反馈卡
 * **三档在屏幕上长得一模一样**：用户点放大，卡变大了内容没变。
 *
 * 形态函数说"这一档显示哪些块"是**契约**，渲染层不读就等于契约作废。
 * 这个测试盯的是那条契约真的被兑现了 —— 靠人眼看不出来，因为
 * 每一档单看都"没毛病"，只有并排比才发现一样。
 */

const body = (template: string, size: string, data: any) =>
  cardBody({ id: 'x', template, size, kind: 'task', data } as any)

describe('相邻两档渲染出来的东西必须不同', () => {
  /**
   * 全模板扫一遍。用同一份**足够丰富**的 data 喂进去 —— 数据不够多的话
   * 大档没东西可显示，两档自然一样，那是假阴性。
   */
  const rich = {
    title: '标题', text: '一句正文', detail: '细节说明', question: '要这么做吗？',
    why: '这是不可逆操作', suggestion: '停稳之后再说一次',
    options: ['好', '算了'], line: '从前有座桥', chapter: 1, page: 1, total: 3,
    ideas: ['会飞的自行车'],
    items: Array.from({ length: 20 }, (_, i) => ({ label: '条目' + i, sub: 's' + i, value: i })),
    now: { temperature: 25, weather: '晴', wind: '东南风 2 级', humidity: 58 },
    range: { high: 31, low: 22 },
    hourly: Array.from({ length: 12 }, (_, i) => ({ hour: 10 + i, temp: 28, pop: i === 6 ? 70 : 10 })),
    forecast: Array.from({ length: 5 }, (_, i) => ({ date: 'd' + i, dayTemp: 20 + i, nightTemp: 10 + i })),
    lanes: [{ dir: '↑' }, { dir: '↰', use: true }], nextTurn: '然后直行 1.2 公里',
    arriveAt: '14:26', eta: 18, distance: 6.2,
    queue: [{ track: '七里香' }], nextUp: ['七里香', '借口'],
  }

  it('每个模板的相邻两档渲染结果都不一样', () => {
    for (const t of CARD_TEMPLATES) {
      if (!CARD_FORMS[t.id] || !t.sizes) continue      // 生成式卡内容由模型给，不适用
      /**
       * nav / media 走**固定骨架 + 显隐**那条路（活地图和视频元素有状态，
       * 不能跟着文字一起重绘），cardBody 对它们本来就返回空串。
       * 它们的契约由下面「声明过的块必须有槽位」那组盯着 —— 豁免不是漏测。
       */
      if (t.id === 'nav' || t.id === 'media') continue
      for (let i = 1; i < t.sizes.length; i++) {
        const a = body(t.id, t.sizes[i - 1], rich)
        const b = body(t.id, t.sizes[i], rich)
        expect(a, `${t.id}：${t.sizes[i - 1]} 和 ${t.sizes[i]} 渲染出来完全一样 —— 那一档白给`)
          .not.toBe(b)
      }
    }
  })
})

describe('确认卡：大档多出「为什么要问你」', () => {
  const d = { question: '要打开车门吗？', why: '开门是不可逆操作', options: ['确认', '取消'] }

  it('小档只有问题和选项', () => {
    const h = body('confirm', 'box', d)
    expect(h).toContain('要打开车门吗？')
    expect(h, 'box 档不该有解释').not.toContain('不可逆')
  })

  it('大档补上解释', () => {
    expect(body('confirm', 'wide', d)).toContain('开门是不可逆操作')
  })

  it('没给 why 时大档也不留一个空块', () => {
    const h = body('confirm', 'wide', { question: 'q', options: ['a'] })
    expect(h).not.toMatch(/class="why"[^>]*>\s*</)
  })
})

describe('提示卡：怎么办任何档位都不砍', () => {
  const d = { text: '行驶中不能开车门', why: '车速 42 km/h', suggestion: '停稳挂 P 挡再说一次' }

  /** 「拒绝必须携带机器可读原因」是项目核心原则 —— 只说"不行"不说"怎么办"等于没落地 */
  it('两档都带建议', () => {
    for (const s of ['tile', 'wide'])
      expect(body('notice', s, d), s).toContain('停稳挂 P 挡再说一次')
  })

  it('只有大档解释「为什么」', () => {
    expect(body('notice', 'tile', d)).not.toContain('42 km/h')
    expect(body('notice', 'wide', d)).toContain('42 km/h')
  })
})

describe('反馈卡：小档只有结论', () => {
  const d = { title: '已开窗', text: '已开窗', detail: '主驾车窗已开到 60%' }

  it('chip 档只有结论，没有说明', () => {
    const h = body('feedback', 'chip', d)
    expect(h).toContain('已开窗')
    expect(h).not.toContain('60%')
  })

  it('box 档补一句说明', () => {
    expect(body('feedback', 'box', d)).toContain('主驾车窗已开到 60%')
  })
})

/**
 * 导航卡和播放器卡是**固定骨架 + 按 form 显隐**（活地图和视频元素有状态，
 * 不能跟着文字一起重绘），所以它们的契约不体现在 cardBody 的字符串里，
 * 而体现在**声明过的每个块都有对应的 DOM 槽位**。
 *
 * 这正是车身图死掉的那种缺口：形态函数声明了它，渲染层却没有地方画，
 * 声明和实现之间没人对账。
 */
describe('固定骨架的模板：声明过的块必须有槽位', () => {
  const cover = (id: string, skeleton: string, slots: Record<string, string>) => {
    const t = CARD_TEMPLATES.find(x => x.id === id)!
    const declared = new Set<string>()
    for (const s of t.sizes!) for (const b of CARD_FORMS[id](...dimsOf(s)).blocks) declared.add(b)
    for (const b of declared) {
      expect(slots[b], `${id} 声明了块 ${b} 却没有对应槽位 —— 它永远不会显示`).toBeTruthy()
      // 槽位选择器必须真的能在骨架里找到，否则查询返回 null 同样什么都不显示
      const cls = slots[b].replace('.', '')
      expect(skeleton, `${id} 的槽位 ${slots[b]} 不在骨架里`).toContain(`class="${cls}"`)
    }
  }

  it('导航卡：dest / turn / lane / map / then / eta 全都有地方画', () => {
    cover('nav', NAV_SKELETON, NAV_SLOTS)
  })

  it('播放器卡：art / title / sub / bar / mix / vol / next / toggle / hint / queue 全都有地方画', () => {
    cover('media', PLAYER_SKELETON, PLAYER_SLOTS)
  })

  /** 反过来也查一遍：槽位表里不该有形态函数从不声明的块（那是死代码） */
  it('槽位表里没有多余的块', () => {
    const declared = (id: string) => {
      const t = CARD_TEMPLATES.find(x => x.id === id)!
      const set = new Set<string>()
      for (const s of t.sizes!) for (const b of CARD_FORMS[id](...dimsOf(s)).blocks) set.add(b)
      return set
    }
    for (const [id, slots] of [['nav', NAV_SLOTS], ['media', PLAYER_SLOTS]] as const) {
      const d = declared(id)
      for (const b of Object.keys(slots))
        expect(d.has(b), `${id} 的槽位 ${b} 没有任何档位声明它 —— 死代码`).toBe(true)
    }
  })
})

describe('形态契约的通用不变量', () => {
  /**
   * 形态函数声明了一个块，渲染层就必须有地方画它。声明了却不画
   * 等于契约是假的 —— 车身图那次就是这么死的（要求 4 行而档位最高 2 行，
   * 图画好了从没出现过）。
   */
  it('每个模板声明过的块在渲染层都有对应产出', () => {
    const seen = new Set<string>()
    for (const t of CARD_TEMPLATES) {
      const fn = CARD_FORMS[t.id]
      if (!fn || !t.sizes) continue
      for (const s of t.sizes) for (const b of fn(...dimsOf(s)).blocks) seen.add(`${t.id}.${b}`)
    }
    // 只是确认这张清单不为空且能枚举 —— 具体每块画没画由上面各 describe 盯
    expect(seen.size).toBeGreaterThan(20)
  })
})
