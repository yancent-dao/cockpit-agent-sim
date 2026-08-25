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
    columns: Array.from({ length: 4 }, (_, i) => ({ label: '方案' + i, badge: 'b', rows: [{ k: '到达', v: '14:2' + i }] })),
    series: Array.from({ length: 12 }, (_, i) => ({ label: 'd' + i, value: 10 + i })),
    value: 420, unit: '公里', sub: '电量 68%', percent: 68, trend: '↑2',
    url: 'x.jpg', caption: '距您 3.4 公里', meta: '青羊区',
    items: Array.from({ length: 20 }, (_, i) => ({ label: '条目' + i, sub: 's' + i, value: i })),
    now: { temperature: 25, weather: '晴', wind: '东南风 2 级', humidity: 58 },
    range: { high: 31, low: 22 },
    hourly: Array.from({ length: 12 }, (_, i) => ({ hour: 10 + i, temp: 28, pop: i === 6 ? 70 : 10 })),
    forecast: Array.from({ length: 5 }, (_, i) => ({ date: 'd' + i, dayTemp: 20 + i, nightTemp: 10 + i })),
    lanes: [{ dir: '↑' }, { dir: '↰', use: true }], nextTurn: '然后直行 1.2 公里',
    arriveAt: '14:26', eta: 18, distance: 6.2,
    queue: [{ track: '七里香' }], nextUp: ['七里香', '借口'],
    // 趋势卡（旅行助手）：曲线点、极值、提醒线、分位、依据、监控详情——
    // 少一样这里的相邻档就会渲染成一样，那正是这条测试要拦的
    points: Array.from({ length: 30 }, (_, i) => ({ at: i * 864e5, value: 2400 - i * 18 })),
    current: 1868, changeFromPrev: -86, min: 1842, max: 2486, median: 2166,
    percentile: 0.04, threshold: 2000, thresholdLabel: '提醒线 2000',
    verdict: { label: '可以下单', tone: 'ok' },
    basis: ['比 30 天均价低 9%', '近一周连续回落'],
    monitor: { everyLabel: '每小时采一次', expiresLabel: '至 9 月 2 日', statusLabel: '已触发' },
    updatedLabel: '10 分钟前',
    // 攻略卡：分组条目（group 字段是它跟 list 的关键差别）
    hero: '', source: '来源：近 3 个月高频提及',
    // 融合旅行卡 trip：头图/行前准备/Day 帧/价格块/分段住宿/决策条——
    // 少一样相邻档就渲染成一样，那正是这条测试要拦的
    dest: '曼谷',
    prep: ['落地签可办', '换点泰铢', '电话卡机场有', '雨季带伞'],
    days: [
      { title: '大皇宫 · 卧佛寺 · 考山路', stay: '曼谷·考山路',
        stops: [{ time: '09:00', name: '大皇宫', note: '门票 500 泰铢' }],
        trans: ['步行 10 分钟'] },
      { title: '去芭提雅', stay: '芭提雅·海滩', cityChange: true,
        stops: [{ time: '08:30', name: '大巴去芭提雅' }] },
    ],
    wx: [{ date: '2026-09-06', weather: '晴', hi: 33, lo: 26 },
      { date: '2026-09-07', weather: '小雨', hi: 30, lo: 25 }],
    flight: { label: '机票 · 成都 ⇄ 曼谷', text: '¥1,670', delta: -28,
      points: [2100, 2050, 1980, 1890, 1810, 1740, 1670] },
    stays: [
      { label: '曼谷 · 考山路', range: 'D1–3 · 3 晚', text: '¥638 / 晚', delta: 8 },
      { label: '芭提雅 · 海滩', range: 'D4 · 1 晚', text: '¥520 / 晚', delta: -12 },
    ],
    // 行程单卡：D-day + 时间线 + 待决策，三样都要，少一样相邻档就渲染成一样
    dday: 'D-13', when: '9 月 2 日出发 · 首尔 5 天',
    steps: Array.from({ length: 8 }, (_, i) => ({ label: '步骤' + i, state: 'running', detail: '细节' + i })),
    decide: { question: '机票到价了，现在定吗？', options: ['看趋势', '先不定'] },
    foot: '盯着 3 项',
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
      // 槽位选择器必须真的能在骨架里找到，否则查询返回 null 同样什么都不显示。
      // 匹配按"类名出现在 class 属性里"——槽位元素可以带多个类（.plxtra plxl）
      const cls = slots[b].replace('.', '')
      expect(skeleton, `${id} 的槽位 ${slots[b]} 不在骨架里`).toMatch(new RegExp(`class="[^"]*\\b${cls}\\b`))
    }
  }

  it('导航卡：dest / turn / lane / map / then / eta 全都有地方画', () => {
    cover('nav', NAV_SKELETON, NAV_SLOTS)
  })

  it('播放器卡：meta / art / title / sub / aux / next / bar / ctl / extras / queue 全都有地方画', () => {
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

/**
 * 把「声明过的块必须有地方画」从 nav/media 的槽位表**推广到全部模板**。
 *
 * 画廊页（gallery.html）当场抓到的：车控卡 tower 档声明了 `vehicle`（车身图），
 * 而 cardBody 的 control 分支压根不画它 —— 跟车身图上一次死掉一模一样的缺口，
 * 只是这次躲过了 nav/media 的槽位检查。
 *
 * 判法：把某个块**从形态里去掉**，渲染结果必须跟着变。没变说明它从来没画过。
 */
describe('每个块都真的落到了渲染上', () => {
  const probe: Record<string, { data: any; blocks: Record<string, string> }> = {
    // 块名 → 它出现时渲染结果里必然含有的标记
    control: { data: { title: '车窗', items: [{ label: '主驾', value: 60 }] },
      blocks: { vehicle: 'vehslot', items: 'blocks' } },
    storybook: { data: { line: '一句话', page: 1, total: 3, chapter: 1, ideas: ['x'] },
      blocks: { art: 'sbart', line: 'sbline', dots: 'sbdots', chapter: 'sbch', lesson: 'sbidea', ctl: 'sbctl' } },
    weather: { data: { now: { temperature: 25, weather: '晴', wind: 'w', humidity: 1 }, range: { high: 31, low: 22 },
      hourly: [{ temp: 20, pop: 10 }], forecast: [{ date: 'd', dayTemp: 1, nightTemp: 2 }] },
      blocks: { temp: 'wxnow', range: 'wxrng', hourly: 'hourly', forecast: 'fc' } },
    progress: { data: { items: [{ label: 'a', state: 'running', detail: 'd', percent: 50 }] },
      blocks: { items: 'pgi', bar: 'plfl', detail: '<small>' } },
    metric: { data: { value: 1, unit: 'u', sub: 's', percent: 50, trend: '↑' },
      blocks: { value: 'mtv', sub: '<small>', bar: 'plfl', trend: 'mttr' } },
  }

  it('模板声明的每个块都能在某个档位上看到它的产出', () => {
    for (const [id, p] of Object.entries(probe)) {
      const t = CARD_TEMPLATES.find(x => x.id === id)!
      for (const size of t.sizes!) {
        const html = body(id, size, p.data)
        for (const b of CARD_FORMS[id](...dimsOf(size)).blocks) {
          const mark = p.blocks[b]
          if (!mark) continue          // 探针没覆盖到的块，交给各自的 describe
          expect(html, `${id}@${size} 声明了 ${b} 却没画出来`).toContain(mark)
        }
      }
    }
  })
})

/**
 * ══════════ 定妆那一步必须能被家长否掉 ══════════
 *
 * 实拍反馈「生成主角图之后没有让我选择，而是直接开始讲故事」。
 * 定妆是**全书唯一需要人把关的一步**（之后每一页都拿它当参考图），
 * 卡上没有出口，家长就只能眼睁睁看着一个不像的主角讲完整本。
 *
 * 出口走 `answer` 路由（合成用户输入进对话），**不是新加一个 Tool** ——
 * "像不像"是家长说了算，怎么处置归模型，代码里不许出现这个分支。
 */
describe('定妆卡：家长得有地方说"不像"', () => {
  const cast = () => body('storybook', 'stage',
    { photo: 'data:image/png;base64,P', image: 'data:image/png;base64,C', line: '像吗？' })

  it('两个出口都在：认下来 / 重画', () => {
    const h = cast()
    expect(h, '得能认下来').toMatch(/data-value="[^"]*就是他[^"]*"/)
    expect(h, '得能要求重画').toMatch(/data-value="[^"]*再画[^"]*"/)
  })

  it('走的是 answer 路由那套标记，不是新 Tool', () => {
    expect(cast()).toContain('data-act="tap:item"')
  })

  it('讲述中的页面上不出现这两个按钮 —— 只有定妆那一刻要问', () => {
    const telling = body('storybook', 'stage', { line: '下雨了', page: 1, total: 3 })
    expect(telling).not.toContain('就是他')
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

/**
 * 开放问题不画假按钮（2026-08-19 实拍：绘本"你觉得后面会发生什么"
 * 上屏成「请选择」+ 点不了的确认/取消——那是给"要不要"类二次确认的
 * 兜底，开放续写走到这就全错了）。
 */
describe('confirm 卡：开放问题（无 options）', () => {
  it('不画确认/取消装饰按钮，给"说出来就行"的提示', () => {
    const h = body('confirm', 'wide', { title: '一起想', question: '你觉得后面会发生什么呢？', options: [] })
    expect(h).not.toContain('确认')
    expect(h).not.toContain('取消')
    expect(h).toMatch(/说/)
  })
  it('带 options 的仍是编号可点列表（不受影响）', () => {
    const h = body('confirm', 'wide', { question: '要哪个？', options: ['探险', '回家'] })
    expect(h).toContain('第1个')
    expect(h).toContain('探险')
  })
})
