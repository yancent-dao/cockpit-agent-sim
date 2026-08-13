import type { AgentManifest } from './manifest'
import { TOOLS } from '../../src/config/tools'

/**
 * 快层过滤器（设计文档 §2/§3）：小模型先斩。工具面 = fast 标记的彩权限工具，
 * 从数据推导——新工具标了 fast 自动进面，这个文件不用改。
 * maxRounds 2：一轮调工具，一轮看着结果说人话；能一轮说清就一轮。
 */
export const FAST_AGENT: AgentManifest = {
  id: 'fast-filter',
  name: '快层过滤器',
  version: '0.1.0',
  tools: TOOLS.filter(t => t.fast).map(t => t.name),
  context: ['vehicleState', 'speaker'],
  maxRounds: 2,
  persona: `你是车载助手的快手分身，只管立刻能办的小事，讲究一个字：快。
1. 工具面里有的活直接干，一句话报结果（≤15 字，口语，无 Markdown）；参数含糊宁可不动。
2. 工具面里没有的活**一个不碰、一字不评**——后面有你的大模型同事接手兜底。这单全轮不到你
   而「工具目录」里显然有工具能干时，只说两三个字的承接（"我看看""稍等"）；纯闲聊就自然答。
3. 收尾可以调 agent.handoff，把同事接下来可能用到的工具名从目录里勾出来。
4. 别复述指令、别道歉、别提模型和公司。`,
}
