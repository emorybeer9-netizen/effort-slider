// effort-slider — Hermes Desktop 桌面插件
// 把模型菜单里「推理强度」那一组单选档位，换成 Codex 风格的可拖动滑条。
//
// 真实 DOM（从构建产物核实，capabilities-CWUmCwqh.js）：
//   <Separator/>
//   <Label>{t.shell.modelOptions.effort}</Label>              ← 「推理强度」
//   <MenuRadioGroup value={effort} onValueChange={v => setOptions({effort: v})}>
//     <MenuRadioItem value="minimal">最小</MenuRadioItem>
//     … low / medium / high / xhigh / max / ultra
//   </MenuRadioGroup>
//
// 关键：Radix 的 MenuRadioGroup **不渲染 role="radiogroup"**，
//      每个 MenuRadioItem 才是 role="menuitemradio" + aria-checked。
//      所以判据必须是「相邻的一组 menuitemradio」，不能找 radiogroup。
//
// 提交方式：对目标 item 派发 click（Radix MenuRadioItem 的 onSelect 由 click 触发），
//          Hermes 的 effort 因而是真被写回，不是只改外观。

import { host, Button, PALETTE_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState } from 'react'

const ID = 'effort-slider'
const STYLE_ID = 'effort-slider-style'
const ROOT = 'es-root'
const ROUTE = '/effort-slider'

const DEFAULTS = {
  enabled: true,
  colorize: true,
  glow: true,
  snap: true,
  showDots: true,
  // 填充区里的星星粒子（从滑动头飘落到尾部）
  stars: true,
  // 拖动手感：'fast' (复刻 Codex) | 'clean' (简洁) | 'full' (最跟手)
  motion: 'fast'
}

// 快速/简洁 = 旋钮停在档位格上（视觉位置由弹簧追目标格）
// 完整 = 跟手连续位移，松手时弹簧回落到最近格（带一点回弹）
//
// hyst = 滞回死区半宽（单位：格）。
//   切换门槛 = 0.5 + hyst，回退门槛 = 0.5 + hyst
//   两边门槛相同 → 存在 2*hyst 的死区，指针停在死区里不会来回来回切。
//   hyst = 0 就等于纯中点吸附（会振荡），所以必须 > 0。
const MOTION = {
  // 快速：复刻 Codex —— 不跟手，停格吸附，回弹几乎不可见
  fast: {
    follow: false, k: 700, c: 52, m: 1, hyst: 0.17,
    press: 1.05, tick: 0.30, releaseOvershoot: 0
  },
  // 简洁：死区比快速窄一半（响应更快），回弹可见但克制
  clean: {
    follow: false, k: 820, c: 38, m: 1, hyst: 0.09,
    press: 1.09, tick: 1.05, releaseOvershoot: 0
  },
  // 完整：跟手，松手后带回弹落到最近格（不用滞回）
  full: {
    follow: true, k: 540, c: 36, m: 1, hyst: 0,
    press: 1.14, tick: 1.5, releaseOvershoot: 1
  }
}

let cfg = { ...DEFAULTS }
let mo = null
let raf = 0

// 档位顺序（按 Hermes 的七个中文档位）+ Codex 风格配色
// 中文 LEVELS 用于识别原生菜单项；显示层用 LEVEL_EN（Codex 风格英文）。
const LEVELS = ['最小', '低', '中', '高', '极高', '最高', '超高']
const LEVEL_EN = ['Minimal', 'Low', 'Medium', 'High', 'XHigh', 'Max', 'Ultra']
const HUES = {
  '最小': ['#64748b', '#94a3b8'],
  '低': ['#3b82f6', '#60a5fa'],
  '中': ['#6366f1', '#818cf8'],
  '高': ['#8b5cf6', '#a78bfa'],
  '极高': ['#a855f7', '#c084fc'],
  '最高': ['#d946ef', '#e879f9'],
  '超高': ['#f43f5e', '#fb7185']
}

function loadCfg(ctx) {
  const next = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS)) {
    try {
      const v = ctx.storage.get(k, DEFAULTS[k])
      if (typeof v === typeof DEFAULTS[k]) next[k] = v
    } catch (e) { /* 用默认值 */ }
  }
  cfg = next
}

function saveCfg(ctx) {
  for (const k of Object.keys(DEFAULTS)) {
    try { ctx.storage.set(k, cfg[k]) } catch (e) { /* 忽略 */ }
  }
}

function buildCss() {
  if (!cfg.enabled) return `/* effort-slider: off */`
  return `
/* 隐藏原生「推理强度」label —— 插件自绘思考等级 + 模型名 */
.es-native-label-hidden { display: none !important; }

/* ── effort-slider ──────────────────────────────────────────── */
.${ROOT} {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 6px 10px 9px;
  user-select: none;
  -webkit-user-select: none;
}
.${ROOT} .es-label {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  position: relative;
  font-size: 11px;
  letter-spacing: .05em;
  text-transform: uppercase;
  opacity: .78;
}
/* 当前思考等级（High / Max / Ultra…）—— 模型名上方，居中高亮 */
.${ROOT} .es-level {
  font-size: 14px !important;
  font-weight: 700 !important;
  letter-spacing: .06em !important;
  text-transform: none !important;
  text-align: center;
  opacity: 1;
  margin-bottom: 1px;
}
/* 模型名 —— 居中显示 */
.${ROOT} .es-model-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  position: relative;
  min-height: 15px;
}
.${ROOT} .es-label .es-model-name {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  max-width: 62%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-transform: none;
  letter-spacing: 0;
  font-weight: 600;
  font-size: 13px;
  opacity: 1;
}
.${ROOT} .es-value {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0;
  text-transform: none;
  font-variant-numeric: tabular-nums;
}

/* 轨道 */
.${ROOT} .es-track {
  position: relative;
  height: 24px;
  border-radius: 7px;
  cursor: pointer;
  overflow: hidden;
  background: color-mix(in oklab, currentColor 11%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, currentColor 15%, transparent);
  touch-action: none;
  outline: none;
}
.${ROOT} .es-track:focus-visible {
  box-shadow: inset 0 0 0 1px color-mix(in oklab, currentColor 15%, transparent),
              0 0 0 2px color-mix(in oklab, currentColor 30%, transparent);
}

.${ROOT} .es-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 7px 0 0 7px;
  overflow: hidden;
  /* 位置由 rAF 弹簧逐帧写入，这里只过渡颜色 */
  transition: background .2s;
  pointer-events: none;
  will-change: width;
}
.${ROOT} .es-knob {
  position: absolute;
  top: 50%;
  width: 24px;
  height: 24px;
  margin-left: -12px;
  border-radius: 50%;
  transform: translateY(-50%);
  background: #fff;
  box-shadow: 0 0 0 1px rgba(0,0,0,.30), 0 1px 4px rgba(0,0,0,.45), 0 0 10px rgba(255,255,255,.25);
  pointer-events: none;
  z-index: 3;
  /* 位置由弹簧写入；transform 变化（按下放大）走短过渡 */
  transition: transform .09s cubic-bezier(.3,.8,.4,1), box-shadow .12s;
  will-change: left, transform;
}
.${ROOT} .es-track:active .es-knob,
.${ROOT}[data-dragging="1"] .es-knob {
  box-shadow: 0 0 0 1px rgba(0,0,0,.32), 0 2px 7px rgba(0,0,0,.5), 0 0 10px rgba(255,255,255,.35);
}
/* 填充区内的星星：沿固定水平线从滑动头（右）飘到尾部（左），只旋转闪烁不换轨道 */
@keyframes es-star-fall {
  0%   { left: 100%; opacity: 0;   transform: scale(.3) rotate(0deg); }
  10%  { opacity: .95; }
  25%  { transform: scale(1) rotate(var(--r1, 70deg)); }
  45%  { transform: scale(.8) rotate(var(--r2, 150deg)); }
  65%  { transform: scale(1.1) rotate(var(--r3, 240deg)); }
  82%  { opacity: .8; }
  100% { left: -6%; opacity: 0;   transform: scale(.5) rotate(var(--r4, 330deg)); }
}
.${ROOT} .es-stars {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}
.${ROOT} .es-star {
  position: absolute;
  top: 50%;
  font-size: 7px;
  line-height: 1;
  transform-origin: center center;
  color: #fff;
  text-shadow: 0 0 5px rgba(255,255,255,.9), 0 0 9px rgba(255,255,255,.5);
  animation: es-star-fall calc(var(--dur, 2.2s) * var(--star-speed, 1)) linear infinite;
  animation-delay: var(--delay, 0s);
  will-change: transform, opacity;
}

.${ROOT} .es-dots { position: absolute; inset: 0; pointer-events: none; }
.${ROOT} .es-dot {
  position: absolute;
  top: 50%;
  width: 3px; height: 3px;
  margin-left: -1.5px;
  border-radius: 50%;
  transform: translateY(-50%);
  background: color-mix(in oklab, #fff 50%, transparent);
  transition: background .18s, box-shadow .18s, transform .18s;
}
.${ROOT} .es-dot[data-on="1"] {
  background: #fff;
  box-shadow: 0 0 5px rgba(255,255,255,.85);
  transform: translateY(-50%) scale(1.3);
}

/* 最高档星云 */
@keyframes es-nebula { 0% { background-position: 0% 50%; } 100% { background-position: 200% 50%; } }
@keyframes es-sweep  { 0% { transform: translateX(-120%); } 100% { transform: translateX(340%); } }

.${ROOT} .es-fill[data-max="1"] {
  background-image: linear-gradient(92deg,#6366f1 0%,#a855f7 26%,#e879f9 50%,#a855f7 74%,#6366f1 100%) !important;
  background-size: 200% 100%;
  animation: es-nebula 3.4s linear infinite;
}
.${ROOT} .es-track[data-max="1"] {
  box-shadow: inset 0 0 0 1px rgba(168,85,247,.6), 0 0 12px rgba(168,85,247,.38);
}
/* Ultra 档轨道右端收成半圆（半径=滑动头半径），滑动头彻底盖住末端不漏边 */
.${ROOT} .es-track[data-ultra="1"] {
  border-radius: 7px 12px 12px 7px;
}
.${ROOT} .es-glow {
  position: absolute; inset: 0;
  pointer-events: none; overflow: hidden; border-radius: 7px;
}
.${ROOT} .es-glow::after {
  content: '';
  position: absolute; top: 0; bottom: 0; width: 28%;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,.55), transparent);
  animation: es-sweep 2.6s cubic-bezier(.4,.1,.6,.9) infinite;
}

/* 原生那组被换成滑条后隐藏（用 class，不写内联 style，便于还原） */
.es-hidden { display: none !important; }

@media (prefers-reduced-motion: reduce) {
  .${ROOT} .es-fill, .${ROOT} .es-knob { transition: none; }
  .${ROOT} .es-fill[data-max="1"], .${ROOT} .es-glow::after { animation: none; }
}
`
}

function injectStyle() {
  let el = document.getElementById(STYLE_ID)
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = buildCss()
}

function removeStyle() {
  const el = document.getElementById(STYLE_ID)
  if (el) el.remove()
}

// ── 定位档位组 ────────────────────────────────────────────────

// 收集档位组：优先认 data-slot="dropdown-menu-radio-group"（Hermes 真实结构）
function findGroups() {
  const out = []
  const seen = new Set()

  // ① 官方 RadioGroup 容器（Hermes 用的就是这条路）
  document.querySelectorAll('[data-slot="dropdown-menu-radio-group"], [role="group"][data-slot*="radio"]').forEach(g => {
    const items = Array.from(g.querySelectorAll('[role="menuitemradio"]'))
    if (items.length >= 2) {
      out.push({ parent: g, items })
      seen.add(g)
    }
  })

  // ② 兜底：同一父节点下连续的 menuitemradio
  const all = Array.from(document.querySelectorAll('[role="menuitemradio"]'))
  const byParent = new Map()
  for (const el of all) {
    const p = el.parentElement
    if (!p || seen.has(p)) continue
    if (!byParent.has(p)) byParent.set(p, [])
    byParent.get(p).push(el)
  }
  for (const [parent, items] of byParent) {
    if (items.length >= 2) out.push({ parent, items })
  }
  return out
}

/**
 * 当前模型的显示名。host.state.model 是 slug（hy4flash-free）；
 * 也尝试从菜单里的模型名反查，优先用真实显示名，退而求其次才 slug 转写。
 */
function currentModelName() {
  let slug = ''
  try { slug = String(host?.state?.model?.get?.() || '').trim() } catch (e) { /* 忽略 */ }
  if (!slug) return ''
  return slug
    .replace(/^[^:]+:/, '')      // 去 provider 前缀
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())  // hy4flash → Hy4flash
    .trim()
}

function valOf(item) {
  // Hermes 的 radio item 不带 value，用文字归一
  const t = (item.textContent || '').replace(/\s*[（(].*?[）)]\s*$/, '').trim()
  return t
}

function isChecked(item) {
  const a = item.getAttribute('aria-checked')
  return a === 'true' || item.getAttribute('data-state') === 'checked'
}

function labelOf(item) {
  // 去掉 "(→Medium)" 这类路由后缀
  return (item.textContent || '').replace(/\s*[（(][^）)]*[）)]\s*$/, '').trim()
}

// 提交：只派发 click。
// 不派发 mousedown/mouseup/pointerdown —— 它们会冒泡到外层容器，
// 触发标签栏的右键菜单（"重新加载 / 关闭 / 显示标签"）这类原生上下文菜单。
function commit(item) {
  if (!item) return
  try {
    // 用 item 所属文档的构造器，避免依赖全局（jsdom / 隔离环境里全局可能没有 MouseEvent）
    const win = (item.ownerDocument && item.ownerDocument.defaultView) || window
    const ME = (win && win.MouseEvent) || MouseEvent
    item.dispatchEvent(new ME('click', { bubbles: true, cancelable: true, view: win }))
  } catch (e) {
    try { item.click() } catch (e2) { /* 放弃 */ }
  }
}

function buildSlider(items) {
  const wrap = document.createElement('div')
  wrap.className = ROOT
  wrap.setAttribute('data-es', '1')

  const label = document.createElement('div')
  label.className = 'es-label'
  // 当前思考等级（Minimal / High / Max / Ultra…）放在模型名上方
  const vSpan = document.createElement('span')
  vSpan.className = 'es-value es-level'
  // 模型名行（居中）
  const row = document.createElement('div')
  row.className = 'es-model-row'
  const lSpan = document.createElement('span')
  lSpan.className = 'es-model-name'
  lSpan.textContent = currentModelName() || 'Model'
  lSpan.setAttribute('data-es-model-name', '1')
  row.append(lSpan)
  label.append(vSpan, row)

  const track = document.createElement('div')
  track.className = 'es-track'
  track.setAttribute('role', 'slider')
  track.setAttribute('aria-label', 'Reasoning effort')
  track.tabIndex = 0

  const fill = document.createElement('div')
  fill.className = 'es-fill'
  let starsEl = null
  if (cfg.stars) {
    const stars = document.createElement('div')
    stars.className = 'es-stars'
    starsEl = stars
    // 星星从滑动头（fill 右端）向左飘；数量每次随机（5~7 颗，不过多不过少）
    // 纵向铺满上/中/下；只随机旋转角度，飘动时沿固定水平轨道。
    const pool = ['✦', '✧', '★']
    const count = 5 + Math.floor(Math.random() * 3)   // 5~7，期望 6，不过多不过少
    const bands = [12, 50, 86, 30, 70, 44, 76]        // 前三颗锁定上/中/下
    for (let i = 0; i < count; i++) {
      const s = document.createElement('span')
      s.className = 'es-star'
      s.textContent = pool[i % pool.length]
      s.style.setProperty('--dur', `${(1.8 + Math.random() * 1.1).toFixed(2)}s`)
      s.style.setProperty('--delay', `${(-Math.random() * 2.4).toFixed(2)}s`)
      s.style.top = `${bands[i] + (Math.random() * 10 - 5)}%`
      s.style.fontSize = `${6 + Math.floor(Math.random() * 3)}px`
      const rnd = (a, b) => `${(Math.random() * (b - a) + a).toFixed(0)}`
      for (let k = 1; k <= 4; k++) {
        s.style.setProperty(`--r${k}`, `${rnd(40 * k - 30, 40 * k + 30)}deg`)
      }
      stars.appendChild(s)
    }
    fill.appendChild(stars)
  }
  const dots = document.createElement('div')
  dots.className = 'es-dots'
  const glow = document.createElement('div')
  glow.className = 'es-glow'
  const knob = document.createElement('div')
  knob.className = 'es-knob'

  track.appendChild(fill)
  if (cfg.showDots) track.appendChild(dots)
  if (cfg.glow) track.appendChild(glow)
  track.appendChild(knob)

  wrap.append(label, track)

  const n = items.length
  const stepPct = n > 1 ? 100 / (n - 1) : 0
  // 初始档位：优先读 checked；没有选中（如「思考」关闭时）就落在中间档显示
  let initIdx = items.findIndex(isChecked)
  if (initIdx < 0) initIdx = Math.min(n - 1, Math.floor((n - 1) / 2))
  let idx = initIdx

  if (cfg.showDots) {
    for (let i = 0; i < n; i++) {
      const d = document.createElement('span')
      d.className = 'es-dot'
      d.style.left = `${i * stepPct}%`
      dots.appendChild(d)
    }
  }

  // 圆心内缩一个半径，保证两端档位（尤其 Ultra 最高档）圆形完整不被裁切
  const knobLeft = (pct) => `calc(12px + (100% - 24px) * ${(pct / 100).toFixed(4)})`

  const paint = (i) => {
    i = Math.max(0, Math.min(n - 1, i))
    idx = i
    const pct = i * stepPct
    fill.style.width = `${pct}%`
    knob.style.left = knobLeft(pct)
    // 星星速度与频率绑定思考等级：等级越高倍率越小 → 周期越短 → 飘得越快、出现越频繁
    if (starsEl) {
      const speed = n > 1 ? 1.25 - (i / (n - 1)) * 0.85 : 1   // 1.25(最低档) → 0.40(最高档)，整体更快
      starsEl.style.setProperty('--star-speed', speed.toFixed(2))
    }
    const key = valOf(items[i])
    // 档位显示英文；中文 LEVELS 只用于识别原生菜单项，两者分离
    const li = LEVELS.indexOf(key)
    const txt = li >= 0 ? LEVEL_EN[li] : (labelOf(items[i]) || key)
    vSpan.textContent = txt
    if (cfg.colorize) {
      const h = HUES[key] || HUES.high
      fill.style.background = `linear-gradient(90deg, ${h[0]}, ${h[1]})`
      vSpan.style.color = h[1]
    } else {
      fill.style.background = ''
      vSpan.style.color = ''
    }
    const isMax = i === n - 1
    fill.setAttribute('data-max', isMax && cfg.glow ? '1' : '0')
    track.setAttribute('data-max', isMax && cfg.glow ? '1' : '0')
    track.setAttribute('data-ultra', isMax ? '1' : '0')
    if (cfg.showDots) {
      Array.from(dots.children).forEach((d, k) => d.setAttribute('data-on', k <= i ? '1' : '0'))
    }
    track.setAttribute('aria-valuemin', '0')
    track.setAttribute('aria-valuemax', String(n - 1))
    track.setAttribute('aria-valuenow', String(i))
    track.setAttribute('aria-valuetext', txt)
  }

  paint(idx)

  // ── 弹簧驱动 ───────────────────────────────────────────────
  // springPos / springVel 是"视觉位置"（浮点档位单位）
  let springPos = idx
  let springVel = 0
  let springRaf = 0
  let springLast = 0
  let targetPos = idx        // 弹簧要追的目标位置
  let dragging = false
  let lastCommitted = -1      // 上次提交过的档位，防重复派发

  const applyVisual = (p) => {
    const pct = Math.max(0, Math.min(100, (p / Math.max(1, n - 1)) * 100))
    fill.style.width = `${pct}%`
    knob.style.left = knobLeft(pct)
  }

  const currentMotion = () => MOTION[cfg.motion] || MOTION.fast

  const springStep = (now) => {
    const m = currentMotion()
    const dt = Math.min(0.032, (now - springLast) / 1000 || 0.016)
    springLast = now
    // F = -k(x - target) - c*v
    const accel = (-m.k * (springPos - targetPos) - m.c * springVel) / m.m
    springVel += accel * dt
    springPos += springVel * dt
    applyVisual(springPos)
    // 收敛
    if (Math.abs(springPos - targetPos) < 0.008 && Math.abs(springVel) < 0.12) {
      springPos = targetPos
      springVel = 0
      applyVisual(springPos)
      springRaf = 0
      return
    }
    springRaf = requestAnimationFrame(springStep)
  }

  const runSpring = () => {
    const m = currentMotion()
    if (springRaf) return
    springLast = performance.now()
    // 触发这次动画时，给一点起始速度，让"快速"也有细微弹性
    springRaf = requestAnimationFrame(springStep)
    // 用 m 里的参数（currentMotion 每帧重新读，切模式即时生效）
  }

  const stopSpring = () => {
    if (springRaf) cancelAnimationFrame(springRaf)
    springRaf = 0
    springVel = 0
  }

  // 指针位置 → 浮点档位
  const ratioAt = (clientX) => {
    const rect = track.getBoundingClientRect()
    if (!rect.width) return 0
    let r = (clientX - rect.left) / rect.width
    return Math.max(0, Math.min(1, r)) * (n - 1)
  }

  // 只更新档位元信息（文字/颜色/点），不动位置——位置交给弹簧
  const paintMeta = (i) => {
    if (starsEl) {
      const speed = n > 1 ? 1.25 - (i / (n - 1)) * 0.85 : 1
      starsEl.style.setProperty('--star-speed', speed.toFixed(2))
    }
    const key = valOf(items[i])
    // 档位显示英文；中文 LEVELS 只用于识别原生菜单项，两者分离
    const li = LEVELS.indexOf(key)
    const txt = li >= 0 ? LEVEL_EN[li] : (labelOf(items[i]) || key)
    vSpan.textContent = txt
    if (cfg.colorize) {
      const h = HUES[key] || HUES.high
      fill.style.background = `linear-gradient(90deg, ${h[0]}, ${h[1]})`
      vSpan.style.color = h[1]
    } else {
      fill.style.background = ''
      vSpan.style.color = ''
    }
    const isMax = i === n - 1
    fill.setAttribute('data-max', isMax && cfg.glow ? '1' : '0')
    track.setAttribute('data-max', isMax && cfg.glow ? '1' : '0')
    track.setAttribute('data-ultra', isMax ? '1' : '0')
    if (cfg.showDots) {
      Array.from(dots.children).forEach((d, k) => d.setAttribute('data-on', k <= i ? '1' : '0'))
    }
    track.setAttribute('aria-valuenow', String(i))
    track.setAttribute('aria-valuetext', txt)
  }

  // 拖动/点击时只更新视觉与 idx，绝不派发 click。
  // 提交统一由 pointerup 完成 —— 每次 click 都让 Hermes 重渲染模型按钮
  // （删掉再插入档位文字 span），那一拍空档就是白条。
  const seek = (clientX) => {
    const m = currentMotion()
    const pos = ratioAt(clientX)      // 浮点档位 0..n-1

    if (m.follow) {
      // 完整模式：视觉完全跟手
      springPos = pos
      springVel = 0
      applyVisual(pos)
      const i = Math.round(pos)
      if (i !== idx) {
        idx = i
        paintMeta(i)
      }
      return
    }

    // ── 快速 / 简洁：对称门槛 + 死区（关键：两边门槛相同才有死区）
    //
    // 当前在 idx 格。定义了死区 [idx-δ, idx+δ]，δ = 0.5 + hyst。
    //   指针 > idx + δ  → 前进到最近的整格（至少 idx+1）
    //   指针 < idx - δ  → 后退到最近的整格（至多 idx-1）
    //   落在 [idx-δ, idx+δ] → 不动
    //
    // 因为两个方向用的是同一个 δ，死区宽度恒为 2δ ≥ 1 格，
    // 指针停在中间任何位置都不会来回切。
    const delta = 0.5 + (Number(m.hyst) || 0)
    let target = idx

    if (pos > idx + delta) {
      // 前进：取指针所在整格，但不小于 idx+1
      target = Math.max(idx + 1, Math.floor(pos))
    } else if (pos < idx - delta) {
      // 后退：取指针所在整格，但不超过 idx-1
      target = Math.min(idx - 1, Math.ceil(pos))
    }
    target = Math.max(0, Math.min(n - 1, target))
    // pos 在死区内 → target 仍是 idx → 不切
    if (target !== idx) {
      const prevIdx = idx
      idx = target
      paintMeta(target)
      // 目标格变了 → 弹簧带初始速度，做出"弹一下"
      targetPos = target
      const dir = target > prevIdx ? 1 : -1
      springVel = dir * (0.6 + m.tick * 1.2)
      runSpring()
    }
  }



  // 轨道吞掉所有指针事件，不让它冒泡到菜单/标签栏
  const swallow = (e) => {
    e.stopPropagation()
    if (e.cancelable) e.preventDefault()
  }

  track.addEventListener('pointerdown', (e) => {
    dragging = true
    stopSpring()
    wrap.setAttribute('data-dragging', '1')
    try { track.setPointerCapture(e.pointerId) } catch (err) { /* 忽略 */ }
    swallow(e)
    // 拖动时保持圆形原尺寸，不做放大
    knob.style.transform = 'translateY(-50%)'
    // 单击也走 pointerup 统一提交，这里不派发
    seek(e.clientX)
  })

  track.addEventListener('pointermove', (e) => {
    if (!dragging) return
    swallow(e)
    // 拖动过程中只走视觉 + 记录待提交档位，不派发 click。
    // 每次 click 都会让 Hermes 重渲染模型按钮（删掉再插入档位文字 span），
    // 那一拍空档就是用户看到的白条。提交统一放在 pointerup。
    seek(e.clientX)
  })

  const release = (e) => {
    if (!dragging) return
    dragging = false
    wrap.removeAttribute('data-dragging')
    try { track.releasePointerCapture(e.pointerId) } catch (err) { /* 忽略 */ }
    swallow(e)
    // 恢复旋钮尺寸
    knob.style.transform = 'translateY(-50%)'
    const m = currentMotion()

    // 拖动期间没派发过 click，这里一次性提交最终档位。
    // 判据是「原生项当前是否已经是这一档」：没变就不提交，避免无谓重渲染。
    if (!isChecked(items[idx])) {
      commit(items[idx])
      lastCommitted = idx
    }

    if (m.follow) {
      // 完整模式：松手回弹到最近格
      targetPos = Math.round(springPos)
      springVel = 0
      if (m.releaseOvershoot) {
        // 朝目标反方向给一点速度 → 过冲后再回来
        springVel = (targetPos >= springPos ? 1 : -1) * 3.2
      }
      runSpring()
    } else {
      // 快速/简洁：确保落在目标格
      targetPos = idx
      if (Math.abs(springPos - targetPos) > 0.01) runSpring()
    }
  }
  track.addEventListener('pointerup', release)
  track.addEventListener('pointercancel', release)
  // 阻止点击/右键/长按冒泡到外层容器
  track.addEventListener('click', e => { e.stopPropagation() })
  track.addEventListener('mousedown', e => { e.stopPropagation() })
  track.addEventListener('mouseup', e => { e.stopPropagation() })
  track.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation() })
  track.addEventListener('dragstart', e => e.preventDefault())

  track.addEventListener('keydown', (e) => {
    let ni = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') ni = Math.min(n - 1, idx + 1)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') ni = Math.max(0, idx - 1)
    else if (e.key === 'Home') ni = 0
    else if (e.key === 'End') ni = n - 1
    if (ni === null) return
    e.preventDefault()
    e.stopPropagation()
    if (ni !== idx) {
      const prevIdx = idx
      idx = ni
      paintMeta(ni)
      commit(items[ni])
      lastCommitted = ni
      // 键盘也走弹簧，带同样的弹性
      const m = currentMotion()
      targetPos = ni
      springVel += (ni > prevIdx ? 1 : -1) * (m.tick * 6)
      runSpring()
    }
  })

  // 外部变化（键盘操作原生菜单、切模型）时同步
  const sync = () => {
    const i = items.findIndex(isChecked)
    if (i < 0 || i === idx) return
    // 外部改动优先：停掉正在跑的弹簧，把视觉位置直接对齐
    stopSpring()
    springPos = i
    springVel = 0
    targetPos = i
    paint(i)
    lastCommitted = i
  }
  try {
    const obs = new MutationObserver(sync)
    items.forEach(it => obs.observe(it, { attributes: true, attributeFilter: ['aria-checked', 'data-state'] }))
    wrap.__esObs = obs
  } catch (e) { /* 忽略 */ }

  return wrap
}

// 隐藏原生「推理强度」label（插件自绘思考等级 + 模型名替代它）
function hideNativeLabel(parent) {
  const host = parent?.parentElement
  if (!host) return
  for (const el of Array.from(host.querySelectorAll('*'))) {
    if (el.querySelector('[role="menuitemradio"]')) continue
    const t = (el.textContent || '').trim()
    if (t === '推理强度' && el.children.length === 0) {
      el.classList.add('es-native-label-hidden')
      return
    }
  }
}

function enhance() {
  if (!cfg.enabled) return
  for (const { parent, items } of findGroups()) {
    // 已处理过
    if (parent.dataset.esDone === '1') continue
    // 只对真正的推理强度组生效：项里至少两个能对上中文档位
    const hits = items.filter(it => LEVELS.includes(valOf(it))).length
    if (hits < 2) continue

    const slider = buildSlider(items)
    parent.dataset.esDone = '1'
    hideNativeLabel(parent)
    // 只隐藏 item，容器本身不参与布局（否则它的 padding 会留下一条白边）
    items.forEach(it => it.classList.add('es-hidden'))
    // 插在 group 前面当兄弟，不塞进 group 内部
    parent.parentElement?.insertBefore(slider, parent)
    // group 已无可见子元素 → 收成 0 高，去掉 padding/margin
    parent.style.setProperty('display', 'none', 'important')
  }
}

function restore() {
  document.querySelectorAll(`.${ROOT}[data-es="1"]`).forEach(n => {
    try { n.__esObs?.disconnect() } catch (e) { /* 忽略 */ }
    n.remove()
  })
  document.querySelectorAll('[data-es-done="1"]').forEach(n => {
    delete n.dataset.esDone
    n.style.removeProperty('display')
  })
  document.querySelectorAll('.es-hidden').forEach(n => n.classList.remove('es-hidden'))
  document.querySelectorAll('.es-native-label-hidden').forEach(n => n.classList.remove('es-native-label-hidden'))
}

function scheduleEnhance() {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    try { enhance() } catch (e) { /* 忽略 */ }
  })
}

// ── 抑制原生「X 将从你的下一条消息开始生效」提示 ──────────────
// 触发点：config.set 返回 status='deferred' 时，Hermes 调 Fs({kind:'info', ...})
// 渲染成顶部 toast。这里在 DOM 层把它摘掉，属于纯外观处理。
const TOAST_RE = /将从你的下一条消息开始生效|applies from your next message|は次のメッセージから適用/
let toastObs = null
let toastHandler = null

function startToastGuard() {
  if (toastObs) return
  const kill = () => {
    try {
      const nodes = document.querySelectorAll('[role="status"], [data-sonner-toast], [data-slot*="toast"], li[data-sonner-toast], [aria-live]')
      nodes.forEach(n => {
        const t = n.textContent || ''
        if (!TOAST_RE.test(t)) return
        // 向上找到这条 toast 的卡片根：class 带 toast，或本身就是 li/固定定位块
        let box = n
        let guard = 0
        while (box.parentElement && guard < 8) {
          const p = box.parentElement
          const cls = String(p.className || '')
          const tagged = /toast|notification|banner/i.test(cls) || p.hasAttribute('data-sonner-toaster')
          if (!tagged) break
          box = p
          guard++
        }
        // 记录形状，便于确认
        try {
          window.__esLastToast = (box.outerHTML || '').slice(0, 600)
        } catch (e) { /* 忽略 */ }
        // 整个移除，不留占位（display:none 会留下外层容器的边框）
        box.remove()
      })
      // 清掉可能残留的空 toast 容器（已无子元素但仍占位）
      document.querySelectorAll('[data-sonner-toaster], [class*="toaster"]').forEach(v => {
        if (!v.children.length) v.remove()
      })
    } catch (e) { /* 忽略 */ }
  }
  toastObs = new MutationObserver(kill)
  toastObs.observe(document.body, { childList: true, subtree: true, characterData: true })
  kill()
}

function stopToastGuard() {
  if (toastObs) { toastObs.disconnect(); toastObs = null }
  document.querySelectorAll('[data-es-muted="1"]').forEach(n => {
    n.style.display = ''
    n.removeAttribute('data-es-muted')
  })
}

function Settings({ ctx, close }) {
  const [, force] = useState(0)
  const rerender = () => { saveCfg(ctx); injectStyle(); force(x => x + 1) }

  const row = (label, hint) => jsx('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '2px' },
    children: [
      jsx('div', { style: { fontSize: '13px' }, children: label }),
      hint ? jsx('div', { style: { fontSize: '11px', opacity: 0.6 }, children: hint }) : null
    ]
  })

  const toggle = (key) => jsx('input', {
    type: 'checkbox',
    checked: !!cfg[key],
    onChange: (e) => {
      cfg[key] = e.target.checked
      saveCfg(ctx)
      if (key === 'enabled') {
        if (cfg.enabled) { injectStyle(); enhance() }
        else { removeStyle(); restore() }
      } else {
        injectStyle()
        restore()
      }
      force(x => x + 1)
    }
  })

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '15px', padding: '4px' },
    children: [
      jsx('div', { style: { fontSize: '15px', fontWeight: 600 }, children: 'Hermes滑动推理' }),
      jsx('div', {
        style: { fontSize: '12px', opacity: 0.65, lineHeight: 1.5 },
        children: '点开输入框里那个 Off / MED 的档案，推理强度那一组会变成一条可拖动的滑条：上方是当前思考等级（Minimal→Ultra），中间是当前模型名，拖动即提交。'
      }),

      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' },
        children: [toggle('enabled'), row('总开关', '关闭后还原原生列表')] }),
      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' },
        children: [toggle('colorize'), row('一档一色', '低档冷蓝，越右越紫')] }),
      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' },
        children: [toggle('glow'), row('最高档星云', '流光 + 扫光 + 外发光')] }),
      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' },
        children: [toggle('showDots'), row('刻度点', '已到达的点亮白')] }),
      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' },
        children: [toggle('stars'), row('星星飘落', '填充区内从滑动头飘向尾部')] }),

      // ── 拖动手感 ──
      jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '2px' },
        children: [
          row('拖动手感', '三种都不受系统「减少动态效果」影响'),
          jsx('div', {
            style: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
            children: [
              ['fast', '快速', '复刻 Codex：不跟手，停格吸附'],
              ['clean', '简洁', '干脆，吸附更快'],
              ['full', '完整', '最跟手，连续位移']
            ].map(([val, label, hint]) => jsxs('button', {
              onClick: () => {
                cfg.motion = val
                saveCfg(ctx)
                restore()
                injectStyle()
                enhance()
                force(x => x + 1)
              },
              title: hint,
              style: {
                display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
                gap: '1px', padding: '6px 11px', borderRadius: '8px', cursor: 'pointer',
                border: cfg.motion === val ? '1px solid var(--accent)' : '1px solid var(--border)',
                background: cfg.motion === val ? 'var(--accent)' : 'transparent',
                color: cfg.motion === val ? 'var(--foreground)' : 'var(--muted-foreground)'
              },
              children: [
                jsx('span', { style: { fontSize: '12px', fontWeight: 600 }, children: label }),
                jsx('span', { style: { fontSize: '10px', opacity: 0.65 }, children: hint })
              ]
            }, val))
          })
        ]
      }),

      jsx(Button, {
        onClick: () => { cfg = { ...DEFAULTS }; saveCfg(ctx); injectStyle(); restore(); enhance(); force(x => x + 1) },
        variant: 'outline', size: 'sm', children: '恢复默认'
      })
    ]
  })
}

export default {
  id: ID,
  name: 'Hermes滑动推理',
  description: '把模型菜单的「推理强度」换成可拖动的滑条：七档一色、弹簧手感、键盘可达。',
  register(ctx) {
    loadCfg(ctx)
    injectStyle()

    try {
      mo = new MutationObserver(() => scheduleEnhance())
      mo.observe(document.body, { childList: true, subtree: true })
      scheduleEnhance()
    } catch (e) { /* 静默 */ }

    // 静音那条原生「将从你的下一条消息开始生效」toast
    try { startToastGuard() } catch (e) { /* 忽略 */ }

    // 切模型只改 atom 未必动 DOM，低频兜底刷新滑条居中的模型名
    const labelTimer = setInterval(() => {
      try {
        const name = currentModelName()
        if (!name) return
        document.querySelectorAll(`.${ROOT} [data-es-model-name="1"]`).forEach(n => {
          if (n.textContent !== name) n.textContent = name
        })
      } catch (e) { /* 忽略 */ }
    }, 2000)

    ctx.register({
      id: 'page',
      area: ROUTES_AREA,
      title: 'Hermes滑动推理',
      data: { path: ROUTE },
      render: () => jsx(Settings, { ctx })
    })

    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      order: 43,
      data: { path: ROUTE, label: 'Hermes滑动推理', codicon: 'settings-gear' }
    })

    ctx.register({
      id: 'cmd',
      area: PALETTE_AREA,
      data: {
        label: 'Hermes滑动推理设置',
        keywords: [ID, 'effort', 'slider', 'reasoning', '推理', '强度', '滑条'],
        run: () => host.navigate(ROUTE)
      }
    })

    ctx.onDispose(() => {
      if (mo) mo.disconnect()
      if (raf) cancelAnimationFrame(raf)
      clearInterval(labelTimer)
      try { stopToastGuard() } catch (e) { /* 忽略 */ }
      restore()
      removeStyle()
    })
  }
}
