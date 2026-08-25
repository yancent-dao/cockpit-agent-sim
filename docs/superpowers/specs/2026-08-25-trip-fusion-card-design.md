# 融合旅行卡 trip(2026-08-25)

设计稿:artifact「旅行助手 HMI」page-fusion(https://claude.ai/code/artifact/3a011038-23ed-4fb3-af50-12730e1d0f51)。
用户两轮反馈定型:①攻略/行程/机票/酒店要在**同一张卡**上,有图有曲线,有新信息原地更新;
②攻略要马蜂窝式详细(行前准备 + Day-by-day 动线 + 每站介绍/tips/交通);
③不同地区住不同酒店(分段住宿,各盯各的价);④Day 之间做**自动轮播**,不要点选钻取——
一张卡,档位不同显示的信息不同。

## 一句话架构

**trip 卡 = f(旅行任务仓)。** 攻略数据进仓(不再是模型 card.show 的一次性内容),
paintTrip 是唯一渲染出口,三个阶段是**数据形状**不是状态机:

- 有 days 没 watches → 攻略阶段(头图 + 行前准备 + Day 轮播帧)
- 有 watches → 盯价阶段(+ D-day 徽标 + 机票/分段住宿价格块,轮播压成单行继续转)
- 有 fired 的 watch → 到价阶段(价格块高亮 + 琥珀决策条)

同 key(`travel-trip`)原地生长,不弹新卡。guide/itinerary 两个模板**退役**,
trend 从常驻卡降级为钻取视图(点价格块 → answer → 模型调 travel.refresh/看趋势)。

## 数据模型(src/state/travel.ts)

```ts
interface TripStop { time?: string; name: string; note?: string }
interface TripDay  { title: string; stay?: string; cityChange?: boolean
                     stops: TripStop[]; trans?: string[] }  // trans[i] 是 stop i→i+1 的交通
TravelTask += { days?: TripDay[]; prep?: string[]; summary?: string }
TravelWatch += { stay?: { city: string; dayFrom: number; dayTo: number } }  // 分段住宿
```

分段住宿的判据是行程数据(每段一条 hotel watch,label/stay 标段),不是猜。

## 工具(加能力 = 加数据)

- **travel.plan(新,彩)**:模型查完攻略后把结构化日程交给系统——
  {destination, title?, days, prep?, summary?}。复用 create 的防重判据
  (同目的地+非归档 → 更新它的 days,否则建 draft 任务)。paintTrip 上屏。
  替代原来"card.show 建 guide 卡"的角色。
- travel.create:不变 + watch 项扩 `stay`;确认时按 days 的宿段建多条 hotel watch。
- travel.update:扩 `dayIdx`(锁定轮播到第几天;null 恢复自动轮播)——
  "看第三天"/"停在这页"的落点。加参数不加工具。

## 模板与形态

- cards.ts:`trip` 模板,**systemOnly**(由 travel.* 机制生成,模型不直接建),
  sizes ['hall','court','stage'],defaultSize 'court'。删 guide/itinerary。
- forms.ts tripForm(相邻档 blocks 不同,通用不变量测试盯着):
  - hall(36):['strip','prices','dayline'] — 窄色条,价格摘要行,单行轮播帧
  - court(48):['hero','prep','dayframe','prices','decide'] — 头图出血 + 完整单日时间轴
  - stage(64):['hero','prep','dayframe2','prices','decide'] — 双列时间轴
  阶段字段缺失就不画(条件块拼数组 .filter(Boolean).join,不在 flex 里留空白节点)。
- interactions:trip = 滑走/缩放/关闭 + tap:item→answer(点某天/点价格块 = 说话)。

## 轮播:纯 CSS,零状态零计时器

渲染器输出**全部 Day 帧**(绝对定位叠放)+ 指示器,`data-n` 标帧数;
screen.html 预置 trip2..trip7 六组 keyframes(opacity 轮转,每帧 8s),
指示点用同 duration/delay 的动画同步高亮。n=1 或 data.dayIdx 锁定时恒显单帧无动画。
选 CSS 不选 JS 计时器:screen 零业务逻辑,重渲染只是相位重置,可接受。

## 退役清单

guide/itinerary:模板定义、form、渲染分支、interactions、formread 夹具字段全删;
travelHandlers 的 paintPlan(itinerary)换成 paintTrip;skills/travel.ts 章法改
"web.search → travel.plan(结构化日程)";pilot real-travel 场景回归。
trend 模板与 paintTrend 保留(钻取视图)。

## 已知取舍

- 头图 v1 用渐变 + 目的地名(设计稿的城市剪影 SVG 不进代码——每城一张 SVG
  是内容不是机制);接 Pexels 真图列入待办。
- 攻略生成成本:days 结构比 7 条清单重,一轮 web.search + 一次 travel.plan
  仍是"就地办完"的量级;实测太慢再考虑骨架先出。
