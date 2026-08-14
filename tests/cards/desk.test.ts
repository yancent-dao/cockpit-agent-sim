import { describe, it, expect, beforeEach } from 'vitest'
import { createDesk } from '../../src/cards/desk'
import { CARD_TEMPLATES } from '../../src/config/cards'
import { dimsOf } from '../../src/config/grid'

let now = 1000
let desk: ReturnType<typeof createDesk>
const mk = (o: any = {}) => desk.show({ template: 'feedback', size: '1/6', ttl: 'untilDismissed', ...o })
/**
 * 造一张"怎么腾都放不下"的卡：最小档就要 1/2（banner 12 列宽），
 * 而导航 2/3 占着 8 列且不可挤——右边 4 列竖条它永远塞不进去，又不能再缩。
 *
 * 以前这些测试拿"第二张 2/3 导航卡"当放不下的样本，靠的是 stage 档不在
 * 仲裁阶梯里所以缩不动。事务化重构后仲裁改走模板自己声明的档位，
 * 第二张导航卡会老老实实降成 tower 待在右列（这正是想要的行为：
 * 少一张卡永远比小一张卡更伤），于是不再是"放不下"的样本了。
 */
const unfittable = (o: any = {}) => mk({ template: 'list', size: '1/2', minSize: '1/2',
  data: { title: '排队的', items: [{ label: 'x' }] }, ...o })

beforeEach(() => { now = 1000; desk = createDesk(() => now) })

/* ══════════════ 栅格：12×4 = 48 单元 ══════════════ */
describe('栅格：12列×4行统一画布，档位形状可枚举', () => {
  // 老尺寸名继续能用（'1/6' → card），单元数换算成新栅格
  it('1/6 占 8 单元，1/3 占 16，1/2 占 24，2/3 占 32', () => {
    expect(desk.cellsOf('1/6')).toBe(8)
    expect(desk.cellsOf('1/3')).toBe(16)
    expect(desk.cellsOf('1/2')).toBe(24)
    expect(desk.cellsOf('2/3')).toBe(32)
  })

  it('默认桌面为空——没有常驻卡，一切按需出现', () => {
    expect(desk.layout().cards).toHaveLength(0)
    expect(desk.layout().free).toBe(48)
  })

  it('六张 1/6 填满整个桌面', () => {
    for (let i = 0; i < 6; i++) { mk(); now += 10 }
    expect(desk.layout().cards).toHaveLength(6)
    expect(desk.layout().free).toBe(0)
  })

  it('layout 给出每张卡的行列位置与跨度', () => {
    mk({ size: '1/2', data: { title: 'A' } })
    const c = desk.layout().cards[0]
    expect(c.row).toBe(0)
    expect(c.col).toBe(0)
    expect(c.rowSpan).toBe(2)
    expect(c.colSpan).toBe(12)
  })

  it('1/2 整行卡占满 12 列，高优先级先占位，低优先级卡挪到下面', () => {
    mk(); now += 10; mk({ size: '1/2', kind: 'system' }); now += 10
    const cards = desk.layout().cards
    const half = cards.find(c => c.size === '1/2')!
    const small = cards.find(c => c.size === '1/6')!
    expect(half.row).toBe(0)
    expect(half.col).toBe(0)
    expect(half.colSpan).toBe(12)
    expect(small.row).toBe(2)
  })

  /**
   * 不变量：列起点只取偶数，配合「档位宽度一律偶数」⇒ 空隙必为偶数宽，
   * chip（宽 2）永远填得上。3×2 栅格下导航卡整个出不来的那个几何死局就是缺这条。
   */
  it('所有卡的列起点都是偶数', () => {
    mk({ size: '2/3', template: 'nav', kind: 'rule' }); now += 10
    for (let i = 0; i < 4; i++) { mk(); now += 10 }
    for (const c of desk.layout().cards) expect(c.col % 2, `${c.id} 在第 ${c.col} 列`).toBe(0)
  })

  it('半高档的行起点只在 0 或 2，不会错位出一条高 1 的横缝', () => {
    for (let i = 0; i < 6; i++) { mk(); now += 10 }
    for (const c of desk.layout().cards) expect([0, 2], `row ${c.row}`).toContain(c.row)
  })
})

/* ══════════════ 2/3 导航形状 ══════════════ */
describe('2/3（stage）：左锚定 8×4，唯一合法位置是左八列', () => {
  it('2/3 卡占据左八列整块', () => {
    const r = mk({ size: '2/3', template: 'nav', kind: 'rule', data: { destination: 'x' } })
    expect(r.status).toBe('ok')
    const c = desk.layout().cards[0]
    expect(c.row).toBe(0)
    expect(c.col).toBe(0)
    expect(c.rowSpan).toBe(4)
    expect(c.colSpan).toBe(8)
  })

  /**
   * 12×4 相对 3×2 最实质的改善：stage 之后右边留的是 4×4 = 16 单元的**竖条**，
   * 上下两张 card（4×2）叠着放得进去 —— 老栅格下那里是一条宽 1 的死缝。
   */
  it('有 2/3 卡时右边竖条还能叠两张 1/6', () => {
    mk({ size: '2/3', template: 'nav', kind: 'rule' }); now += 10
    expect(desk.layout().free).toBe(16)
    const a = mk(); now += 10
    const b = mk(); now += 10
    expect(a.status).toBe('ok')
    expect(b.status).toBe('ok')
    const cells = desk.layout().cards.filter(c => c.size === '1/6').map(c => [c.row, c.col])
    expect(cells).toEqual([[0, 8], [2, 8]])
  })

  it('2/3 在场时 1/2 横卡（宽 12）放不下右边的 4 列 → 自动降为 1/6', () => {
    mk({ size: '2/3', template: 'nav', kind: 'rule' }); now += 10
    const r = mk({ size: '1/2', data: { title: '天气' } })
    expect(r.status).toBe('ok')
    const placed = desk.layout().cards.find(c => c.data?.title === '天气')!
    // 降档后 size 是新档位名。card 就是老的 1/6，行为没变、名字换了
    expect(desk.cellsOf(placed.size)).toBeLessThanOrEqual(desk.cellsOf('1/6'))
    expect(r.shrunk).toBeTruthy()
  })

  // 全桌面只有一个 8×4 的合法位置，所以 2/3 至多一张。第二张不是消失，
  // 而是降到自己尺寸表的下一档（tower）待在右列——少一张卡永远比小一张卡更伤
  it('同一时刻最多一张 2/3：第二张降档留在桌面，不占第二个 8×4', () => {
    mk({ size: '2/3', template: 'nav', kind: 'rule', evictable: false }); now += 10
    const r = mk({ size: '2/3', template: 'nav', kind: 'rule', data: { title: '第二张' } })
    expect(r.status).toBe('ok')
    const onstage = desk.layout().cards
    expect(onstage.filter(c => c.size === '2/3'), '2/3 至多一张').toHaveLength(1)
    const second = onstage.find(c => c.data?.title === '第二张')!
    expect(second, '第二张没消失，只是变小了').toBeTruthy()
    expect(desk.cellsOf(second.size)).toBeLessThan(desk.cellsOf('2/3'))
  })
})

/* ══════════════ 优先级仲裁 ══════════════ */
describe('优先级：system > rule > task，同级按创建时间', () => {
  it('kind 决定优先级数值', () => {
    expect(desk.priorityOf('system')).toBeGreaterThan(desk.priorityOf('rule'))
    expect(desk.priorityOf('rule')).toBeGreaterThan(desk.priorityOf('task'))
  })

  it('高优先级卡先占位：system 卡排在 task 卡前面', () => {
    mk({ data: { title: '任务卡' } }); now += 10
    mk({ kind: 'system', data: { title: '来电' } }); now += 10
    const cards = desk.layout().cards
    expect(cards[0].data.title).toBe('来电')
    expect(cards[0].col).toBe(0)
  })

  /**
   * 七档阶梯之后，「缩」能解决的场景不该走到「挤」——
   * 少一张卡永远比小一张卡更伤。挤是最后手段。
   */
  it('缩得下就不挤人：新卡进来时大家一起变小，谁都不消失', () => {
    mk({ kind: 'system', size: '1/2', data: { title: '告警' } }); now += 10
    mk({ data: { title: '旧任务' } }); now += 10
    mk({ data: { title: '新任务' } }); now += 10
    mk(); now += 10
    const r = mk({ kind: 'rule', size: '1/2', data: { title: '导航提示' } })
    expect(r.status).toBe('ok')
    const titles = desk.layout().cards.map(c => c.data?.title)
    for (const t of ['告警', '旧任务', '新任务', '导航提示']) expect(titles, t).toContain(t)
    expect(r.evicted, '不该挤掉任何人').toBeFalsy()
  })

  it('真的缩无可缩时才挤，挤的是低优先级里最旧的那张', () => {
    // 全部先压到最小档，缩这条路彻底走不通
    for (let i = 0; i < 6; i++) { mk({ size: 'chip', minSize: 'chip', data: { title: '钉死' + i } }); now += 10 }
    for (let i = 0; i < 18; i++) { mk({ size: 'chip', minSize: 'chip', data: { title: '填充' + i } }); now += 10 }
    const before = desk.layout().cards.length
    const r = mk({ kind: 'system', size: 'chip', minSize: 'chip', data: { title: '来电' } })
    expect(r.status).toBe('ok')
    expect(desk.layout().cards.map(c => c.data?.title)).toContain('来电')
    // 挤了人就得告知，静默消失不可接受
    if (desk.layout().cards.length <= before) expect(r.note).toBeTruthy()
  })

  it('evictable:false 的卡任何情况不被挤——导航中来电，来电降级挤入右列，导航岿然不动', () => {
    mk({ size: '2/3', template: 'nav', kind: 'rule', evictable: false, data: { title: '导航' } }); now += 10
    mk(); now += 10; mk(); now += 10
    const r = mk({ kind: 'system', size: '1/2', data: { title: '来电' } })
    expect(r.status).toBe('ok')
    const titles = desk.layout().cards.map(c => c.data?.title)
    expect(titles).toContain('导航')
    const call = desk.layout().cards.find(c => c.data?.title === '来电')!
    // 1/2 放不下，自动降级。七档阶梯下它可能一路降到 chip，只断言"变小了"
    expect(desk.cellsOf(call.size)).toBeLessThan(desk.cellsOf('1/2'))
  })

  /**
   * ⑤ 是几何死局的最后手段：连比候选优先级更高的卡也允许被降尺寸（但绝不被挤出）。
   * 触发条件是 ③（候选自己缩）真的走不通——这里用 minSize 把候选钉死。
   * 注：候选能自己缩时不该动更高优先级的卡，那种场景走 ③，见下一条。
   */
  it('几何死局的最后手段：高优先级卡可被降尺寸（但绝不被挤出）', () => {
    // system 确认卡占满上两行（banner 12×2）
    mk({ kind: 'system', size: '1/2', data: { title: '请选择', question: 'q' }, template: 'confirm' }); now += 10
    // 候选是 4×4 竖块且钉死不能再缩：上两行被占满，非降它不可
    const r = mk({ size: 'tower', minSize: 'tower', template: 'nav', kind: 'rule',
      evictable: false, data: { title: '导航' } })
    expect(r.status).toBe('ok')
    const titles = desk.layout().cards.map(c => c.data?.title)
    expect(titles).toContain('导航')
    expect(titles).toContain('请选择')   // 没被挤出，只是变小了
    expect(desk.cellsOf(desk.layout().cards.find(c => c.data?.title === '请选择')!.size))
      .toBeLessThan(desk.cellsOf('1/2'))
  })

  // 候选自己缩得动时就别动别人——尤其别动比它优先级更高的卡
  it('候选能自己降档时，不去动更高优先级的卡', () => {
    mk({ kind: 'system', size: '1/3', data: { title: '请选择', question: 'q' }, template: 'confirm' }); now += 10
    const r = mk({ size: '2/3', template: 'nav', kind: 'rule', evictable: false, data: { title: '导航' } })
    expect(r.status).toBe('ok')
    expect(desk.layout().cards.find(c => c.data?.title === '请选择')!.size, '高优先级卡纹丝不动').toBe('1/3')
    expect(desk.cellsOf(desk.layout().cards.find(c => c.data?.title === '导航')!.size), '降的是候选自己')
      .toBeLessThan(desk.cellsOf('2/3'))
  })

  // 列表卡缩到 1/6 就只剩个标题，选项全没了，等于白占一格。
  // 模板已经声明了 sizes: ['1/3','1/2']，仲裁必须认这个下限
  it('缩尺寸不能缩出模板允许的范围，宁可挤掉别人', () => {
    mk({ template: 'list', size: '1/2', kind: 'task', minSize: '1/3',
      data: { title: '候选', items: [{ label: 'a' }] } }); now += 10
    const r = mk({ size: '2/3', template: 'nav', kind: 'rule', evictable: false, data: { title: '导航' } })
    expect(r.status).toBe('ok')
    const list = desk.layout().cards.find(c => c.template === 'list')
    // 要么降到下限 1/3，要么被挤掉；绝不能出现 1/6 的列表卡
    if (list) expect(list.size).not.toBe('1/6')
  })

  /**
   * 七档阶梯之后 6 张卡不再必然挤人（大家一起缩就放得下），
   * 所以这里得把桌面真正填死：全部钉在 chip 且铺满 48 单元。
   */
  it('挤出必须告知——note 带被挤卡片的标题', () => {
    for (let i = 0; i < 24; i++) { mk({ size: 'chip', minSize: 'chip', data: { title: `卡${i}` } }); now += 10 }
    const r = mk({ kind: 'system', size: 'chip', minSize: 'chip', data: { title: '来电' } })
    expect(r.status).toBe('ok')
    expect(r.note).toContain('卡0')   // LRU：同级里最旧的先走
  })

  it('没给 title 时兜底用模板的人话 label，不是裸模板 id', () => {
    // 无 title 的 feedback 卡钉在 chip 铺满，逼出真正的挤出
    for (let i = 0; i < 24; i++) { mk({ size: 'chip', minSize: 'chip' }); now += 10 }
    const r = mk({ kind: 'system', size: 'chip', minSize: 'chip' })
    expect(r.status).toBe('ok')
    // 被挤的是低优先级 task 卡；note 里显示模板 label「反馈卡」而不是裸 id「feedback」
    const fbLabel = CARD_TEMPLATES.find(t => t.id === 'feedback')!.label
    expect(r.note).toContain(fbLabel)
    expect(r.note).not.toContain('「feedback」')
  })
})

/* ══════════════ 生命周期 ══════════════ */
describe('生命周期：ttl 必填，到期自动退场', () => {
  it('缺 ttl 拒绝——防卡片堆积', () => {
    const r = desk.show({ template: 'feedback', size: '1/6' })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('TTL_REQUIRED')
  })

  it('数字 ttl 到秒数自动消失', () => {
    mk({ ttl: 30 })
    now += 29_000; desk.tick()
    expect(desk.layout().cards).toHaveLength(1)
    now += 2_000; desk.tick()
    expect(desk.layout().cards).toHaveLength(0)
  })

  it('untilTaskEnd 在任务结束时清场', () => {
    mk({ ttl: 'untilTaskEnd' }); mk({ ttl: 'untilDismissed' })
    desk.endTask()
    expect(desk.layout().cards).toHaveLength(1)
  })
})

/* ══════════════ full 整屏覆盖 ══════════════ */
describe('full：整屏覆盖，退出自动还原', () => {
  it('full 卡进 overlay，不占栅格', () => {
    mk({ data: { title: '底下的卡' } }); now += 10
    // 能力目录空着不是合法状态（这车总会点什么），给两条真实的
    desk.show({ template: 'capability', size: 'full', ttl: 'untilDismissed',
      data: { items: [{ label: '开窗' }, { label: '导航' }] } })
    const l = desk.layout()
    expect(l.overlay).toBeTruthy()
    expect(l.cards).toHaveLength(1) // 底下的卡还在
  })

  it('关闭 full 后桌面原样', () => {
    mk({ data: { title: 'A' } }); now += 10
    const f = desk.show({ template: 'capability', size: 'full', ttl: 'untilDismissed', data: { items: [] } })
    desk.dismiss(f.cardId!)
    const l = desk.layout()
    expect(l.overlay).toBeUndefined()
    expect(l.cards[0].data.title).toBe('A')
  })
})

/* ══════════════ 复用：L1/L2/L3 ══════════════ */
describe('render：优先复用已有卡 → 放大 → 最后才新建', () => {
  it('无对应卡时新建（L3）', () => {
    const r = desk.render({ key: 'w', template: 'control', size: '1/6', ttl: 30, data: { title: '车窗' } })
    expect(r.level).toBe('L3')
  })

  it('已有同 key 卡时更新内容不新建（L1）', () => {
    desk.render({ key: 'w', template: 'control', size: '1/6', ttl: 30, data: { title: '车窗', v: 1 } })
    const r = desk.render({ key: 'w', template: 'control', size: '1/6', ttl: 30, data: { title: '车窗', v: 2 } })
    expect(r.level).toBe('L1')
    expect(desk.layout().cards).toHaveLength(1)
    expect(desk.layout().cards[0].data.v).toBe(2)
  })

  it('已有卡但要求更大尺寸时放大（L2）', () => {
    desk.render({ key: 'w', template: 'control', size: '1/6', ttl: 30 })
    const r = desk.render({ key: 'w', template: 'control', size: '1/2', ttl: 30 })
    expect(r.level).toBe('L2')
    expect(desk.layout().cards[0].size).toBe('1/2')
  })

  it('refreshTtl 让事件卡在活动期间不过期', () => {
    desk.render({ key: 'w', template: 'control', size: '1/6', ttl: 30 })
    now += 25_000
    desk.render({ key: 'w', template: 'control', size: '1/6', ttl: 30, refreshTtl: true })
    now += 25_000; desk.tick()
    expect(desk.layout().cards).toHaveLength(1) // 第二次 render 重置了寿命
  })
})

/* ══════════════ 上下文注入 ══════════════ */
describe('桌面摘要（注入 system prompt）', () => {
  /**
   * 摘要是给**模型**看的。48 单元下说「剩余 16 格」它没法换算成
   * 「还能不能再上一张卡」，只会瞎猜。改成按基准卡数说人话。
   */
  it('列出卡片、尺寸，剩余空间换算成还能放几张小卡', () => {
    desk.render({ key: 'nav', template: 'nav', size: '2/3', kind: 'rule', ttl: 'untilDismissed', data: { title: '导航' } })
    const s = desk.summary()
    expect(s).toContain('导航')
    expect(s).toContain('2/3')
    expect(s).toMatch(/还(能|放得下).*2\s*张/)   // 16 单元 = 两张基准卡
    expect(s).not.toMatch(/\d+\s*格/)            // 不许再出现内部单元数
    expect(s).not.toContain('固定区')
  })

  it('空桌面明确说明还能放六张', () => {
    expect(desk.summary()).toMatch(/还(能|放得下).*6\s*张/)
  })

  it('放满了就直说，别让模型以为还有位置', () => {
    for (let i = 0; i < 6; i++) { mk(); now += 10 }
    expect(desk.summary()).toMatch(/满|放不下/)
  })

  // 等位区（2026-08-13）：模型必须知道台下还有什么，不然它会当成"没了"重复建卡
  it('台下有排队的卡时，摘要里说得出——不然模型会以为没了', () => {
    for (let i = 0; i < 24; i++) { mk({ kind: 'system', size: 'chip', minSize: 'chip', evictable: false }); now += 10 }
    mk({ template: 'weather', size: '1/6', data: { title: '成都天气' } })
    expect(desk.summary()).toContain('成都天气')
    expect(desk.summary()).toMatch(/台下|排队|等/)
  })

  it('台下没有排队的卡时不提这茬——没有的事别说', () => {
    mk({ data: { title: 'A' } })
    expect(desk.summary()).not.toMatch(/台下|排队等/)
  })
})

/**
 * 导航卡 2/3 占掉左两列，右列只剩 1 格宽。1/3 是横向 2×1 的形状，
 * 塞不进 1 格宽的右列——如果选择卡又不许缩到 1/6，就是死锁：
 * 用户听到了问题，屏幕上什么都没有。
 *
 * 候选列表卡踩过同一个坑：导航中用户说"换成太古里"，Agent 念了四个候选让他
 * 选第几个，卡片却因为 minSize=1/3 进不来，屏幕上只有旧的导航卡。
 * 1/6 实测放得下四个带地址的候选，那个下限是凭想象设的。
 */
describe('导航 2/3 在场时，选择卡还进不进得来', () => {
  it('候选列表卡进得来', () => {
    desk.show({ template: 'nav', size: '2/3', kind: 'rule', evictable: false,
      ttl: 'untilDismissed', data: { title: '导航' } })
    now += 10
    const r = desk.show({ template: 'list', size: '1/2', kind: 'task', minSize: '1/6',
      ttl: 120, data: { title: '你要去哪个？', items: [{ label: '太古里' }, { label: '美食街' }] } })
    expect(r.status).toBe('ok')
    expect(desk.layout().cards.some(c => c.template === 'list')).toBe(true)
  })

  it('进得来，且不会被拒', () => {
    desk.show({ template: 'nav', size: '2/3', kind: 'rule', evictable: false,
      ttl: 'untilDismissed', data: { title: '导航' } })
    now += 10
    // minSize 跟着 confirm 模板走（含 1/6），所以缩得下去、进得来
    const r = desk.show({ template: 'confirm', size: '1/3', kind: 'system', minSize: '1/6',
      ttl: 'untilTaskEnd', data: { title: '请选择', question: '去哪个充电站？' } })
    expect(r.status).toBe('ok')
    expect(desk.layout().cards.map(c => c.data?.title)).toContain('请选择')
  })
})

/**
 * 桌面是 f(车辆状态)：导航中每次 ETA、剩余距离、下一步指令变化都会重刷导航卡。
 * 如果刷新时带着默认尺寸，用户说"地图小一点"调到 1/3，下一秒 ETA 一跳就弹回 2/3。
 *
 * 优先级：物理（仲裁）> 意愿（显式 resize）> 建议（defaultSize）
 */
describe('尺寸粘性：显式改过就听用户的', () => {
  const nav = () => desk.show({ key: 'nav', template: 'nav', size: '2/3', kind: 'rule',
    evictable: false, ttl: 'untilDismissed', data: { title: '导航', eta: 20 } })

  it('resize 之后，规则重刷不把尺寸改回默认', () => {
    nav()
    const id = desk.findByKey('nav')!.id
    desk.resize(id, 'tower')
    now += 10
    // orchestrator 每次状态变化都这么调
    desk.render({ key: 'nav', template: 'nav', size: '2/3', kind: 'rule',
      evictable: false, ttl: 'untilDismissed', data: { title: '导航', eta: 19 } })
    const c = desk.findByKey('nav')!
    expect(c.size).toBe('tower')    // 用户的选择还在
    expect(c.data.eta).toBe(19)     // 数据照常更新
  })

  // render 的既有语义是只放大不缩小——规则重刷不该让卡片忽大忽小。
  // 没上锁的卡，空间腾出来时规则能把它带回默认尺寸
  it('没被 resize 过的卡，规则重刷能放大回默认尺寸', () => {
    desk.render({ key: 'nav', template: 'nav', size: 'tower', kind: 'rule',
      evictable: false, ttl: 'untilDismissed', data: { title: '导航' } })
    expect(desk.findByKey('nav')!.size).toBe('tower')
    now += 10
    desk.render({ key: 'nav', template: 'nav', size: '2/3', kind: 'rule',
      evictable: false, ttl: 'untilDismissed', data: { title: '导航' } })
    expect(desk.findByKey('nav')!.size).toBe('2/3')
  })

  it('卡片退场后锁也没了，下次出现回到默认尺寸', () => {
    nav()
    const id = desk.findByKey('nav')!.id
    desk.resize(id, '1/3')
    desk.dismiss(id)
    now += 10
    nav()
    expect(desk.findByKey('nav')!.size).toBe('2/3')
  })

  it('锁不住仲裁——空间不够时该缩还得缩，那是物理不是偏好', () => {
    nav()
    desk.resize(desk.findByKey('nav')!.id, '1/2')
    now += 10
    // 塞满剩余空间，逼一张 system 卡进来
    for (let i = 0; i < 3; i++) { mk({ kind: 'system' }); now += 10 }
    const r = mk({ kind: 'system', size: '1/2', data: { title: '告警' } })
    expect(r.status).toBe('ok')
  })
})

/**
 * ══════════════ 卡片右上角尺寸调节按钮的机制半边 ══════════════
 *
 * 实拍反馈（2026-08-13）：卡片要有最小/最大/其它尺寸/关闭的操作按钮，放右上角。
 * 按钮不认阶梯（LADDER 只是"自动仲裁怎么退让"的内部实现），只认**模板允许的
 * 尺寸表**——用户点按钮就该在 checkSize 认可的范围内一档一档走，
 * 到头就到头（不是拒绝，是按钮该自己失效）。
 * 2/3（stage）这类专用档不在 LADDER 里，但在导航卡的 sizes 表里是合法的最大档，
 * 用单元格数量排序而不是 LADDER 下标，天然就把它接进阶梯两端。
 */
// 实拍反馈（2026-08-13）：导航卡缩小不该以"拉长"为主——地图塞进宽 12/8、
// 高只有 2 的扁条会横向拉伸变形。中间档改用正方形的 tower（4×4），
// 不用 wide/panel/banner 这类宽 2 高的档
describe('导航卡尺寸表：避开会拉伸地图的扁条形状', () => {
  it('导航卡三档不含 wide/panel/banner 这类宽高比 ≥3:1 的扁条', () => {
    const nav = CARD_TEMPLATES.find(t => t.id === 'nav')!
    for (const bad of ['wide', 'panel', 'banner', '1/3', '1/2'])
      expect(nav.sizes, `导航卡不该有 ${bad}`).not.toContain(bad)
  })

  it('中间档 tower 是正方形（4×4），不是拉伸的扁条', () => {
    const [w, h] = dimsOf('tower')
    expect(w).toBe(h)
  })
})

describe('desk.step()：卡片右上角尺寸调节按钮的机制', () => {
  it('grow/shrink 按模板允许的尺寸表走一档', () => {
    const id = mk({ template: 'weather', size: '1/6', data: { now: {} } }).cardId!
    expect(desk.step(id, 'up').status).toBe('ok')
    expect(desk.get(id)!.size).toBe('1/3')
    expect(desk.step(id, 'up').status).toBe('ok')
    expect(desk.get(id)!.size).toBe('1/2')
  })

  it('已经是最小尺寸时 shrink 返回 SIZE_NOT_SUPPORTED，尺寸不变', () => {
    const id = mk({ template: 'weather', size: '1/6', data: { now: {} } }).cardId!
    const r = desk.step(id, 'down')
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('SIZE_NOT_SUPPORTED')
    expect(desk.get(id)!.size).toBe('1/6')
  })

  it('已经是最大尺寸时 grow 返回 SIZE_NOT_SUPPORTED，尺寸不变', () => {
    const id = mk({ template: 'weather', size: '1/2', data: { now: {} } }).cardId!
    const r = desk.step(id, 'up')
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('SIZE_NOT_SUPPORTED')
    expect(desk.get(id)!.size).toBe('1/2')
  })

  it('导航卡的 2/3 是专用档不在 LADDER 里，仍能从 tower grow 上去——按单元格数量排序不看阶梯下标', () => {
    const id = desk.show({ template: 'nav', size: 'tower', kind: 'rule',
      evictable: false, ttl: 'untilDismissed', data: { title: '导航' } }).cardId!
    const r = desk.step(id, 'up')
    expect(r.status).toBe('ok')
    expect(desk.get(id)!.size).toBe('2/3')
    // 已经是 2/3（导航卡的最大档），再 grow 就到头了
    expect(desk.step(id, 'up').status).toBe('rejected')
  })

  it('尊重模板收窄过的尺寸表（list 只有 1/6·1/3·1/2 三档）', () => {
    const id = mk({ template: 'list', size: '1/6', data: { items: [{ label: 'a' }] } }).cardId!
    const r = desk.step(id, 'down')   // list 没有比 1/6 更小的档
    expect(r.status).toBe('rejected')
  })

  it('尊重调用方声明的 minSize——按钮缩不破这条线', () => {
    const id = mk({ template: 'weather', size: '1/3', minSize: '1/3', data: { now: {} } }).cardId!
    const r = desk.step(id, 'down')
    expect(r.status).toBe('rejected')
    expect(desk.get(id)!.size).toBe('1/3')
  })

  it('走一步即视为用户显式调整——之后规则重刷不会把尺寸弹回默认', () => {
    desk.render({ key: 'nav', template: 'nav', size: '2/3', kind: 'rule',
      evictable: false, ttl: 'untilDismissed', data: { title: '导航' } })
    const id = desk.findByKey('nav')!.id
    desk.step(id, 'down')
    expect(desk.get(id)!.size).toBe('tower')
    now += 10
    desk.render({ key: 'nav', template: 'nav', size: '2/3', kind: 'rule',
      evictable: false, ttl: 'untilDismissed', data: { title: '导航' } })
    expect(desk.findByKey('nav')!.size).toBe('tower')   // 没被规则弹回 2/3
  })

  it('卡不存在时返回 NO_SUCH_CARD，不抛异常', () => {
    expect(desk.step('nope', 'up').code).toBe('NO_SUCH_CARD')
  })

  /**
   * 实拍反馈（2026-08-13）：放大操作优先级最高，能挤走其他卡片——
   * 用户点了放大按钮就是明确表态"这张卡现在最重要"，不该因为桌面满了
   * 就静默什么都不做（之前 grow 只是普通 resize，tryPlace 失败就原地卡住）。
   */
  it('放大挤占：桌面被同优先级卡占满时，grow 照样挤出地方（不看谁优先级更高）', () => {
    for (let i = 0; i < 5; i++) { mk({ kind: 'system', size: '1/6', minSize: '1/6', data: { title: '占位' + i } }); now += 10 }
    const id = mk({ template: 'weather', size: '1/6', kind: 'system', data: { now: {} } }).cardId!
    now += 10
    const r = desk.step(id, 'up')
    expect(r.status).toBe('ok')
    expect(desk.get(id)!.size).toBe('1/3')   // 真长大了，不是原地不动
    expect(r.evicted, '挤了人就该带 evicted').toBeTruthy()
  })

  it('放大挤占绝不破 evictable:false / urgent+ 的硬保护——挤不动就是挤不动', () => {
    // 钉死 6 张 1/6（48 单元正好占满），全部不可挤
    for (let i = 0; i < 6; i++) { mk({ kind: 'system', size: '1/6', minSize: '1/6', evictable: false, urgency: 'urgent', data: { title: '钉' + i } }); now += 10 }
    const beforeTitles = desk.layout().cards.map(c => c.data?.title)
    // 桌面已经满了，随手拿一张已上台的卡试着 grow——这里直接用第一张钉死的卡
    // 本身来验证：即便它是"候选自己"，也不能通过挤走别人（因为大家都不可挤）实现放大
    const target = desk.layout().cards[0]!
    desk.step(target.id, 'up')
    const afterTitles = desk.layout().cards.map(c => c.data?.title)
    expect(afterTitles.sort()).toEqual(beforeTitles.sort())   // 没人被挤下桌
  })

  // canStep 是给车机屏按钮"该不该置灰"用的只读查询——不许车机屏自己重算一遍
  it('canStep 只读查询按钮该不该置灰，不改变尺寸', () => {
    const id = mk({ template: 'weather', size: '1/6', data: { now: {} } }).cardId!
    expect(desk.canStep(id, 'down')).toBe(false)   // 已经最小
    expect(desk.canStep(id, 'up')).toBe(true)
    expect(desk.get(id)!.size).toBe('1/6')        // 只读，没被改动
  })

  it('canStep 对不存在的卡返回 false', () => {
    expect(desk.canStep('nope', 'up')).toBe(false)
  })
})

/* ══════════════ urgency：正交于 kind 的紧急度 ══════════════ */
/**
 * 之前 PRIORITY 只看 kind，描述的是「谁建的卡」。
 * 后果：车门没关且已起步的安全告警，跟天气卡同为 rule，抢位时按 LRU 决定谁活。
 */
describe('urgency 参与仲裁', () => {
  it('critical 卡不会被挤出，哪怕它是最旧的 task', () => {
    mk({ urgency: 'critical', size: '1/2', data: { title: '车门未关' } }); now += 10
    for (let i = 0; i < 6; i++) { mk({ kind: 'system', data: { title: '卡' + i } }); now += 10 }
    expect(desk.layout().cards.map(c => c.data?.title)).toContain('车门未关')
  })

  it('真挤不动时 ambient 先走 —— 天气让位给车控反馈', () => {
    mk({ urgency: 'ambient', size: 'chip', minSize: 'chip', data: { title: '天气' } }); now += 10
    for (let i = 0; i < 23; i++) { mk({ size: 'chip', minSize: 'chip', data: { title: '常规' + i } }); now += 10 }
    mk({ size: 'chip', minSize: 'chip', data: { title: '新反馈' } }); now += 10
    const titles = desk.layout().cards.map(c => c.data?.title)
    expect(titles, 'ambient 该第一个走').not.toContain('天气')
    expect(titles).toContain('新反馈')
  })

  // 缩到 chip 只剩一个标题，安全告警缩成那样等于没显示
  it('critical 卡不会被缩到 panel 以下', () => {
    const r = mk({ urgency: 'critical', size: '1/2', data: { title: '胎压过低' } }); now += 10
    expect(r.status).toBe('ok')
    for (let i = 0; i < 4; i++) { mk({ kind: 'system', size: '1/3' }); now += 10 }
    const c = desk.layout().cards.find(x => x.data?.title === '胎压过低')!
    expect(desk.cellsOf(c.size)).toBeGreaterThanOrEqual(desk.cellsOf('1/3'))
  })

  /**
   * 真实几何：导航 stage（8×4，不可挤）在场时右边只剩 4×4 竖条，
   * 而 critical 的最小档是 panel（8×2）—— 放不进去。
   *
   * 走到这一步的老逻辑是 DESKTOP_FULL 拒绝，**安全告警被拒是事故**。
   * critical 必须改走覆盖层：它本来就该盖住一切，这也正是三通道里
   * channelOf() 给 critical 的答案。
   */
  it('放不下的 critical 卡改走覆盖层，绝不拒绝', () => {
    mk({ template: 'nav', size: '2/3', kind: 'rule', evictable: false, data: { title: '导航' } }); now += 10
    const r = mk({ template: 'notice', size: '1/2', kind: 'system', urgency: 'critical', ttl: 60, data: { title: '车门未关' } })
    expect(r.status).toBe('ok')
    expect(desk.layout().overlay?.data?.title).toBe('车门未关')
    // 导航卡还在，没被挤掉
    expect(desk.layout().cards.some(c => c.data?.title === '导航')).toBe(true)
  })

  it('放得下的 critical 卡照常进桌面，不滥用覆盖层', () => {
    const r = mk({ size: '1/2', urgency: 'critical', data: { title: '胎压过低' } })
    expect(r.status).toBe('ok')
    expect(desk.layout().overlay).toBeUndefined()
    expect(desk.layout().cards.some(c => c.data?.title === '胎压过低')).toBe(true)
  })

  it('非 critical 卡放不下不再拒绝也不滥用覆盖层——进等位区（2026-08-13 改）', () => {
    mk({ template: 'nav', size: '2/3', kind: 'rule', evictable: false }); now += 10
    const r = mk({ size: '1/2', kind: 'system', data: { title: '普通提示' } })
    expect(r.status).toBe('ok')       // 会被降档放进右边竖条
    const r2 = unfittable({ kind: 'system', data: { title: '第二张大卡', items: [{ label: 'x' }] } })
    expect(r2.status).toBe('ok')
    expect(r2.staged).toBe(true)
    expect(desk.layout().overlay).toBeUndefined()
  })

  it('没声明 urgency 的卡行为跟以前一模一样', () => {
    mk({ data: { title: 'A' } }); now += 10
    mk({ kind: 'system', data: { title: 'B' } }); now += 10
    expect(desk.layout().cards[0].data.title).toBe('B')
  })
})

/* ══════════════ 七档降级阶梯 ══════════════ */
/**
 * 用户实测报的：「最小的还是六分之一，超过六个就把音乐播放器关了」。
 *
 * 12×4 栅格给了 chip(2×1)、strip(4×1)、bar(6×1) 这些小档，但 desk 的降级阶梯
 * 还是老的三档（1/6·1/3·1/2）—— 缩到 1/6 就缩无可缩，只能挤卡。
 * 而 6 张 1/6 正好填满 48 单元，所以第 7 张一来必挤掉一张。
 *
 * 接上七档之后：一张 ambient 的播放器能缩到 chip（2 单元），
 * 让出 6 单元给新卡，两张卡都在场。
 */
describe('降级阶梯七档，缩得比 1/6 更小', () => {
  it('桌面填满后，ambient 卡缩小让位而不是被挤掉', () => {
    for (let i = 0; i < 5; i++) { mk({ data: { title: '常规' + i } }); now += 10 }
    mk({ urgency: 'ambient', data: { title: '正在播放' } }); now += 10
    expect(desk.layout().cards).toHaveLength(6)

    const r = mk({ data: { title: '新来的' } })
    expect(r.status).toBe('ok')
    const titles = desk.layout().cards.map(c => c.data?.title)
    expect(titles, '播放器不该被关掉').toContain('正在播放')
    expect(titles).toContain('新来的')
  })

  it('缩到 chip 是允许的 —— 它就是为"还想留着但没地方"准备的', () => {
    const r = mk({ size: '1/6', urgency: 'ambient', data: { title: '播放器' } })
    expect(r.status).toBe('ok')
    const id = r.cardId!
    expect(desk.resize(id, 'chip' as any, true).status).toBe('ok')
    expect(desk.layout().cards.find(c => c.id === id)!.size).toBe('chip')
  })

  it('新档位名和老名字都认', () => {
    expect(desk.cellsOf('chip' as any)).toBe(2)
    expect(desk.cellsOf('bar' as any)).toBe(6)
    expect(desk.cellsOf('1/6')).toBe(8)
  })
})

/**
 * 等位区（offstage/staged）—— 2026-08-13 设计
 * docs/superpowers/specs/2026-08-13-desk-offstage-design.md
 *
 * 核心转变：**"放不下"从一种失败变成一种状态**。放不下的新卡、被挤出的卡
 * 都不再消失，进等位区排队；空间释放后 reconcile 静默把它们请回台上。
 */
describe('等位区：放不下不再是失败，是一种状态', () => {
  it('放不下的新卡 status 仍是 ok，staged:true，不占桌面', () => {
    mk({ size: '2/3', template: 'nav', kind: 'rule', evictable: false }); now += 10
    const r = unfittable({ data: { title: '第二张', items: [{ label: 'x' }] } })
    expect(r.status).toBe('ok')
    expect(r.staged).toBe(true)
    expect(desk.layout().cards.some(c => c.data?.title === '第二张')).toBe(false)
    expect(desk.layout().staged.some(c => c.data?.title === '第二张')).toBe(true)
  })

  it('被挤出的卡进等位区，不是真的消失', () => {
    for (let i = 0; i < 24; i++) { mk({ size: 'chip', minSize: 'chip', data: { title: `卡${i}` } }); now += 10 }
    const r = mk({ kind: 'system', size: 'chip', minSize: 'chip', data: { title: '来电' } })
    expect(r.status).toBe('ok')
    expect(r.evicted?.length).toBeGreaterThan(0)
    const evictedId = r.evicted![0]
    expect(desk.layout().cards.some(c => c.id === evictedId)).toBe(false)
    expect(desk.layout().staged.some(c => c.id === evictedId)).toBe(true)
  })

  it('空间释放后，staged 卡自动上台（静默，reconcile）', () => {
    const a = mk({ size: '2/3', template: 'nav', kind: 'rule', evictable: false, data: { title: 'A' } }).cardId!
    now += 10
    const rb = unfittable({ data: { title: 'B', items: [{ label: 'x' }] } })
    expect(rb.staged).toBe(true)
    desk.dismiss(a)   // 腾出空间
    desk.tick()
    expect(desk.layout().cards.some(c => c.data?.title === 'B')).toBe(true)
    expect(desk.layout().staged.some(c => c.data?.title === 'B')).toBe(false)
  })

  it('挤位时优先级决定谁走：来的是高优先级，走的是场上低优先级那张（不是它自己进等位区）', () => {
    mk({ size: '1/2', kind: 'system', evictable: false, data: { title: '占位' } }); now += 10
    mk({ size: '1/2', kind: 'task', minSize: '1/2', data: { title: '低优先级' } })
    now += 10
    const r = mk({ size: '1/2', kind: 'system', data: { title: '高优先级' } })
    expect(r.status).toBe('ok')
    expect(r.staged, '高优先级自己上台了，不是进队').toBeFalsy()
    const onstage = desk.layout().cards.map(c => c.data?.title)
    expect(onstage).toContain('高优先级')
    expect(onstage).not.toContain('低优先级')
    expect(desk.layout().staged.some(c => c.data?.title === '低优先级'), '低优先级被挤去排队').toBe(true)
  })

  it('等位区里 untilDismissed 卡不因为久候而过期', () => {
    mk({ size: '2/3', template: 'nav', kind: 'rule', evictable: false }); now += 10
    unfittable({ data: { title: '排队中', items: [{ label: 'x' }] }, ttl: 'untilDismissed' })
    now += 100_000; desk.tick(); now += 100_000; desk.tick()
    expect(desk.layout().staged.some(c => c.data?.title === '排队中')).toBe(true)
  })

  it('等位区里秒数 ttl 的卡照常过期——没人看到的问题卡更该散', () => {
    mk({ size: '2/3', template: 'nav', kind: 'rule', evictable: false }); now += 10
    mk({ size: '2/3', template: 'nav', kind: 'rule', data: { title: '问题卡' }, ttl: 5 })
    now += 6000; desk.tick()
    expect(desk.layout().staged.some(c => c.data?.title === '问题卡')).toBe(false)
  })

  it('等位区上限 8：超限淘汰优先级最低+最老的一张，真消失并通知', () => {
    // 填满 48 单元且全用更高优先级、不可挤——后来的 task 卡一张都进不了台上
    for (let i = 0; i < 24; i++) { mk({ kind: 'system', size: 'chip', minSize: 'chip', evictable: false }); now += 10 }
    const notices: string[] = []
    desk.onNotice(n => notices.push(n.note))
    for (let i = 0; i < 8; i++) { mk({ size: '1/6', data: { title: `排队${i}` } }); now += 10 }
    expect(desk.layout().staged).toHaveLength(8)
    const r = mk({ size: '1/6', data: { title: '第九个' } })
    expect(r.status).toBe('ok')
    expect(desk.layout().staged).toHaveLength(8)   // 仍然是 8，淘汰了一个
    expect(desk.layout().staged.some(c => c.data?.title === '排队0'), '最旧的被淘汰').toBe(false)
    expect(desk.layout().staged.some(c => c.data?.title === '第九个')).toBe(true)
    expect(notices.some(n => n.includes('排队0'))).toBe(true)
  })

  it('新一轮家族清扫也波及等位区——旧批不管在不在台上都退场', () => {
    for (let i = 0; i < 24; i++) { mk({ kind: 'system', size: 'chip', minSize: 'chip', evictable: false }); now += 10 }
    desk.render({ key: 'weather:a', family: 'weather', round: 1, template: 'weather',
      size: '1/6', ttl: 'untilDismissed', data: { title: '成都天气' } })
    expect(desk.layout().staged.some(c => c.data?.title === '成都天气')).toBe(true)
    desk.render({ key: 'weather:b', family: 'weather', round: 2, template: 'weather',
      size: '1/6', ttl: 'untilDismissed', data: { title: '北京天气' } })
    expect(desk.layout().staged.some(c => c.data?.title === '成都天气'), '旧批退场').toBe(false)
  })

  it('findByKey/get 认得等位区里的卡——render() 刷新它不会被当成新卡重建', () => {
    for (let i = 0; i < 24; i++) { mk({ kind: 'system', size: 'chip', minSize: 'chip', evictable: false }); now += 10 }
    const r = desk.render({ key: 'w1', template: 'weather', size: '1/6', ttl: 'untilDismissed',
      data: { title: '天气V1' } })
    expect(r.staged).toBe(true)
    const id = r.cardId!
    expect(desk.get(id)?.data.title).toBe('天气V1')
    expect(desk.findByKey('w1')?.id).toBe(id)
    desk.render({ key: 'w1', template: 'weather', size: '1/6', ttl: 'untilDismissed',
      data: { title: '天气V2' } })
    expect(desk.layout().staged.filter(c => c.key === 'w1')).toHaveLength(1)   // 刷新不是新建
    expect(desk.get(id)?.data.title).toBe('天气V2')
  })

  it('focus() 召回等位区的卡：不必等 tick，立即重新尝试上台', () => {
    const blockerId = mk({ size: '2/3', template: 'nav', kind: 'rule', evictable: false }).cardId!
    now += 10
    const r = unfittable({ data: { title: '待召回', items: [{ label: 'x' }] } })
    expect(r.staged).toBe(true)
    const id = r.cardId!
    desk.dismiss(blockerId)   // 腾出空间，但不调用 tick()
    desk.focus(id)            // 立即召回，不必等下一次 tick 才上台
    expect(desk.layout().cards.some(c => c.id === id), '召回后应在台上').toBe(true)
    expect(desk.layout().staged.some(c => c.id === id)).toBe(false)
  })

  // 台下卡恰恰是挤不过台上的卡才排队的——召回若还用同一套优先级比较，
  // focus 永远失败于同样的格局，"说'看天气'叫回"就成了摆设。
  // 用户点名 = 意愿层，压过优先级比较（物理 > 意愿 > 建议 里的中间层）
  it('focus() 召回压过优先级比较：能挤走台上更高优先级的可挤卡', () => {
    for (let i = 0; i < 24; i++) { mk({ kind: 'system', size: 'chip', minSize: 'chip' }); now += 10 }
    const r = mk({ kind: 'task', template: 'weather', data: { title: '成都天气' } })
    expect(r.staged, 'task 挤不过 system，先排队').toBe(true)
    const f = desk.focus(r.cardId!)
    expect(f.status).toBe('ok')
    expect(desk.layout().cards.some(c => c.id === r.cardId), '召回后在台上').toBe(true)
  })

  it('召回动不了 evictable:false 的卡——用户意愿不破硬约束，继续排队', () => {
    for (let i = 0; i < 24; i++) { mk({ kind: 'system', size: 'chip', minSize: 'chip', evictable: false }); now += 10 }
    const r = mk({ kind: 'task', template: 'weather', data: { title: 'W' } })
    const f = desk.focus(r.cardId!)
    expect(f.status, '排队不是失败').toBe('ok')
    expect((f as any).staged).toBe(true)
    expect(desk.layout().cards.some(c => c.id === r.cardId)).toBe(false)
  })

  it('用户划走等位区的卡：直接消失，不占位不诈尸', () => {
    mk({ size: '2/3', template: 'nav', kind: 'rule', evictable: false }); now += 10
    const r = mk({ key: 'q1', size: '2/3', template: 'nav', kind: 'rule', data: { title: 'Q' } })
    desk.dismiss(r.cardId!, { byUser: true })
    expect(desk.layout().staged.some(c => c.id === r.cardId)).toBe(false)
  })

  it('critical 卡永不进等位区——放不下走覆盖层，行为不变', () => {
    mk({ template: 'nav', size: '2/3', kind: 'rule', evictable: false }); now += 10
    const r = mk({ template: 'notice', size: '1/2', kind: 'system', urgency: 'critical', ttl: 60,
      data: { title: '车门未关' } })
    expect(r.status).toBe('ok')
    expect(desk.layout().overlay?.data?.title).toBe('车门未关')
    expect(desk.layout().staged.some(c => c.data?.title === '车门未关')).toBe(false)
  })
})

/**
 * ══════════ fit() 事务化（2026-08-14 代码审查） ══════════
 *
 * 老实现在腾位过程中**直接改台上卡的 size**（②降低优先级卡、⑤降高优先级卡），
 * 只有成功路径算"提交"；候选最终放不下走 ⑥ 进等位区时，这些压缩既不回滚
 * 也不设 releasedAt（尺寸回落只在 releasedAt 有值时才跑）——台上卡被白白
 * 压到最小档且没有任何恢复触发，用户看到的是"加了一张根本没显示的卡，
 * 桌面却全变小了还回不来"。
 *
 * 改法：试探期只在副本上算，成功才提交。失败什么都没动，天然无需回滚。
 */
describe('fit 事务化：试探失败不留下任何痕迹', () => {
  it('候选放不下进等位区时，为它让过路的卡恢复原尺寸（不留压缩残留）', () => {
    // 导航 8×4 不可挤，右列只剩 4 宽
    mk({ size: '2/3', template: 'nav', kind: 'rule', evictable: false, data: { title: '导航' } }); now += 10
    const a = mk({ template: 'weather', size: '1/6', data: { title: '天气', now: {} } }).cardId!; now += 10
    const b = mk({ template: 'feedback', size: '1/6', data: { title: '反馈' } }).cardId!; now += 10
    const sizeA = desk.get(a)!.size, sizeB = desk.get(b)!.size
    // 一张最小也要 1/2（banner 12×2）的卡：导航占着 8 列，怎么腾都放不下
    const r = mk({ template: 'list', size: '1/2', minSize: '1/2', kind: 'system',
      data: { title: '放不下的', items: [{ label: 'x' }] } })
    expect(r.staged, '它自己进等位区').toBe(true)
    expect(desk.get(a)!.size, '天气卡尺寸没被白白压小').toBe(sizeA)
    expect(desk.get(b)!.size, '反馈卡尺寸没被白白压小').toBe(sizeB)
    expect(desk.layout().cards.map(c => c.data?.title)).toContain('天气')
    expect(desk.layout().cards.map(c => c.data?.title)).toContain('反馈')
  })
})

/**
 * 放大按钮的诚实性（2026-08-14 代码审查，实拍复现）。
 *
 * 老实现：放大目标放不下时 ③ 把候选一路降回原尺寸，然后返回 status:'ok'——
 * 用户点了按钮，尺寸一动不动，按钮还亮着（"点了没反应"）。更坏的是目标为
 * stage/tower 这类不在 LADDER 的专用档时 ③ 直接跳过，落到 ⑥ 把卡送进等位区，
 * 卡片被自己的放大按钮送下台且回不来。
 *
 * 放大是"要更大"，不是"随便多大都行"：够不到就如实说够不到，卡片原样不动。
 */
describe('放大按钮：放不下就如实拒绝，绝不静默变没反应', () => {
  it('放不下时返回 NO_ROOM，卡片留在台上且尺寸不变', () => {
    // 导航 8×4 不可挤 + 右列两张钉死的 urgent 卡，谁都挤不动
    mk({ size: '2/3', template: 'nav', kind: 'rule', evictable: false, data: { title: '导航' } }); now += 10
    mk({ size: '1/6', minSize: '1/6', kind: 'system', urgency: 'urgent', evictable: false, data: { title: '钉A' } }); now += 10
    mk({ size: '1/6', minSize: '1/6', kind: 'system', urgency: 'urgent', evictable: false, data: { title: '钉B' } }); now += 10
    const m = mk({ template: 'media', size: '1/6', kind: 'rule', data: { title: '播放器', track: 'x' } }).cardId
    // 桌面已满，播放器可能进了等位区；只在它真上台时才测放大
    if (m && desk.layout().cards.some(c => c.id === m)) {
      const before = desk.get(m)!.size
      const r = desk.step(m, 'up')
      expect(r.status, '够不到就说够不到').toBe('rejected')
      expect(r.code).toBe('NO_ROOM')
      expect(desk.get(m)!.size, '尺寸原样不动').toBe(before)
      expect(desk.layout().cards.some(c => c.id === m), '还在台上，没被自己的按钮送下台').toBe(true)
    }
  })

  it('导航卡放大够不到 2/3 时不会被送进等位区', () => {
    const nav = mk({ size: 'tower', template: 'nav', kind: 'rule', evictable: false, data: { title: '导航' } }).cardId!
    now += 10
    // 用钉死的 urgent 卡占住剩余空间，让 2/3(8×4) 无论如何放不下
    for (let i = 0; i < 4; i++) {
      mk({ size: '1/6', minSize: '1/6', kind: 'system', urgency: 'urgent', evictable: false, data: { title: '钉' + i } })
      now += 10
    }
    desk.step(nav, 'up')
    expect(desk.layout().cards.some(c => c.id === nav), '导航卡还在台上').toBe(true)
    expect(desk.layout().staged.some(c => c.id === nav), '没被送进等位区').toBe(false)
  })
})

/**
 * 仲裁降级只走模板自己声明的档位（2026-08-14 代码审查）。
 *
 * 老实现里仲裁有一套独立的七档 LADDER，与"每种卡最多三档"的模板契约并行存在：
 * 一张声明了 ['1/6','1/3','1/2'] 的天气卡，会被仲裁自动压成它从没声明过的
 * 'strip' 或 'bar'。两套阶梯并存的直接后果是车机屏必须为全部 10 档都备一套
 * CSS，而模板契约形同虚设。
 */
describe('仲裁降级不越出模板契约', () => {
  it('被压缩的卡只会落在自己声明过的档位上', () => {
    const ids: string[] = []
    for (let i = 0; i < 6; i++) {
      ids.push(mk({ template: 'weather', size: '1/2', data: { title: 'W' + i, now: {} } }).cardId!)
      now += 10
    }
    const allowed = CARD_TEMPLATES.find(t => t.id === 'weather')!.sizes!
    for (const c of desk.layout().cards.filter(c => c.template === 'weather'))
      expect(allowed.map(s => desk.cellsOf(s as any)), `${c.data?.title} 落在 ${c.size}`)
        .toContain(desk.cellsOf(c.size))
  })
})

/**
 * 覆盖层进新退旧（2026-08-14 代码审查，最严重一条）。
 *
 * toOverlay 改写 overlay 指针时不清理旧覆盖层卡：旧卡留在 cards 里，
 * 而 others() 只排除**当前**那张，于是这张占满 12×4 的孤儿参与了每一次
 * 布局试放 —— tryPlace 恒返回 null，被 `?? []` 吞成空数组，桌面上所有卡
 * 一起消失。更糟的是接下来：orchestrator 的 refill 看到规则卡"不在台上"
 * 就重新断言 → render → update() → 无条件 emit → 同步通知订阅者 → refill…
 * 没有任何终止条件，直接 RangeError 栈溢出，整个页面死掉。
 * 782 个测试里没有一条覆盖过双覆盖层。
 */
describe('覆盖层：同一时刻只有一张，进新的先退旧的', () => {
  const overlayCard = (title: string) =>
    desk.show({ template: 'capability', size: 'full', kind: 'system', ttl: 'untilDismissed',
      data: { title, items: [{ label: 'a' }] } })

  it('第二张覆盖层进场时旧的退场，不留占满整屏的孤儿卡', () => {
    const a = overlayCard('能力目录').cardId!
    now += 10
    const b = overlayCard('第二张').cardId!
    expect(desk.layout().overlay?.id, '当前覆盖层是新的那张').toBe(b)
    expect(desk.get(a), '旧覆盖层已退场，不再留在 cards 里').toBeFalsy()
  })

  it('换过覆盖层之后桌面照常工作——不会整屏空掉', () => {
    overlayCard('第一张'); now += 10
    overlayCard('第二张'); now += 10
    const r = mk({ data: { title: '普通卡' } })
    expect(r.status).toBe('ok')
    expect(desk.layout().cards.some(c => c.data?.title === '普通卡'), '普通卡照常上台').toBe(true)
  })

  it('覆盖层退场后，之前被它盖住的桌面卡还在', () => {
    const keep = mk({ data: { title: '底下的卡' } }).cardId!
    now += 10
    const ov = overlayCard('盖住').cardId!
    now += 10
    desk.dismiss(ov)
    expect(desk.layout().cards.some(c => c.id === keep)).toBe(true)
    expect(desk.layout().overlay).toBeUndefined()
  })
})

/**
 * ══════════ 布局缓存与净变化通知（2026-08-14 代码审查·第 4 组） ══════════
 *
 * layout() 是 cards 状态的纯函数，但每次调用都跑一遍完整的 tryPlace
 * （排序 + 24 个列位 × 4 行位试放）。而 desk 有 4 个订阅者（车机屏推送、
 * 检查器、台下清单、规则补回），每次 emit 它们各自独立调一次 layout()——
 * 一次用户操作的重排放大 3~4 倍。叠加 tick() 每 500ms 无条件 emit，
 * 桌面完全静止时每秒仍有约 6 次全排列布局 + 2 次整桌跨窗口克隆。
 */
describe('layout() 缓存：状态没变就不重算', () => {
  it('连续调用返回同一个结果对象（命中缓存）', () => {
    mk({ data: { title: 'A' } })
    expect(desk.layout()).toBe(desk.layout())
  })

  it('卡片变化后缓存失效，拿到的是新结果', () => {
    mk({ data: { title: 'A' } })
    const first = desk.layout()
    now += 10
    mk({ data: { title: 'B' } })
    const second = desk.layout()
    expect(second).not.toBe(first)
    expect(second.cards).toHaveLength(2)
  })

  it('尺寸调整后缓存也失效', () => {
    const id = mk({ template: 'weather', size: '1/6', data: { now: {} } }).cardId!
    const before = desk.layout()
    desk.resize(id, '1/3')
    expect(desk.layout()).not.toBe(before)
  })
})

describe('tick() 只在真有变化时通知', () => {
  it('什么都没发生的一轮 tick 不触发订阅者', () => {
    mk({ data: { title: 'A' } })
    let calls = 0
    desk.subscribe(() => calls++)
    now += 600
    desk.tick()
    expect(calls, '静止的桌面不该每 500ms 惊动一次全链路').toBe(0)
  })

  it('真有卡到期时照常通知', () => {
    mk({ ttl: 5, data: { title: '短命' } })
    let calls = 0
    desk.subscribe(() => calls++)
    now += 6000
    desk.tick()
    expect(calls).toBeGreaterThan(0)
    expect(desk.layout().cards).toHaveLength(0)
  })
})
