/**
 * 卡片的几何契约检查 —— 站在 desk 这个唯一咽喉上。
 *
 * 卡片创建有三条路：规则（orchestrator）、Tool（registry）、handler 直调 desk。
 * 之前只有 Tool 那条过 checkSize，每加一个 handler 都是一个绕闸的机会。
 * 空壳卡检查（EMPTY_CARD）已经落在 desk，尺寸闸跟进——**尺寸是几何契约，归 desk 管**。
 *
 * 形状校验（checkDataShape）刻意**留在 registry**：形状是模型契约，
 * 只在模型输入的入口把关。handler 的 data 是代码拼的，类型系统管它；
 * 而且规则卡有合法的降级形态（无高德 Key 时导航卡没有 mapUrl），
 * 形状闸下沉会把降级模式打死。这是对设计 §3.1 的一处修正，记录在案。
 */
import { CARD_TEMPLATES, COMMON_SIZES } from '../config/cards'
import { TIERS, ALIAS, normalizeTier } from '../config/grid'

/** 认识这个尺寸名吗（新档位名或老别名）。乱写的名字在这里拦住，不吃 normalizeTier 的兜底 */
export const knownSize = (z: string) => z in TIERS || z in ALIAS

export interface SizeError { code: 'SIZE_NOT_SUPPORTED'; message: string }

/**
 * 模板只允许它声明过的档位。比对前两侧都过 normalizeTier ——
 * '1/6' 和 'card' 是同一档的两个名字，裸字符串 includes 是踩过的坑
 * （LADDER.indexOf('1/3') = -1 那次就是它的第一次爆发）。
 */
export function checkSize(templateId: string, size: string): SizeError | null {
  const tmpl = CARD_TEMPLATES.find(t => t.id === templateId)
  if (!tmpl) return null   // 未知模板不归尺寸闸管，titleOf 另有兜底
  const allowed = tmpl.sizes ?? [...COMMON_SIZES]
  const fail = (): SizeError => ({
    code: 'SIZE_NOT_SUPPORTED',
    message: `${tmpl.label}不支持 ${size} 尺寸，支持：${allowed.join('、')}`,
  })
  if (!knownSize(size)) return fail()
  const want = normalizeTier(size)
  return allowed.some(z => normalizeTier(z) === want) ? null : fail()
}
