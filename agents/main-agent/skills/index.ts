import { NAV_SKILL } from './nav'
import { MEDIA_SKILL } from './media'
import { CARDCRAFT_SKILL } from './cardcraft'
import { STORY_SKILL } from './story'
import { BRIEFING_SKILL } from './briefing'
import { WEATHERWISE_SKILL } from './weatherwise'
import { MOOD_SKILL } from './mood'
import { TRAVEL_SKILL } from './travel'

/**
 * Skill：过程性知识的第三个家（设计文档 §9）。
 * Tool = 能力，Skill = 章法，persona = 品格，记忆 = 事实——四不相混。
 * 二级披露：whenToUse 一行常驻目录，inject 正文 skill.use 命中才注入。
 * 加 skill = 加文件 + 这里挂一行，平台零改动。
 */
export interface Skill {
  name: string
  /** 给目录的一行触发描述（≤20 字）。命中率全靠这句文案——改文案不改码 */
  whenToUse: string
  /** 命中后注入的剧本正文（≤40 行） */
  inject: string
  /** 顺带解锁的工具（走 tools.load 同一通道） */
  tools?: string[]
}

export const SKILLS: Skill[] = [NAV_SKILL, MEDIA_SKILL, CARDCRAFT_SKILL, STORY_SKILL,
  BRIEFING_SKILL, WEATHERWISE_SKILL, MOOD_SKILL, TRAVEL_SKILL]
