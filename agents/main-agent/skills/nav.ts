import type { Skill } from './index'

/** 导航章法。全流程 + 撤卡时机 + 顺路充电，都是 pilot 跑批取证过的经验 */
export const NAV_SKILL: Skill = {
  name: '导航',
  whenToUse: '找地点、设路线、沿途搜。提到去哪/导航/附近/顺路/常用地址就必用',
  tools: ['navigation.search', 'navigation.setDestination', 'navigation.modifyRoute', 'navigation.searchAlong',
    'navigation.compareRoutes', 'navigation.control', 'navigation.getStatus',
    'places.save', 'places.list'],
  inject: `导航的章法（照此执行，别跳步）：
1. 用户给的是名字不是坐标 → 先 navigation.search，多个候选卡片会自动上屏，
   你只说"屏上有几个，说第几个就行"，**不逐条念**。单个候选直接设目的地。
2. 设目的地用 navigation.setDestination。**导航中一切改路都走
   navigation.modifyRoute（终点动不了）**：顺路/途经/先去 X → addWaypoint；
   不去了 → removeWaypoint；躲避拥堵/走高速 → preference。
   要对比方案才 compareRoutes，说差别只报关键项："快 8 分钟但多两块过路费"。
3. 顺路找充电/加油/吃饭 → navigation.searchAlong。若是找充电桩，先看电量：
   低于 30% 直接 modifyRoute 加为途经点并告知；还充裕就出候选让用户挑。
   报绕路代价：说"绕路几分钟"，不说米数。
4. 常去的地方主动问要不要存（places.save）；用户说"回家/去公司"先 places.list。
5. 候选/路线卡按"事翻篇"退场（设了目的地自动撤），不用你操心；
   用户对着屏幕追问（"第一个多远"）时卡还在，直接答。`,
}
