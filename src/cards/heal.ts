/**
 * 生成式卡的尺寸自愈决策 —— 机制，零模型（公理 4）。
 *
 * "动态尺寸 ≠ 任意像素"（任意像素会同时废掉死缝不变量、可预测性、像素契约）。
 * 动态 = 在十档白名单内按**实测内容高度**升降：
 * 溢出升一档（屏幕不可滚动，超出的部分用户永远看不到），
 * 内容不足六成缩一档还位给桌面。
 *
 * 两道闸：≤2 次防振荡（升上去又量出偏小又缩回来的循环）；
 * sizeLocked 例外——用户缩小过的卡宁可折角提示，意愿 > 建议。
 */
import { pixelsOf, cellsOfTier, normalizeTier, dimsOf } from '../config/grid'
import { CARD_TEMPLATES, COMMON_SIZES } from '../config/cards'

/**
 * 自愈阶梯 = **这张卡的模板自己声明的尺寸表**，按面积升序，tower 除外
 * （4×4 竖条是专用档，混进序列会让 1/2 的"下一步"变成宽度砍半、内容反而更高；
 * 模型要竖条卡自己显式声明，自愈不路过它）。
 *
 * 以前这里手抄了第二份阶梯，里面还留着 'full'——而产品裁定后 canvas 的上限
 * 是 2/3、full 明令禁止：2/3 的卡溢出时 healStep 每次返回 full、resize 每次被
 * SIZE_NOT_SUPPORTED 拒绝，而 bumps 只在成功时才 +1，于是 ≤2 次的防振荡闸
 * 永远闭合不了，每条 canvasNote 都空转一次。跟 desk 的仲裁同一条纪律：
 * **卡片只会出现在自己声明过的档位上**，别处不该再有第二份阶梯。
 */
const ladderFor = (template?: string) => {
  const tmpl = template ? CARD_TEMPLATES.find(t => t.id === template) : undefined
  return [...(tmpl?.sizes ?? COMMON_SIZES)]
    // 窄高的专用形状不进自愈阶梯：tower(4×8) 和 frame(4×6) 都比 box 更窄，
    // 自动"升"到它们等于宽度砍半、文字更挤，内容只会更高。模型要竖条自己显式声明
    .filter(z => !['tower', 'frame'].includes(normalizeTier(z)))
    /**
     * 同面积时按宽度排，让阶梯里**不出现两个面积相同的档** ——
     * 有的话"升一档"和"降一档"会落到不同的那个（升取前者、降取后者），
     * 来回一趟回不到原点，防振荡的次数闸就形同虚设。
     */
    .sort((a, b) => cellsOfTier(a) - cellsOfTier(b) || dimsOf(b)[0] - dimsOf(a)[0])
}

export interface HealOpts { bumps: number; sizeLocked?: boolean; template?: string }

export function healStep(size: string, contentPx: number, opts: HealOpts): string | null {
  if (opts.sizeLocked) return null
  if (opts.bumps >= 2) return null
  const LADDER = ladderFor(opts.template)
  const idx = LADDER.findIndex(z => normalizeTier(z) === normalizeTier(size))
  if (idx < 0) return null
  const canvasH = pixelsOf(size).h
  // +2 是亚像素舍入的余量——跟车机屏溢出检测同一个数
  if (contentPx > canvasH + 2) return idx < LADDER.length - 1 ? LADDER[idx + 1] : null
  if (contentPx < canvasH * 0.6) return idx > 0 ? LADDER[idx - 1] : null
  return null
}
