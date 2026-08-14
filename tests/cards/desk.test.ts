import { describe, it, expect, beforeEach } from 'vitest'
import { createDesk } from '../../src/cards/desk'
import { CARD_TEMPLATES } from '../../src/config/cards'

let now = 1000
let desk: ReturnType<typeof createDesk>
const mk = (o: any = {}) => desk.show({ template: 'feedback', size: '1/6', ttl: 'untilDismissed', ...o })

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
    mk({ size: '1/3', data: { title: 'A' } })
    const c = desk.layout().cards[0]
    expect(c.row).toBe(0)
    expect(c.col).toBe(0)
    expect(c.rowSpan).toBe(2)
    expect(c.colSpan).toBe(8)
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

  it('2/3 在场时 1/3 横卡（宽 8）放不下右边的 4 列 → 自动降为 1/6', () => {
    mk({ size: '2/3', template: 'nav', kind: 'rule' }); now += 10
    const r = mk({ size: '1/3', data: { title: '天气' } })
    expect(r.status).toBe('ok')
    const placed = desk.layout().cards.find(c => c.data?.title === '天气')!
    // 降档后 size 是新档位名。card 就是老的 1/6，行为没变、名字换了
    expect(desk.cellsOf(placed.size)).toBeLessThanOrEqual(desk.cellsOf('1/6'))
    expect(r.shrunk).toBeTruthy()
  })

  it('同一时刻最多一张 2/3——第二张放不下且第一张不可挤则进等位区（2026-08-13 改：不再拒绝）', () => {
    mk({ size: '2/3', template: 'nav', kind: 'rule', evictable: false }); now += 10
    const r = mk({ size: '2/3', template: 'nav', kind: 'rule' })
    expect(r.status).toBe('ok')
    expect(r.staged).toBe(true)
    expect(desk.layout().cards).toHaveLength(1)   // 只有第一张上台
    expect(desk.layout().staged.map(c => c.id)).toContain(r.cardId)
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
    const r = mk({ kind: 'rule', size: '1/3', data: { title: '导航提示' } })
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

  it('几何死局的最后手段：高优先级卡可被降尺寸（但绝不被挤出）——导航到来时 system 1/3 问题卡降为 1/6', () => {
    mk({ kind: 'system', size: '1/3', data: { title: '请选择', question: 'q' }, template: 'confirm' }); now += 10
    const r = mk({ size: '2/3', template: 'nav', kind: 'rule', evictable: false, data: { title: '导航' } })
    expect(r.status).toBe('ok') // 之前这里会被 DESKTOP_FULL 拒绝，导航卡整个出不来
    const titles = desk.layout().cards.map(c => c.data?.title)
    expect(titles).toContain('导航')
    expect(titles).toContain('请选择') // 没被挤出，只是变小了
    // card 就是老的 1/6。断言"变小了"而不是断死某个名字
    expect(desk.cellsOf(desk.layout().cards.find(c => c.data?.title === '请选择')!.size))
      .toBeLessThan(desk.cellsOf('1/3'))
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
    const r = desk.render({ key: 'w', template: 'control', size: '1/3', ttl: 30 })
    expect(r.level).toBe('L2')
    expect(desk.layout().cards[0].size).toBe('1/3')
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
    desk.resize(id, '1/3')
    now += 10
    // orchestrator 每次状态变化都这么调
    desk.render({ key: 'nav', template: 'nav', size: '2/3', kind: 'rule',
      evictable: false, ttl: 'untilDismissed', data: { title: '导航', eta: 19 } })
    const c = desk.findByKey('nav')!
    expect(c.size).toBe('1/3')      // 用户的选择还在
    expect(c.data.eta).toBe(19)     // 数据照常更新
  })

  // render 的既有语义是只放大不缩小——规则重刷不该让卡片忽大忽小。
  // 没上锁的卡，空间腾出来时规则能把它带回默认尺寸
  it('没被 resize 过的卡，规则重刷能放大回默认尺寸', () => {
    desk.render({ key: 'nav', template: 'nav', size: '1/3', kind: 'rule',
      evictable: false, ttl: 'untilDismissed', data: { title: '导航' } })
    expect(desk.findByKey('nav')!.size).toBe('1/3')
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

/* ══════════════ urgency：正交于 kind 的紧急度 ══════════════ */
/**
 * 之前 PRIORITY 只看 kind，描述的是「谁建的卡」。
 * 后果：车门没关且已起步的安全告警，跟天气卡同为 rule，抢位时按 LRU 决定谁活。
 */
describe('urgency 参与仲裁', () => {
  it('critical 卡不会被挤出，哪怕它是最旧的 task', () => {
    mk({ urgency: 'critical', size: '1/3', data: { title: '车门未关' } }); now += 10
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
    const r = mk({ size: '1/3', urgency: 'critical', data: { title: '胎压过低' } })
    expect(r.status).toBe('ok')
    expect(desk.layout().overlay).toBeUndefined()
    expect(desk.layout().cards.some(c => c.data?.title === '胎压过低')).toBe(true)
  })

  it('非 critical 卡放不下不再拒绝也不滥用覆盖层——进等位区（2026-08-13 改）', () => {
    mk({ template: 'nav', size: '2/3', kind: 'rule', evictable: false }); now += 10
    const r = mk({ size: '1/2', kind: 'system', data: { title: '普通提示' } })
    expect(r.status).toBe('ok')       // 会被降档放进右边竖条
    const r2 = mk({ size: '2/3', template: 'nav', kind: 'rule', data: { title: '第二张大卡' } })
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
  it('阶梯覆盖 chip 到 banner 七档', () => {
    expect(desk.ladder()).toEqual(['chip', 'strip', 'bar', 'card', 'wide', 'panel', 'banner'])
  })

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
    const r = mk({ size: '2/3', template: 'nav', kind: 'rule', data: { title: '第二张' } })
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
    const rb = mk({ size: '2/3', template: 'nav', kind: 'rule', data: { title: 'B' } })
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
    mk({ size: '2/3', template: 'nav', kind: 'rule', data: { title: '排队中' }, ttl: 'untilDismissed' })
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
    const r = mk({ size: '2/3', template: 'nav', kind: 'rule', data: { title: '待召回' } })
    expect(r.staged).toBe(true)
    const id = r.cardId!
    desk.dismiss(blockerId)   // 腾出空间，但不调用 tick()
    desk.focus(id)            // 立即召回，不必等下一次 tick 才上台
    expect(desk.layout().cards.some(c => c.id === id), '召回后应在台上').toBe(true)
    expect(desk.layout().staged.some(c => c.id === id)).toBe(false)
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
