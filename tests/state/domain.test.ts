import { describe, it, expect } from 'vitest'
import { createDomainState, type DomainStorage } from '../../src/state/domain'

/**
 * 领域状态仓 —— 记忆系统的第三级。
 *
 * 队列/历史/收藏不是车辆状态（不进信号 store——"这条界线不划清，
 * 车速转速电流都会往里挤"），也不是遥测。它们是内容域的数据，
 * 是"下一曲""再放刚才那首""播放我的收藏"能成立的地基。
 */

/** 可注入的假存储——测"刷新之后还在"不需要真 localStorage */
const fakeStorage = (): DomainStorage & { dump: Record<string, string> } => {
  const dump: Record<string, string> = {}
  return { get: k => dump[k] ?? null, set: (k, v) => { dump[k] = v }, dump }
}

const t = (n: string) => ({ source: 'music', track: '歌' + n, artist: '人' + n, streamUrl: 'https://x/' + n })

describe('播放队列', () => {
  it('整批入队，cursor 指向命中项', () => {
    const d = createDomainState(fakeStorage())
    d.queue.set([t('1'), t('2'), t('3')], 1, 'search')
    expect(d.queue.current()!.track).toBe('歌2')
    expect(d.queue.size()).toBe(3)
  })

  it('next/prev 沿队列走，到头返回 null——"下一曲"从此有的放矢', () => {
    const d = createDomainState(fakeStorage())
    d.queue.set([t('1'), t('2')], 0, 'search')
    expect(d.queue.next('sequential')!.track).toBe('歌2')
    expect(d.queue.next('sequential'), '到尾了').toBeNull()
    expect(d.queue.prev()!.track).toBe('歌1')
  })

  // 单曲循环下自动续播 = 重放当前；用户手动"下一曲"仍然前进——两种意图不同
  it('repeatOne：自动续播重放当前，手动 next 仍前进', () => {
    const d = createDomainState(fakeStorage())
    d.queue.set([t('1'), t('2')], 0, 'search')
    expect(d.queue.advance('repeatOne')!.track, '自动续播重放').toBe('歌1')
    expect(d.queue.next('repeatOne')!.track, '手动前进').toBe('歌2')
  })

  it('shuffle 用注入的随机源——可测，不吃 Math.random', () => {
    const d = createDomainState(fakeStorage(), () => 0.9)
    d.queue.set([t('1'), t('2'), t('3')], 0, 'search')
    const nxt = d.queue.advance('shuffle')!
    expect(nxt.track).not.toBe('歌1')   // 随机也不该原地踏步
  })

  it('peek 看接下来几首，不动 cursor', () => {
    const d = createDomainState(fakeStorage())
    d.queue.set([t('1'), t('2'), t('3')], 0, 'search')
    expect(d.queue.peek(2).map(x => x.track)).toEqual(['歌2', '歌3'])
    expect(d.queue.current()!.track).toBe('歌1')
  })
})

describe('收藏：持久化，刷新不丢', () => {
  it('同一份存储再开一个实例，收藏还在——修"刷新即丢"', () => {
    const st = fakeStorage()
    const a = createDomainState(st)
    a.favorites.add({ source: 'music', track: '晴天', artist: '周杰伦', streamUrl: 'https://x/1' })
    const b = createDomainState(st)   // 模拟刷新
    expect(b.favorites.list().map(f => f.track)).toContain('晴天')
  })

  it('重复收藏不追加', () => {
    const d = createDomainState(fakeStorage())
    const f = { source: 'music', track: '晴天', artist: '周杰伦', streamUrl: 'https://x/1' }
    expect(d.favorites.add(f)).toBe(true)
    expect(d.favorites.add(f)).toBe(false)
    expect(d.favorites.list()).toHaveLength(1)
  })
})

describe('历史：环形缓冲', () => {
  it('播放历史封顶 50，最新在前', () => {
    const d = createDomainState(fakeStorage())
    for (let i = 0; i < 60; i++) d.history.push(t(String(i)))
    expect(d.history.recent(3).map(x => x.track)).toEqual(['歌59', '歌58', '歌57'])
    expect(d.history.recent(100)).toHaveLength(50)
  })

  it('查询历史存实体和结论，够"刚才查的成都多少度"用', () => {
    const d = createDomainState(fakeStorage())
    d.queries.push({ kind: 'weather', entity: '成都', brief: '31° 多云' })
    expect(d.queries.recent(1)[0].brief).toContain('31')
  })
})
