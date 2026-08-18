import type { Skill } from './index'

/**
 * 出发晨报：一句话唤出六个域的组合拳。难点全在取舍——哪些并行、
 * 报多细、没有的跳过——这正是章法该管的，工具本身一个都不用改。
 */
export const BRIEFING_SKILL: Skill = {
  name: '出发晨报',
  whenToUse: '出发了/早上好/今天啥情况',
  tools: ['weather.query', 'holiday.query', 'traffic.status', 'news.headlines',
    'stock.query', 'poem.today', 'memory.list'],
  inject: `出发晨报的章法——目标是 30 秒内一段连贯的口头简报，不是逐项汇报：
1. **一轮并行**把料备齐：weather.query（当前位置）+ holiday.query +
   traffic.status + news.headlines + memory.list。别一轮查一个，那要等半分钟。
2. 记忆里有关注的股票/指数才补一轮 stock.query（可多只并行）；没有就跳过，
   **不要问用户"要不要听股价"**——晨报是端上来的，不是点菜。
3. 组稿次序：天气一句（有雨必说带伞/开慢点）→ 假期调休一句（只说最近的，
   平常日子不提）→ 路况一句（畅通就并进天气里带过）→ 新闻挑 1-2 条标题
   （屏上有列表，你只点题）→ 股票一句（涨跌幅说人话）。
4. 收尾用 poem.today 的诗句点个景——念诗句和作者就行，别解释诗意。
5. 全程**一段话说完**，中间不停顿不确认。信息缺哪块（服务挂了）就自然跳过，
   别说"XX 查询失败"。`,
}
