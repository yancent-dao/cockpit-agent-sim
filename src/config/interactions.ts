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
  /** tool 路由的动态参数：条目携带的 value 填进这个名字的参数（args 管不了逐条不同的场合） */
  valueParam?: string
  op?: 'dismiss' | 'shrink' | 'grow'
}

/** 通用滑撤：绝大多数卡都能划走 */
const SWIPE_AWAY: InteractionDecl = { on: 'swipe:away', route: 'desk', op: 'dismiss' }
/**
 * 右上角尺寸调节 + 关闭（2026-08-13 实拍反馈）：机械的桌面管理动作，
 * 不叫醒模型——跟滑撤同一条路由，只是从"划一下卡片"变成"点一个按钮"。
 * 每个模板都能缩放；CLOSE 单独列，因为导航卡要挖掉它（下面 nav 那条）。
 */
const SHRINK: InteractionDecl = { on: 'tap:shrink', route: 'desk', op: 'shrink' }
const GROW: InteractionDecl = { on: 'tap:grow', route: 'desk', op: 'grow' }
const CLOSE: InteractionDecl = { on: 'tap:close', route: 'desk', op: 'dismiss' }
const RESIZE = [SHRINK, GROW]

export const INTERACTIONS: Record<string, InteractionDecl[]> = {
  media: [
    { on: 'tap:prev', route: 'tool', tool: 'media.control', args: { action: 'prev' } },
    { on: 'tap:toggle', route: 'tool', tool: 'media.control', args: { action: 'toggle' } },
    { on: 'tap:next', route: 'tool', tool: 'media.control', args: { action: 'next' } },
    SWIPE_AWAY, ...RESIZE, CLOSE,
  ],
  list: [{ on: 'tap:item', route: 'answer' }, SWIPE_AWAY, ...RESIZE, CLOSE],
  /** 台下清单：召回是桌面管理的机械动作，直调不叫醒模型（点一下等 LLM 转一圈是灾难） */
  stagedlist: [{ on: 'tap:item', route: 'tool', tool: 'card.focus', valueParam: 'cardId' }, SWIPE_AWAY, ...RESIZE, CLOSE],
  confirm: [{ on: 'tap:item', route: 'answer' }, SWIPE_AWAY, ...RESIZE, CLOSE],
  capability: [SWIPE_AWAY, ...RESIZE, CLOSE],
  weather: [SWIPE_AWAY, ...RESIZE, CLOSE],
  feedback: [SWIPE_AWAY, ...RESIZE, CLOSE],
  notice: [SWIPE_AWAY, ...RESIZE, CLOSE],
  info: [SWIPE_AWAY, ...RESIZE, CLOSE],
  generic: [SWIPE_AWAY, ...RESIZE, CLOSE],
  control: [SWIPE_AWAY, ...RESIZE, CLOSE],
  canvas: [SWIPE_AWAY, ...RESIZE, CLOSE],
  /** 沙箱组件：cockpit.action 上来的都是"用户在组件里的选择"——回答类 */
  'canvas-app': [{ on: 'app', route: 'answer' }, SWIPE_AWAY, ...RESIZE, CLOSE],
  clock: [SWIPE_AWAY, ...RESIZE, CLOSE],
  /**
   * 导航卡刻意没有 swipe:away / tap:close——导航中把导航关掉是事故。
   * 但缩放不是关闭：加了缩放按钮后不用再把导航卡强制钉成最大（2026-08-13 实拍反馈），
   * 用户可以随时缩小看更多桌面，优先级（左锚定、不可被挤下桌）不受影响。
   */
  nav: [...RESIZE],
}

export const routeOf = (template: string, on: string): InteractionDecl | undefined =>
  INTERACTIONS[template]?.find(d => d.on === on)
