/**
 * 长期记忆（偏好）—— 记忆系统的第四级。
 *
 * **显式记忆，不做自动学习**：显式记忆是数据（用户说"记住"就存一条文本），
 * 自动学习（"他连续三次调 24 就记住"）是策略——策略进代码违反"不许意图分支"，
 * 而且不可演示、不可解释。主动式触发（"等我降速就开窗"）是另一个工程，仍在已知待办。
 *
 * 消费方式：prompt 拼装时整包注入 system（"用户偏好：…"），
 * 模型在**策略层**决定怎么用它——代码不解析偏好内容，一个 if 都没有。
 */
import type { DomainStorage } from './domain'
import { defaultStorage } from './domain'

export interface Pref { text: string; createdAt: number }

export function createPrefs(storage: DomainStorage = defaultStorage(),
                            clock: () => number = Date.now) {
  const load = (): Pref[] => {
    try { const raw = storage.get('cockpit.prefs'); return raw ? JSON.parse(raw) : [] }
    catch { return [] }
  }
  let items = load()
  const save = () => { try { storage.set('cockpit.prefs', JSON.stringify(items)) } catch { /* 满了算了 */ } }

  return {
    /** 返回是否新增（重复内容不追加） */
    remember(text: string): boolean {
      const t = text.trim()
      if (!t || items.some(p => p.text === t)) return false
      items = [...items, { text: t, createdAt: clock() }]
      save()
      return true
    },
    /** 模糊匹配删除——用户不会一字不差复述自己当初说的话 */
    forget(fragment: string): boolean {
      const before = items.length
      const f = fragment.trim()
      if (!f) return false
      items = items.filter(p => !p.text.includes(f))
      if (items.length === before) return false
      save()
      return true
    },
    list: (): Pref[] => [...items],
  }
}

export type Prefs = ReturnType<typeof createPrefs>
