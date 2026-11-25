/* ══════════════════════════════════════════════════════
   annotate.js — 覆盖在画布上的 2D 标注层
   ──────────────────────────────────────────────────────
   两类内容，都用 SVG 画，每帧跟着相机走：
   · 关节标签   当前关注腿的 3 个转轴：引线 + 角度
   · 尺寸标注   轴距 / 轮距 / 站高 / 连杆长度，工程制图式画法

   为什么用 2D 而不是 3D 文字：3D 文字（Sprite）永远朝向相机、
   大小随距离变，读起来像贴纸；工程图的尺寸线本来就该"屏幕对齐"，
   线宽和字高固定，转到任何视角都清楚。

   两条排版规则（不遵守就会糊成一团）：
   1. 尺寸线全部落在机身外侧的地面上，像三视图那样画在零件轮廓外；
   2. 标签按 y 排序强制拉开间距，再整体限制在画布内。
   ══════════════════════════════════════════════════════ */

import * as THREE from 'three';
import { L1, L2, HIP_X, FOOT_Y, STAND_H } from './data.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};

/* 尺寸标注的锚点：root 局部（MJCF，z 向上，x 向前，y 向左）
   注意 MJCF 原点在机身中心面，不是地面 —— 地面在 z = −STAND_H。
   第一次把这批线画成了悬在机体半空的线，就是把这个 z 当成了地面。
   现在全部贴地、放在机身投影轮廓之外，线条不会穿进模型。 */
const GROUND = -STAND_H;    // 地面所在的 z
const G = GROUND + 0.004;   // 略高于地面，避免和网格线打架
const OUT = 0.10;           // 离机身轮廓的外扩量
const DIMS = [
  {
    key: 'wheelbase', label: '轴距', value: HIP_X * 2000,
    a: [-HIP_X, -(FOOT_Y + OUT + 0.13), G], b: [HIP_X, -(FOOT_Y + OUT + 0.13), G], off: 24,
  },
  {
    key: 'track', label: '足端轮距', value: FOOT_Y * 2000,
    a: [HIP_X + 0.26, FOOT_Y, G], b: [HIP_X + 0.26, -FOOT_Y, G], off: 24,
  },
  {
    key: 'height', label: '髋轴离地', value: STAND_H * 1000,
    a: [-(HIP_X + 0.13), -(FOOT_Y + 0.02), GROUND], b: [-(HIP_X + 0.13), -(FOOT_Y + 0.02), 0], off: 26,
  },
];

/* 连杆长度：只标"当前关注的那条腿"，否则四条腿的尺寸线会糊成一片 */
const LINK_DIMS = [
  { key: 'thigh', label: '大腿', value: L1 * 1000, from: 'thigh', to: 'calf', off: 22 },
  { key: 'calf', label: '小腿', value: L2 * 1000, from: 'calf', to: 'foot', off: 22 },
];

const JOINT_CN = { hip: '髋横摆', thigh: '髋俯仰', calf: '膝屈伸' };

export class Annotator {
  constructor(viewer, svg) {
    this.viewer = viewer;
    this.svg = svg;
    this.jointsOn = false;
    this.dimsOn = false;
    this.focusLeg = 'FL';

    this.gDims = el('g', { class: 'a-dims' });
    this.gJoints = el('g', { class: 'a-joints' });
    this.svg.append(this.gDims, this.gJoints);

    this._jointNodes = new Map();   // partId -> {g, lead, dot, text}
    this._dimNodes = new Map();     // key -> {...}
    this._linkNodes = new Map();

    this._buildJointNodes();
    this._buildDimNodes();

    viewer.afterRender = () => this.update();
    addEventListener('resize', () => this.update());
  }

  /* ── 建 DOM（一次），之后只改属性 ─────────────────── */
  _buildJointNodes() {
    for (const part of this.viewer.parts) {
      if (!part.joint) continue;
      const g = el('g', { class: 'a-joint' });
      const lead = el('line', { class: 'a-lead' });
      const dot = el('circle', { r: 2.8, class: 'a-dot' });
      const text = el('text', { class: 'a-jtext' });
      g.append(lead, dot, text);
      g.setAttribute('opacity', '0');
      this.gJoints.append(g);
      this._jointNodes.set(part.id, { g, lead, dot, text });
    }
  }

  _buildDimNodes() {
    const mk = (parent, map, key) => {
      const g = el('g', { class: 'a-dim' });
      const ext1 = el('line', { class: 'a-ext' });
      const ext2 = el('line', { class: 'a-ext' });
      const line = el('line', { class: 'a-line' });
      const t1 = el('line', { class: 'a-tick' });
      const t2 = el('line', { class: 'a-tick' });
      const text = el('text', { class: 'a-text', 'text-anchor': 'middle' });
      g.append(ext1, ext2, line, t1, t2, text);
      g.setAttribute('opacity', '0');
      parent.append(g);
      map.set(key, { g, ext1, ext2, line, t1, t2, text });
    };
    for (const d of DIMS) mk(this.gDims, this._dimNodes, d.key);
    for (const d of LINK_DIMS) mk(this.gDims, this._linkNodes, d.key);
  }

  /* ── 开关 ─────────────────────────────────────────── */
  setJoints(on) {
    this.jointsOn = on;
    this.update();
  }

  setDims(on) {
    this.dimsOn = on;
    this.update();
  }

  setFocusLeg(key) {
    if (!key || key === this.focusLeg) return;
    this.focusLeg = key;
    this.update();
  }

  /* ── 每帧刷新 ─────────────────────────────────────── */
  update() {
    if (!this.viewer.camera) return;
    this._rect = this.viewer.canvas.getBoundingClientRect();
    if (!this._rect.width) return;
    this.svg.setAttribute('viewBox', `0 0 ${this._rect.width} ${this._rect.height}`);

    this._updateJoints();
    this._updateDims();
  }

  _p(v) {
    const r = this._rect;
    const p = v.clone().project(this.viewer.camera);
    return {
      x: (p.x * 0.5 + 0.5) * r.width,
      y: (-p.y * 0.5 + 0.5) * r.height,
      ok: p.z > -1 && p.z < 1,
    };
  }

  /* 机身中心的屏幕位置：判断尺寸线该往哪边偏、标签该往哪边让 */
  _bodyCenter() {
    const v = new THREE.Vector3(0, 0, STAND_H * 0.45);
    this.viewer.root.localToWorld(v);
    return this._p(v);
  }

  /* ── 关节标签：引线 + 防重叠 ─────────────────────── */
  _updateJoints() {
    const v = new THREE.Vector3();
    const items = [];

    for (const part of this.viewer.parts) {
      if (!part.joint) continue;
      const node = this._jointNodes.get(part.id);
      if (!node) continue;

      // 只标"关注的那条腿"：12 个全写就是一片橘色文字
      const show = this.jointsOn && (!part.leg || part.leg === this.focusLeg);
      if (!show || !part.jointNode) { node.g.setAttribute('opacity', '0'); continue; }

      part.jointNode.getWorldPosition(v);
      const p = this._p(v);
      if (!p.ok) { node.g.setAttribute('opacity', '0'); continue; }

      const ang = part.joint.axis === 'X'
        ? part.jointNode.rotation.x
        : part.jointNode.rotation.y;
      const deg = (ang * 180) / Math.PI;

      items.push({ node, p, text: `${JOINT_CN[part.type]} ${part.joint.axis} ${deg.toFixed(1)}°` });
    }

    if (!items.length) return;

    const H = this._rect.height;
    const W = this._rect.width;
    const GAP = 19;
    const PAD = 16;

    // 标签放在关节"背离机身"的那一侧，再按纵向强制最小间距 ——
    // 一条腿的三个关节常常几乎重合成一条竖线，不做避让就叠在一起。
    const c = this._bodyCenter();
    for (const it of items) {
      it.right = it.p.x >= c.x;
      // 靠边的关节：优先放外侧，外侧放不下就翻到内侧，别顶出画布
      if (it.right && it.p.x + 24 > W - 96) it.right = false;
      if (!it.right && it.p.x - 24 < 96) it.right = true;
    }

    const place = (arr) => {
      if (!arr.length) return;
      arr.sort((a, b) => a.p.y - b.p.y);
      const ys = arr.map((it) => it.p.y - 15);
      for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + GAP);
      if (ys[ys.length - 1] > H - PAD) {
        ys[ys.length - 1] = H - PAD;
        for (let i = ys.length - 2; i >= 0; i--) ys[i] = Math.min(ys[i], ys[i + 1] - GAP);
      }
      arr.forEach((it, i) => { it.ly = Math.max(ys[i], PAD); });
    };
    place(items.filter((it) => it.right));
    place(items.filter((it) => !it.right));

    for (const { node, p, text, right, ly } of items) {
      const lx = right
        ? Math.min(p.x + 24, W - 96)
        : Math.max(p.x - 24, 96);

      node.g.setAttribute('opacity', '1');
      node.dot.setAttribute('cx', p.x.toFixed(1));
      node.dot.setAttribute('cy', p.y.toFixed(1));
      node.lead.setAttribute('x1', p.x.toFixed(1));
      node.lead.setAttribute('y1', p.y.toFixed(1));
      node.lead.setAttribute('x2', (right ? lx - 4 : lx + 4).toFixed(1));
      node.lead.setAttribute('y2', ly.toFixed(1));
      node.text.setAttribute('text-anchor', right ? 'start' : 'end');
      node.text.setAttribute('x', lx.toFixed(1));
      node.text.setAttribute('y', (ly + 3.5).toFixed(1));
      node.text.textContent = text;
    }
  }

  /* ── 尺寸标注 ─────────────────────────────────────── */
  _updateDims() {
    // 全局尺寸
    for (const d of DIMS) {
      const a = new THREE.Vector3(...d.a);
      const b = new THREE.Vector3(...d.b);
      this.viewer.root.localToWorld(a);
      this.viewer.root.localToWorld(b);
      this._drawDim(this._dimNodes.get(d.key), a, b,
        `${d.label} ${d.value.toFixed(1)} mm`, d.off, this.dimsOn);
    }

    // 连杆尺寸：跟"关注腿"走
    if (!this.dimsOn) {
      for (const n of this._linkNodes.values()) n.g.setAttribute('opacity', '0');
      return;
    }
    const v = new THREE.Vector3();
    const leg = this.focusLeg;
    for (const d of LINK_DIMS) {
      const fromPart = this.viewer.byId.get(`${leg}_${d.from}`);
      const toPart = this.viewer.byId.get(`${leg}_${d.to}`);
      if (!fromPart || !toPart || !fromPart.jointNode) continue;
      fromPart.jointNode.getWorldPosition(v);
      const a = v.clone();
      toPart.node.getWorldPosition(v);
      const b = v.clone();
      this._drawDim(this._linkNodes.get(d.key), a, b,
        `${d.label} ${d.value.toFixed(1)} mm`, d.off, true);
    }
  }

  /* 画一根工程尺寸线：延长线 + 尺寸线 + 两端 45° 短划 + 数值。
     偏移方向一律取"离开机身中心"的那一侧，否则视角一转就压回零件上。 */
  _drawDim(node, a, b, label, off, visible) {
    if (!node) return;
    const pa = this._p(a);
    const pb = this._p(b);
    if (!visible || !pa.ok || !pb.ok) { node.g.setAttribute('opacity', '0'); return; }

    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy);
    if (len < 14) { node.g.setAttribute('opacity', '0'); return; }

    let nx = -dy / len;
    let ny = dx / len;

    const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
    const c = this._bodyCenter();
    if ((mid.x - c.x) * nx + (mid.y - c.y) * ny < 0) { nx = -nx; ny = -ny; }

    const ax = pa.x + nx * off, ay = pa.y + ny * off;
    const bx = pb.x + nx * off, by = pb.y + ny * off;

    const set = (n, x1, y1, x2, y2) => {
      n.setAttribute('x1', x1.toFixed(1)); n.setAttribute('y1', y1.toFixed(1));
      n.setAttribute('x2', x2.toFixed(1)); n.setAttribute('y2', y2.toFixed(1));
    };
    // 延长线：从锚点拉到尺寸线外 7px
    set(node.ext1, pa.x, pa.y, pa.x + nx * (off + 7), pa.y + ny * (off + 7));
    set(node.ext2, pb.x, pb.y, pb.x + nx * (off + 7), pb.y + ny * (off + 7));
    set(node.line, ax, ay, bx, by);

    // 端部 45° 短划
    const tx = nx * 4.5 - (dx / len) * 4.5;
    const ty = ny * 4.5 - (dy / len) * 4.5;
    set(node.t1, ax - tx, ay - ty, ax + tx, ay + ty);
    set(node.t2, bx - tx, by - ty, bx + tx, by + ty);

    // 数值贴在尺寸线外侧，并夹在画布内
    const cx = Math.min(Math.max(mid.x + nx * (off + 13), 46), this._rect.width - 46);
    const cy = Math.min(Math.max(mid.y + ny * (off + 13), 14), this._rect.height - 8);
    node.text.setAttribute('x', cx.toFixed(1));
    node.text.setAttribute('y', cy.toFixed(1));
    node.text.textContent = label;
    node.g.setAttribute('opacity', '1');
  }
}
