/**
 * 交互声明 —— 模板契约的第三件套（前两件：数据形状 fields、形态 forms）。
 *
 * **数据，不是代码**：手势层只做 命中测试 → 查声明 → 按路由分发，
 * 模型始终只学一个接口（card.* 工具），不是 N 张卡 N 套协议。
 * 加交互 = 加声明。三类路由（已拍板）：
 *   answer  等价语音输入（点候选第 2 项 = 说"第二个"），进对话——模型知道用户选了什么
 *   tool    直调 Tool 不叫醒模型（按暂停要等 LLM 转一圈是灾难；对标方向盘硬按键）
 *   desk    桌面管理（滑撤），记入意愿层——滑掉的卡规则不许下一秒刷回来
 */

export interface InteractionDecl {
  on: string
  route: 'answer' | 'tool' | 'desk'
  tool?: string
  args?: Record<string, unknown>
  op?: 'dismiss'
}

/** 通用滑撤：绝大多数卡都能划走 */
const SWIPE_AWAY: InteractionDecl = { on: 'swipe:away', route: 'desk', op: 'dismiss' }

export const INTERACTIONS: Record<string, InteractionDecl[]> = {
  media: [
    { on: 'tap:prev', route: 'tool', tool: 'media.control', args: { action: 'prev' } },
    { on: 'tap:toggle', route: 'tool', tool: 'media.control', args: { action: 'pause' } },
    { on: 'tap:next', route: 'tool', tool: 'media.control', args: { action: 'next' } },
    SWIPE_AWAY,
  ],
  list: [{ on: 'tap:item', route: 'answer' }, SWIPE_AWAY],
  confirm: [{ on: 'tap:item', route: 'answer' }, SWIPE_AWAY],
  capability: [SWIPE_AWAY],
  weather: [SWIPE_AWAY],
  feedback: [SWIPE_AWAY],
  notice: [SWIPE_AWAY],
  info: [SWIPE_AWAY],
  generic: [SWIPE_AWAY],
  control: [SWIPE_AWAY],
  canvas: [SWIPE_AWAY],
  /** 沙箱组件：cockpit.action 上来的都是"用户在组件里的选择"——回答类 */
  'canvas-app': [{ on: 'app', route: 'answer' }, SWIPE_AWAY],
  /** 导航卡刻意没有 swipe:away——导航中把导航划掉是事故 */
  nav: [],
}

export const routeOf = (template: string, on: string): InteractionDecl | undefined =>
  INTERACTIONS[template]?.find(d => d.on === on)
