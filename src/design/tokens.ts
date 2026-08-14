/**
 * Design Token —— **CSS 文本常量，不是外部样式表**。
 *
 * 这是硬约束不是风格选择：`build-single.mjs` 只替换 `<script type="module">` 标签，
 * 外部 `.css` 在单文件版会整个丢失。写成字符串才能被 esbuild 打进 iife，
 * 双击打开的那个版本照样带得走。
 *
 * 三层结构：
 *   BASE_CSS   排版 · 字阶 · 档位单位 · 圆角 · 动效曲线 —— 车机屏与控制面板共用
 *   LIGHT_CSS  车机屏的语义色（浅色）
 *   DARK_CSS   控制面板的语义色（深色）—— 两个使用场景，配色不该统一
 *
 * 取值来自视觉稿 `docs/superpowers/specs/assets/2026-08-12-hmi-mockup-v4.html` 的 :root。
 */

/** 档位 → 字号乘数。字号 = 字阶 × --u，"自适应尺寸"不再靠 CSS 逐档硬怼 */
export const TIER_UNITS: Record<string, number> = {
  chip: .86, strip: .92, tile: .92, bar: .96,
  // 乘数跟的是**可用宽度**不是面积：tower/frame 只有 797px 宽，
  // 字号照面积给会直接撑破换行
  box: 1, frame: 1.06, wide: 1.06, tower: 1.06,
  panel: 1.12, court: 1.12, band: 1.18, hall: 1.18,
  stage: 1.30, full: 1.45,
}

/** 形状 → 圆角。335×187 的 chip 配 32px 圆角会像药丸 */
const TIER_RADIUS: Record<string, string> = {
  chip: 'var(--r-s)', strip: 'var(--r-s)', tile: 'var(--r-s)', bar: 'var(--r-s)',
  box: 'var(--r-m)', frame: 'var(--r-m)', wide: 'var(--r-m)', panel: 'var(--r-m)', band: 'var(--r-m)',
  tower: 'var(--r-l)', hall: 'var(--r-l)', court: 'var(--r-l)',
  stage: 'var(--r-l)', full: 'var(--r-l)',
}

const tierRules = Object.keys(TIER_UNITS)
  .map(t => `.t-${t}{--u:${TIER_UNITS[t]};border-radius:${TIER_RADIUS[t]}}`)
  .join('\n')

/**
 * 基础层：排版与运动，两个场景共用。
 * 这里**不放任何颜色**——颜色在 LIGHT/DARK 里，换场景只换那一层。
 */
export const BASE_CSS = `
:root{
  /* 字阶 7 阶。--t-title 刻意小于 --t-body：标题让位，数值才是主角 */
  --t-cap:22px; --t-body:26px; --t-title:24px; --t-lead:38px;
  --t-num:52px; --t-hero:76px; --t-mega:100px;

  --r-s:20px; --r-m:26px; --r-l:32px; --r-blk:16px; --r-pill:999px;

  /* 车机 HMI 一律 ≤400ms。进场允许轻微过冲，其余纯 ease-out */
  --ez:cubic-bezier(.22,.61,.36,1);
  --ez-in:cubic-bezier(.4,0,1,1);
  --ez-pop:cubic-bezier(.34,1.26,.64,1);
  --d1:120ms; --d2:240ms; --d3:340ms; --d4:380ms;

  --u:1;
}
/* 字重收到 400/500/600/700 四档——300 在车机上远看发虚 */
body,.card{font-family:"PingFang SC","Noto Sans CJK SC",-apple-system,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased}
/* 所有数字容器都要等宽，否则 ETA 从 28 跳到 27 时会左右抖 */
.num,.clock,.batt,.gear,[data-num]{font-variant-numeric:tabular-nums}
${tierRules}
`.trim()

/** 车机屏：单一浅色主题，不做日夜切换 */
export const LIGHT_CSS = `
:root{
  --n0:#FFFFFF; --n1:#F6F8FB; --n2:#EEF2F7; --n3:#E2E8F0; --n4:#CBD5E1;
  --n5:#94A3B8; --n6:#64748B; --n7:#475569; --n8:#334155; --n9:#1E293B; --n10:#0F172A;

  --brand-fg:#1D4ED8; --brand-bg:#EFF6FF; --brand-bd:#BFDBFE; --brand-gr:linear-gradient(145deg,#3B82F6,#1D4ED8);
  --info-fg:#0E7490;  --info-bg:#ECFEFF;  --info-bd:#A5F3FC;  --info-gr:linear-gradient(145deg,#22B8CF,#0E7490);
  --ok-fg:#047857;    --ok-bg:#ECFDF5;    --ok-bd:#A7F3D0;    --ok-gr:linear-gradient(145deg,#10B981,#047857);
  --warn-fg:#B45309;  --warn-bg:#FFFBEB;  --warn-bd:#FDE68A;  --warn-gr:linear-gradient(145deg,#F59E0B,#B45309);
  --danger-fg:#B91C1C;--danger-bg:#FEF2F2;--danger-bd:#FECACA;--danger-gr:linear-gradient(145deg,#EF4444,#B91C1C);
  --media-fg:#6D28D9; --media-bg:#F5F3FF; --media-bd:#DDD6FE; --media-gr:linear-gradient(145deg,#8B5CF6,#6D28D9);
  --pick-fg:#4338CA;  --pick-bg:#EEF2FF;  --pick-bd:#C7D2FE;  --pick-gr:linear-gradient(145deg,#6366F1,#4338CA);
  --sys-fg:#475569;   --sys-bg:#F1F5F9;   --sys-bd:#CBD5E1;   --sys-gr:linear-gradient(145deg,#64748B,#475569);

  --sf-base:#E7ECF3; --sf-card:#FFFFFF; --sf-raised:#F6F8FB; --sf-sunken:#DCE3EC;
  --tx-1:#0F172A; --tx-2:#475569; --tx-3:#94A3B8; --tx-inv:#FFFFFF;
  --hair:rgba(15,23,42,.07); --hair-strong:rgba(15,23,42,.13);
  --sh-1:0 1px 2px rgba(15,23,42,.05), 0 6px 18px rgba(15,23,42,.055);
  --sh-2:0 2px 6px rgba(15,23,42,.06), 0 18px 44px rgba(15,23,42,.09);
  --gloss:inset 0 1px 0 rgba(255,255,255,.92);

  --ac:var(--brand-fg); --acbg:var(--brand-bg); --acbd:var(--brand-bd); --acgr:var(--brand-gr);
}
`.trim()

/** 控制面板：同一套排版，深色语义映射。它跟车机屏是两个使用场景 */
export const DARK_CSS = `
:root{
  --n0:#0B0F16; --n1:#0E141C; --n2:#131A25; --n3:#1B2432; --n4:#243044;
  --n5:#334155; --n6:#475569; --n7:#64748B; --n8:#94A3B8; --n9:#CBD5E1; --n10:#E2E8F0;

  --brand-fg:#60A5FA; --brand-bg:#12203A; --brand-bd:#1E3A6B; --brand-gr:linear-gradient(145deg,#3B82F6,#1D4ED8);
  --info-fg:#22D3EE;  --info-bg:#0C2A32;  --info-bd:#155E6B;  --info-gr:linear-gradient(145deg,#22B8CF,#0E7490);
  --ok-fg:#34D399;    --ok-bg:#0C2A22;    --ok-bd:#14543E;    --ok-gr:linear-gradient(145deg,#10B981,#047857);
  --warn-fg:#FBBF24;  --warn-bg:#2E2310;  --warn-bd:#66491A;  --warn-gr:linear-gradient(145deg,#F59E0B,#B45309);
  --danger-fg:#F87171;--danger-bg:#311414;--danger-bd:#7F2222;--danger-gr:linear-gradient(145deg,#EF4444,#B91C1C);
  --media-fg:#A78BFA; --media-bg:#241A45; --media-bd:#4C2E8F; --media-gr:linear-gradient(145deg,#8B5CF6,#6D28D9);
  --pick-fg:#818CF8;  --pick-bg:#1B1E45;  --pick-bd:#3730A3;  --pick-gr:linear-gradient(145deg,#6366F1,#4338CA);
  --sys-fg:#94A3B8;   --sys-bg:#161D2A;   --sys-bd:#2C3949;   --sys-gr:linear-gradient(145deg,#64748B,#475569);

  --sf-base:#0B0F16; --sf-card:#131A25; --sf-raised:#1B2432; --sf-sunken:#080C12;
  --tx-1:#E2E8F0; --tx-2:#94A3B8; --tx-3:#64748B; --tx-inv:#0F172A;
  --hair:rgba(226,232,240,.08); --hair-strong:rgba(226,232,240,.15);
  --sh-1:0 1px 2px rgba(0,0,0,.4), 0 6px 18px rgba(0,0,0,.3);
  --sh-2:0 2px 6px rgba(0,0,0,.45), 0 18px 44px rgba(0,0,0,.4);
  --gloss:inset 0 1px 0 rgba(255,255,255,.05);

  --ac:var(--brand-fg); --acbg:var(--brand-bg); --acbd:var(--brand-bd); --acgr:var(--brand-gr);
}
`.trim()

export type Scene = 'screen' | 'director'

/** 基础层 + 该场景的语义色。顺序不能反——后面的层要能覆盖前面的 */
export function tokensFor(scene: Scene): string {
  return `${BASE_CSS}\n${scene === 'screen' ? LIGHT_CSS : DARK_CSS}`
}

/**
 * 注入到文档。放在 <head> 最前面，让页面自己的 <style> 能覆盖 token
 * （token 是底座不是终判）。
 */
export function injectTokens(scene: Scene, doc: Document = document): HTMLStyleElement {
  const el = doc.createElement('style')
  el.dataset.tokens = scene
  el.textContent = tokensFor(scene)
  doc.head.insertBefore(el, doc.head.firstChild)
  return el
}
