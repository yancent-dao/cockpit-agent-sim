import { describe, it, expect } from 'vitest'
import { createFlow } from '../../src/core/flow'

/**
 * 长流程状态机（交互总设计 R2）：机制持有状态，每个状态只放行白名单内
 * 的工具，其余拒绝并报当前状态——把绘本的散点"锁门"补丁升级为契约。
 * 通用件：绘本是第一个用户，自动化 ask / MRTR 以后迁进来。
 */

const STORY_FLOW = {
  id: 'story',
  initial: 'idle',
  states: {
    idle: { tools: ['story.profile', 'story.cast'], deny: '还没开书，先 story.cast 定妆' },
    casting: { tools: ['story.profile', 'story.cast', 'story.begin'], deny: '定妆照在等家长认可，除了重画什么都别做' },
    telling: { tools: ['story.continue', 'story.finish', 'story.page'], deny: '正在讲述，不能重新 begin/cast' },
    done: { tools: ['story.profile', 'story.cast', 'story.export'], deny: '已收场，只有孩子亲口说再讲一个才重新开书' },
  },
}

describe('createFlow', () => {
  it('初始态白名单放行，名单外拒绝并报当前状态的 deny 文案', () => {
    const f = createFlow(STORY_FLOW)
    expect(f.state).toBe('idle')
    expect(f.allow('story.cast')).toBeNull()
    expect(f.allow('story.begin')).toContain('先 story.cast 定妆')
  })

  it('转移后按新状态判定——telling 态想重新 begin/cast 被拒（治重开书重定妆）', () => {
    const f = createFlow(STORY_FLOW)
    f.to('casting')
    expect(f.allow('story.begin')).toBeNull()
    f.to('telling')
    expect(f.allow('story.begin')).toContain('正在讲述')
    expect(f.allow('story.cast')).toContain('正在讲述')
    expect(f.allow('story.continue')).toBeNull()
  })

  it('done 态放行 cast=开新书；转移到未知状态直接抛（声明错误要炸在开发期）', () => {
    const f = createFlow(STORY_FLOW)
    f.to('done')
    expect(f.allow('story.cast')).toBeNull()
    expect(f.allow('story.continue')).toContain('已收场')
    expect(() => f.to('nonsense')).toThrow()
  })

  it('声明表之外的工具不归它管（返回 null 放行）——状态机只管自家流程', () => {
    const f = createFlow(STORY_FLOW)
    expect(f.allow('climate.set')).toBeNull()
    expect(f.allow('voice.speak')).toBeNull()
  })
})
