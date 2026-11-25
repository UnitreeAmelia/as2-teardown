/* ══════════════════════════════════════════════════════
   main.js — 界面与交互
   ──────────────────────────────────────────────────────
   三种模式：
   爆炸视图  用滑块看装配层级
   拆装实训  按工艺顺序拆；点错零件会说明错在哪
   自由探索  随便点，看零件档案
   ══════════════════════════════════════════════════════ */

import {
  buildParts, buildSequence, LEGS, INSIGHTS, SOURCE_NOTE, MASS,
} from './data.js';
import { Viewer } from './viewer.js';
import { Annotator } from './annotate.js';

const LEG_MASS = MASS.hip + MASS.thigh + MASS.calf + MASS.foot;
const TOTAL_MASS = MASS.base + LEG_MASS * 4;

const parts = buildParts();
const steps = buildSequence();
const byId = new Map(parts.map((p) => [p.id, p]));
const stepOfPart = new Map(steps.map((s, i) => [s.part, i]));

const $ = (id) => document.getElementById(id);
const canvas = $('stage');

const state = {
  mode: 'explode',
  selected: null,
  hovered: null,
  removed: new Set(),     // 已拆下的零件 id
  stepIndex: 0,           // 已完成的步数
  demo: null,
};

const viewer = new Viewer(canvas, parts);
const annotator = new Annotator(viewer, $('anno'));

/* ── 载入 ───────────────────────────────────────────── */
let loaded = false;
viewer.load((p, name) => {
  $('loading-fill').style.width = `${Math.round(p * 100)}%`;
  $('loading-text').textContent = p < 1 ? `正在载入 ${name} …` : '正在装配…';
}).then(() => {
  loaded = true;
  $('loading').classList.add('is-gone');
  renderTree();
  renderInspector();
  renderDock();
  viewer.start();
  applyQuery();
}).catch((err) => {
  console.error(err);
  $('loading-text').textContent = '模型载入失败：' + err.message;
});

/* ── 装配树 ─────────────────────────────────────────── */
function renderTree() {
  const el = $('tree');
  const base = byId.get('base');
  let html = `
    <button class="tree-row lvl1" data-id="base">
      <span class="tr-dot"></span>
      <span class="tr-name">机身总成</span>
      <span class="tr-mass">${base.mass.toFixed(2)}</span>
    </button>`;

  for (const leg of LEGS) {
    html += `<div class="tree-leg-head"><b>${leg.cn}腿</b><em>${LEG_MASS.toFixed(3)} kg</em></div>`;
    for (const t of ['hip', 'thigh', 'calf', 'foot']) {
      const p = byId.get(`${leg.key}_${t}`);
      html += `
        <button class="tree-row" data-id="${p.id}">
          <span class="tr-dot"></span>
          <span class="tr-name">${p.short}</span>
          <span class="tr-mass">${p.mass < 0.1 ? p.mass.toFixed(3) : p.mass.toFixed(2)}</span>
        </button>`;
    }
  }
  el.innerHTML = html;

  el.querySelectorAll('.tree-row').forEach((btn) => {
    const id = btn.dataset.id;
    btn.addEventListener('click', () => onPartChosen(id, 'tree'));
    btn.addEventListener('pointerenter', () => {
      viewer.hover(id);
      btn.classList.add('is-hov');
    });
    btn.addEventListener('pointerleave', () => {
      viewer.hover(null);
      btn.classList.remove('is-hov');
    });
  });

  syncTree();
}

function syncTree() {
  for (const btn of $('tree').querySelectorAll('.tree-row')) {
    const id = btn.dataset.id;
    btn.classList.toggle('is-sel', id === state.selected);
    btn.classList.toggle('is-out', state.removed.has(id));
  }
  $('tree-meta').textContent = `${parts.length - state.removed.size} / ${parts.length} 件`;
}

/* ── 档案面板 ───────────────────────────────────────── */
function renderInspector() {
  const el = $('inspector');
  if (!state.selected) {
    el.innerHTML = overviewHTML();
    return;
  }
  const p = byId.get(state.selected);
  const legShare = p.leg ? (p.mass / LEG_MASS) * 100 : null;
  const totalShare = (p.mass / TOTAL_MASS) * 100;

  const facts = (p.facts || [])
    .map(([k, v]) => `<div class="fact"><dt>${k}</dt><dd>${v}</dd></div>`)
    .join('');

  el.innerHTML = `
    <div class="ins-code">${p.code}</div>
    <h2 class="ins-title">${p.name}</h2>
    <p class="ins-sub">${p.leg ? LEGS.find((l) => l.key === p.leg).cn + '腿' : '整机装配基准'}${p.joint ? ' · ' + p.joint.label : ''}</p>

    <div class="ins-mass">
      <b>${p.mass.toFixed(p.mass < 0.1 ? 3 : 4)}</b><span>kg</span>
      <em>${legShare !== null ? `占单腿 ${legShare.toFixed(1)}%<br>` : ''}占整机 ${totalShare.toFixed(1)}%<br>取自官方 MJCF</em>
    </div>

    ${facts ? `<dl class="facts">${facts}</dl>` : ''}

    <div class="sec">
      <h3>功能</h3>
      <p>${p.duty}</p>
    </div>

    <div class="sec">
      <h3>结构连接</h3>
      <p>${p.conn}</p>
    </div>

    <div class="sec">
      <h3>拆卸要点 <span class="tag infer">工艺推断</span></h3>
      <p>${p.removal}</p>
    </div>

    <div class="sec">
      <h3>所需工具 <span class="tag infer">推断</span></h3>
      <p>${p.tool}</p>
    </div>

    ${p.note ? `<div class="sec-note">${p.note}</div>` : ''}
  `;
}

function overviewHTML() {
  const list = INSIGHTS.map((it) => `
    <div class="insight">
      <div class="insight-top"><b>${it.k}</b><span>${it.v}</span></div>
      <p>${it.text}</p>
    </div>`).join('');

  return `
    <div class="ins-code">OVERVIEW</div>
    <h2 class="ins-title">结构概览</h2>
    <p class="ins-sub">17 个刚体 · 12 个驱动关节 · 20.70 kg</p>

    ${list}

    <div class="src-note">
      <b>实测数据</b> — ${SOURCE_NOTE.verified}<br><br>
      <b>推断数据</b> — ${SOURCE_NOTE.infer}
    </div>
  `;
}

/* ── 底栏 ───────────────────────────────────────────── */
function renderDock() {
  const info = $('dock-info');

  if (state.mode === 'explode') {
    info.innerHTML = `
      <div class="dock-kicker">爆炸视图 · ${Math.round(viewer.explodeTarget * 100)}%</div>
      <div class="dock-title">沿各连杆的装配轴分解</div>
      <div class="dock-note">拖动滑块看装配层级；点任意零件查看档案。腿总成走横向分离，其余沿连杆向下。</div>`;
  } else if (state.mode === 'train') {
    const done = state.stepIndex >= steps.length;
    const s = done ? null : steps[state.stepIndex];
    info.innerHTML = done
      ? `<div class="dock-kicker">拆装实训 · 完成</div>
         <div class="dock-title">16 个零件已全部拆下</div>
         <div class="dock-note">反向执行即为装配顺序 —— 装配总是从根部开始，与拆卸刚好相反。</div>`
      : `<div class="dock-kicker">第 ${state.stepIndex + 1} / ${steps.length} 步 · 阶段 ${s.phase}</div>
         <div class="dock-title">${s.title}</div>
         <div class="dock-note">工具：${s.tool} ｜ ${s.note}</div>`;
  } else {
    info.innerHTML = `
      <div class="dock-kicker">自由探索</div>
      <div class="dock-title">点击任意零件查看结构与档案</div>
      <div class="dock-note">左键拖动旋转 · 滚轮缩放 · 右键平移 · 点击空白处返回概览</div>`;
  }

  updateDockButtons();
  syncPips();
}

function updateDockButtons() {
  const prev = $('btn-prev');
  const next = $('btn-next');
  if (!prev) return;
  prev.disabled = state.stepIndex === 0;
  next.disabled = state.stepIndex >= steps.length;
  next.textContent = state.stepIndex === 0 ? '拆下第一个' : '下一步';
}

function syncPips() {
  const pips = $('pips');
  if (!pips) return;
  pips.innerHTML = steps.map((_, i) => {
    const cls = i < state.stepIndex ? 'is-done' : i === state.stepIndex ? 'is-now' : '';
    return `<i class="step-pip ${cls}"></i>`;
  }).join('');
}

/* ── 拆装实训逻辑 ────────────────────────────────────── */
function resetTrain() {
  stopDemo();
  state.removed.clear();
  state.stepIndex = 0;
  viewer.resetAll();
  syncTree();
  renderDock();
}

function execStep(i, forward = true) {
  const s = steps[i];
  if (!s) return;
  if (forward) {
    state.removed.add(s.part);
    viewer.setPartOut(s.part, true);
    state.stepIndex = i + 1;
  } else {
    state.removed.delete(s.part);
    viewer.setPartOut(s.part, false);
    state.stepIndex = i;
  }
  syncTree();
  renderDock();
}

function nextStep() {
  if (state.stepIndex >= steps.length) return;
  const s = steps[state.stepIndex];
  execStep(state.stepIndex, true);
  toast(`拆下：${s.title.replace('拆下', '')}`);
  focusPart(s.part);
  if (state.stepIndex >= steps.length) toast('全部拆解完成', 'good');
}

function prevStep() {
  if (state.stepIndex <= 0) return;
  const i = state.stepIndex - 1;
  const s = steps[i];
  execStep(i, false);
  toast(`装回：${s.title.replace('拆下', '')}`);
}

function focusPart(id) {
  viewer.select(id);
  state.selected = id;
  viewer.focus(id);
  renderInspector();
  syncTree();
  syncFocusLeg(id);
}

/* 关节标签与连杆尺寸只标一条腿：选中哪条腿就标哪条，没选就标左前 */
function syncFocusLeg(id) {
  const p = id ? byId.get(id) : null;
  const leg = p && p.leg ? p.leg : 'FL';
  annotator.setFocusLeg(leg);
  viewer.setFocusLeg(leg);
}

function startDemo() {
  if (state.demo) { stopDemo(); return; }
  resetTrain();
  toast('演示：按工艺顺序自动拆卸');
  state.demo = setInterval(() => {
    if (state.stepIndex >= steps.length) { stopDemo(); return; }
    const s = steps[state.stepIndex];
    execStep(state.stepIndex, true);
    viewer.select(s.part);
    state.selected = s.part;
    renderInspector();
  }, 780);
  $('btn-demo').textContent = '停止';
  $('btn-demo').classList.add('is-on');
}

function stopDemo() {
  if (state.demo) { clearInterval(state.demo); state.demo = null; }
  const b = $('btn-demo');
  if (b) { b.textContent = '演示'; b.classList.remove('is-on'); }
}

/* ── 点选 ───────────────────────────────────────────── */
function onPartChosen(id, from = '3d') {
  if (state.mode === 'train') {
    // 实训模式：点的必须是当前该拆的那一件
    if (id === 'base') {
      toast('机身是装配基准，不参与拆卸', 'bad');
      return;
    }
    if (state.removed.has(id)) {
      toast('这件已经拆下来了', 'bad');
      return;
    }
    const s = steps[state.stepIndex];
    if (!s) { toast('已全部拆完，点「重来」可以再练一次'); return; }

    if (id === s.part) {
      execStep(state.stepIndex, true);
      viewer.select(id);
      state.selected = id;
      viewer.focus(id);
      renderInspector();
      syncFocusLeg(id);
      toast(`✓ ${s.title}`, 'good');
      if (state.stepIndex >= steps.length) toast('16 件全部拆下，完成', 'good');
      return;
    }

    const want = stepOfPart.get(id);
    if (want > state.stepIndex) {
      toast(`顺序不对 — 要先${s.title}`, 'bad');
    } else {
      toast(`这件已经拆下了`, 'bad');
    }
    return;
  }

  // 爆炸 / 自由模式：单纯选中
  state.selected = id;
  viewer.select(id);
  renderInspector();
  syncTree();
  syncFocusLeg(id);
}

/* ── 提示 ───────────────────────────────────────────── */
let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast is-on' + (kind ? ` is-${kind}` : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2200);
}

/* ── 交互绑定 ───────────────────────────────────────── */
function bind() {
  // 模式
  $('modes').addEventListener('click', (e) => {
    const b = e.target.closest('.mode');
    if (!b) return;
    setMode(b.dataset.mode);
  });

  // 视角预设
  const DIRS = {
    front: [1, 0.1, 0],
    side: [0, 0.1, 1],
    top: [0, 1, 0.001],
    iso: [0.85, 0.55, 0.85],
  };
  $('views').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    const d = DIRS[b.dataset.view];
    viewer.fit(new (viewer.camera.position.constructor)(...d));
    flashChip(b);
  });

  // 关节标注 / 透视
  $('btn-joints').addEventListener('click', (e) => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    e.currentTarget.setAttribute('aria-pressed', String(on));
    viewer.setJoints(on);
    annotator.setJoints(on);
    document.body.classList.toggle('is-joints', on);
    if (on) toast('关节标注：橙色为转轴，标签取当前选中腿');
  });

  $('btn-dims').addEventListener('click', (e) => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    e.currentTarget.setAttribute('aria-pressed', String(on));
    annotator.setDims(on);
    if (on) toast('尺寸标注：轴距 / 轮距 / 站高，连杆长度跟随选中腿');
  });

  $('btn-ghost').addEventListener('click', (e) => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    e.currentTarget.setAttribute('aria-pressed', String(on));
    viewer.setGhost(on);
  });

  // 指针：hover 与 click 分开
  let downX = 0, downY = 0, downT = 0, moved = false;
  let hoverTimer = 0;

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    downX = e.clientX; downY = e.clientY; downT = performance.now(); moved = false;
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons) {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) moved = true;
      return;
    }
    if (!loaded) return;
    const now = performance.now();
    if (now - hoverTimer < 70) return;
    hoverTimer = now;

    const id = viewer.pick(e.clientX, e.clientY);
    viewer.hover(id);
    state.hovered = id;

    const tip = $('hover-tip');
    if (id) {
      const p = byId.get(id);
      const r = canvas.getBoundingClientRect();
      tip.textContent = `${p.name} · ${p.mass.toFixed(3)} kg`;
      tip.style.left = `${e.clientX - r.left}px`;
      tip.style.top = `${e.clientY - r.top}px`;
      tip.classList.add('is-on');
      highlightTree(id);
    } else {
      tip.classList.remove('is-on');
      highlightTree(null);
    }
  });

  canvas.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    const quick = performance.now() - downT < 500;
    if (moved || !quick || !loaded) return;
    const id = viewer.pick(e.clientX, e.clientY);
    if (id) onPartChosen(id, '3d');
    else if (state.mode !== 'train') {
      state.selected = null;
      viewer.select(null);
      renderInspector();
      syncTree();
    }
  });

  canvas.addEventListener('pointerleave', () => {
    $('hover-tip').classList.remove('is-on');
    viewer.hover(null);
    highlightTree(null);
  });

  // 快捷键
  addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' && state.mode === 'train') { nextStep(); e.preventDefault(); }
    if (e.key === 'ArrowLeft' && state.mode === 'train') { prevStep(); e.preventDefault(); }
    if (e.key === 'Escape') {
      state.selected = null;
      viewer.select(null);
      renderInspector();
      syncTree();
    }
  });
}

function highlightTree(id) {
  for (const btn of $('tree').querySelectorAll('.tree-row')) {
    if (btn.dataset.id === id) btn.classList.add('is-hov');
    else btn.classList.remove('is-hov');
  }
}

function flashChip(btn) {
  btn.setAttribute('aria-pressed', 'true');
  setTimeout(() => btn.setAttribute('aria-pressed', 'false'), 260);
}

/* ── 模式切换 ───────────────────────────────────────── */
function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  document.body.dataset.mode = mode;
  stopDemo();

  for (const b of $('modes').querySelectorAll('.mode')) {
    b.classList.toggle('is-on', b.dataset.mode === mode);
  }

  if (mode === 'train') {
    state.selected = null;
    viewer.select(null);
    viewer.resetAll();
    state.removed.clear();
    state.stepIndex = 0;
    viewer.fit(new (viewer.camera.position.constructor)(0.85, 0.55, 0.85));
    toast('实训开始：按顺序点该拆的零件');
  } else if (mode === 'explode') {
    viewer.resetAll();
    state.removed.clear();
    state.stepIndex = 0;
  }

  syncTree();
  renderInspector();
  renderDock();
}

/* ── 底栏控件（只建一次，按模式显隐）───────────────── */
function buildDock() {
  const c = $('dock-control');
  c.innerHTML = `
    <div class="slider-wrap" data-only="explode">
      <span class="slider-label">分解</span>
      <input type="range" id="explode" min="0" max="100" value="0" />
      <span class="slider-val" id="explode-val">0%</span>
    </div>
    <div class="step-pips" data-only="train" id="pips"></div>
    <button class="btn" data-only="train" id="btn-prev">上一步</button>
    <button class="btn primary" data-only="train" id="btn-next">拆下第一个</button>
    <button class="btn" data-only="train" id="btn-demo">演示</button>
    <button class="btn" data-only="train" id="btn-reset">重来</button>
    <button class="btn" data-only="explode free" id="btn-allout">全部拆开</button>
    <button class="btn" data-only="explode free" id="btn-allin">全部装回</button>
  `;

  const slider = $('explode');
  const val = $('explode-val');

  const setPct = (v) => {
    slider.style.setProperty('--pct', `${v}%`);
    val.textContent = `${Math.round(v)}%`;
  };

  slider.addEventListener('input', () => {
    const v = Number(slider.value);
    setPct(v);
    viewer.setExplode(v / 100);
    const k = $('dock-info').querySelector('.dock-kicker');
    if (k) k.textContent = `爆炸视图 · ${Math.round(v)}%`;
  });

  $('btn-allout').addEventListener('click', () => {
    viewer.setAllOut(true);
    slider.value = 100; setPct(100);
  });
  $('btn-allin').addEventListener('click', () => {
    viewer.setAllOut(false);
    slider.value = 0; setPct(0);
  });
  $('btn-prev').addEventListener('click', prevStep);
  $('btn-next').addEventListener('click', nextStep);
  $('btn-demo').addEventListener('click', startDemo);
  $('btn-reset').addEventListener('click', () => { resetTrain(); toast('已重置'); });

  setPct(0);
}

buildDock();
bind();

/* ── 通过 URL 直接进入某个状态 ─────────────────────────
   ?mode=train&step=5     直接拆到第 5 步
   ?sel=FL_thigh          选中某个零件（id 见 data.js）
   ?e=100                 爆炸 100%
   ?joints=1&ghost=1      打开关节标注 / 透视
   ?view=iso              视角：front / side / top / iso
   用于演示、截图、以及把某个视图直接发给别人。
   ──────────────────────────────────────────────────── */
function applyQuery() {
  const q = new URLSearchParams(location.search);
  if (![...q.keys()].length) return;

  const mode = q.get('mode');
  if (mode) setMode(mode);

  if (q.has('joints')) {
    $('btn-joints').setAttribute('aria-pressed', 'true');
    viewer.setJoints(true);
    annotator.setJoints(true);
    document.body.classList.add('is-joints');
  }
  if (q.has('dims')) {
    $('btn-dims').setAttribute('aria-pressed', 'true');
    annotator.setDims(true);
  }
  if (q.has('ghost')) {
    $('btn-ghost').setAttribute('aria-pressed', 'true');
    viewer.setGhost(true);
  }

  if (q.has('e')) {
    const sl = $('explode');
    sl.value = q.get('e');
    sl.dispatchEvent(new Event('input'));
  }

  if (q.has('setup')) {
    // 跳过校验，直接把指定零件摆出去（用于展示「装了一半」的状态）
    for (const id of q.get('setup').split(',')) {
      if (id && byId.has(id)) { state.removed.add(id); viewer.setPartOut(id, true); }
    }
    syncTree();
  }

  if (q.has('step')) {
    const n = Number(q.get('step')) || 0;
    for (let i = 0; i < n; i++) nextStep();
  }

  if (q.has('sel') && byId.has(q.get('sel'))) {
    onPartChosen(q.get('sel'), 'q');
  }

  if (q.has('view')) {
    const map = { front: [1, 0.1, 0], side: [0, 0.1, 1], top: [0, 1, 0.001], iso: [0.85, 0.55, 0.85] };
    const d = map[q.get('view')];
    if (d) viewer.fit(new (viewer.camera.position.constructor)(...d));
  }

  // 同步推进若干帧再画一帧：无头截图与自动化验证用它拿稳定状态
  if (q.has('leg')) annotator.setFocusLeg(q.get('leg'));

  if (q.has('settle')) {
    viewer.settle(Number(q.get('settle')) || 60);
  }

  if (q.has('diag')) {
    setTimeout(() => {
      const pre = document.createElement('pre');
      pre.id = 'diag';
      pre.style.cssText = 'position:fixed;left:0;top:0;z-index:99;font-size:10px;background:#fff;margin:0;padding:4px';
      const lines = [`mode=${state.mode} explodeTarget=${viewer.explodeTarget} lift=${(viewer._lift || 0).toFixed(3)} cam=${viewer.camera.position.toArray().map((n) => n.toFixed(2))} tgt=${viewer.controls.target.toArray().map((n) => n.toFixed(2))}`];
      const wp = new (viewer.camera.position.constructor)();
      const box = new (window.__Box3 || Object)();
      for (const p of parts) {
        p.node.getWorldPosition(wp);
        const lv = [p.offset.x, p.offset.y, p.offset.z].map((n) => n.toFixed(3)).join(',');
        lines.push(`${p.id.padEnd(9)} t=${(p.t ?? 0).toFixed(2)} off=${lv} world=${wp.toArray().map((n) => n.toFixed(2)).join(',')}`);
      }
      pre.textContent = lines.join('\n');
      document.body.appendChild(pre);
    }, 1200);
  }
}
