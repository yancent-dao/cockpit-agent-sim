import { describe, it, expect } from 'vitest'
import { createDesk } from '../../src/cards/desk'

/**
 * 跑批（nav-cross-province T3）撞出来的：`navigation.searchAlong` 在川藏线上
 * 搜服务区返回 0 条，handler 照样建了卡 —— 屏上留着一张
 * 「附近的服务区」标题下面什么都没有的空壳。
 *
 * **空卡比不显示更糟**：用户看到标题会以为在加载，或者以为真的一个都没有；
 * 而 Agent 那边还占着一个格子。这不是"贴心逻辑"，是卡片契约 ——
 * 一张列表卡的意思就是"这里有几条东西"，0 条时这句话是假的。
 */
describe('列表卡不能是空壳', () => {
  it('items 为空的列表卡进不了桌面', () => {
    const d = createDesk()
    const r = d.show({ template: 'list', size: '1/3', ttl: 120, data: { title: '附近的服务区', items: [] } })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('EMPTY_CARD')
    expect(d.layout().cards).toHaveLength(0)
  })

  /** 拒绝要带人话原因 —— 它会直接进模型上下文，得让它知道下一步该说什么 */
  it('拒绝理由写人话，模型看了知道该开口说"没找到"', () => {
    const d = createDesk()
    const r = d.show({ template: 'list', size: '1/3', ttl: 120, data: { title: '候选', items: [] } })
    expect(r.message).toMatch(/没|空/)
  })

  it('有内容的照常进', () => {
    const d = createDesk()
    expect(d.show({ template: 'list', size: '1/3', ttl: 120, data: { title: '候选', items: [{ label: 'a' }] } })
      .status).toBe('ok')
  })

  // 只管列表类。车控卡的 items 空着是合法的（一扇窗都没开也要显示）
  it('非列表模板不受影响', () => {
    const d = createDesk()
    expect(d.show({ template: 'feedback', size: '1/6', ttl: 60, data: { title: '好了', text: '关好了' } })
      .status).toBe('ok')
  })

  /** render() 走的是同一条路：规则驱动的刷新也不该刷出空壳 */
  it('render 刷新成空列表时把卡撤掉，不是留个空壳在那儿', () => {
    const d = createDesk()
    d.render({ key: 'along', template: 'list', size: '1/3', ttl: 120, data: { title: '沿途', items: [{ label: 'a' }] } })
    expect(d.layout().cards).toHaveLength(1)
    d.render({ key: 'along', template: 'list', size: '1/3', ttl: 120, data: { title: '沿途', items: [] } })
    expect(d.layout().cards).toHaveLength(0)
  })
})
