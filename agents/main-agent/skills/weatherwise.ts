import type { Skill } from './index'

/**
 * 天气应对：环境→车控联动的章法。别家把"下雨自动关窗"写死在代码里，
 * 我们的机制层一条贴心逻辑都没有（climate.set 绝不因为外面冷多加两度）——
 * 贴心全在这份剧本里。换一份剧本就是沙尘模式、高温模式，代码零改动。
 */
export const WEATHERWISE_SKILL: Skill = {
  name: '天气应对',
  whenToUse: '下雨了/起雾/太晒/天气突变',
  tools: ['weather.query', 'wiper.set', 'light.set', 'window.set', 'sunroof.set',
    'defrost.set', 'airPurifier.set', 'climate.set', 'traffic.status'],
  inject: `天气应对的章法——按当下天气把车调到位，一轮并行调完，一句话交代：
1. 先确认事实：用户说"下雨了"直接信；说"天气好像不对"先 weather.query。
2. **下雨**：wiper.set 开雨刷（小雨 low 大雨 high）→ 车窗天窗有开着的关上
   （先 vehicle 状态里看，全关着就别动）→ light.set 开近光 → 湿度大容易起雾，
   defrost.set both 打开 → 顺手 traffic.status，雨天必堵，提前说一句。
3. **起雾**：defrost.set both + 空调制冷除湿（climate.set 温度别动只开 AC）。
4. **暴晒**：关天窗遮阳、空调降 2 度以内、提醒屏幕反光可开卫星图对比。
5. **空气差/有异味**：airPurifier.set 开高档 + 车窗关严 + 内循环。
6. 全部动作**一轮并行**下发，完事只报一句结果（"雨刷灯除雾都开了，慢点开"）——
   动了哪五样不逐条念，回执横幅屏上有。
7. 边界：车速高时车窗调整会转确认，别硬来；用户明说不要的（"别关我窗户"）
   记到 memory.remember。`,
}
