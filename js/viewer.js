/* ══════════════════════════════════════════════════════
   viewer.js — 装配体的 3D 呈现
   ──────────────────────────────────────────────────────
   层级严格按官方 MJCF 复刻：
     base_link
       └ hip(x 轴转动) └ thigh(y) └ calf(y) └ foot
   爆炸方向沿各连杆自身的装配轴，而不是随意散开，
   这样分解图才符合机械制图的爆炸视图习惯。
   ══════════════════════════════════════════════════════ */

import * as THREE from 'three';
import { STLLoader } from '../vendor/STLLoader.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { L1, L2, HIP_X, HIP_Y, THIGH_DY, FOOT_R, STAND_H, LEGS } from './data.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ── 单腿逆运动学（与 gesture-sim 同一套闭式解）────────
   dyOff 是大腿相对髋的横向偏置，髋转动时它跟着转，
   所以腿平面过的是「转过 q1 后的大腿根」，不是髋原点。
   ───────────────────────────────────────────────────── */
function solveLeg(dx, dy, dz, dyOff = 0) {
  const dTot = Math.hypot(dx, dy, dz);
  const pz = -Math.sqrt(Math.max(0, dTot * dTot - dx * dx - dyOff * dyOff));
  const q1 = Math.atan2(dz, dy) - Math.atan2(pz, dyOff);

  const r = -pz;
  let d = Math.hypot(dx, r);
  d = clamp(d, Math.abs(L1 - L2) + 1e-4, L1 + L2 - 1e-4);

  const cosQ3 = clamp((d * d - L1 * L1 - L2 * L2) / (2 * L1 * L2), -1, 1);
  const q3 = -Math.acos(cosQ3);

  const alpha = Math.atan2(-dx, r);
  const beta = Math.atan2(L2 * Math.sin(q3), L1 + L2 * Math.cos(q3));
  const q2 = alpha - beta;
  return { q1, q2, q3 };
}

/* ── 零件的基础色（浅色工程风）──────────────────────── */
const BASE_COLOR = {
  base: 0xccd4de,
  hip: 0xbcc5d0,
  thigh: 0xc4ccd6,
  calf: 0xb6c0cc,
  foot: 0x3d4552,
};

/* 爆炸位移
   hip 沿横向分离（整条腿从机身拔出）；
   其余三段沿「腿的中心线」分开 —— 这条线由髋指向足端，
   不是各连杆自己的轴。机械制图里爆炸视图就是这个意思：
   零件沿装配路径拉出，而不是各自朝自己的方向散。
   具体向量在建好姿态后由 _computeExplodeOffsets() 反算到各自父坐标系。 */
const EXPLODE = {
  hip: (leg) => new THREE.Vector3(0, leg.sy * 0.32, 0),
  dist: { thigh: 0.21, calf: 0.25, foot: 0.21 },
};

// 站立时髋轴线到足端球心的距离：髋离地 300 mm，球底才接地
const STAND_Z = -(STAND_H - FOOT_R);
const STAND_Y = STAND_H;   // 髋轴线离地高度
const LIFT = 0.58;       // 分解时机身上抬，免得零件钻到地面以下

export class Viewer {
  constructor(canvas, parts) {
    this.canvas = canvas;
    this.parts = parts;
    this.byId = new Map(parts.map((p) => [p.id, p]));
    this.selectedId = null;
    this.hoveredId = null;
    this.ghost = false;
    this.jointsOn = false;
    this.explodeT = 0;
    this.explodeTarget = 0;

    this._initScene();
  }

  /* ── 场景 ─────────────────────────────────────────── */
  _initScene() {
    const canvas = this.canvas;
    const box = canvas.parentElement;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(box.clientWidth, box.clientHeight, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(34, box.clientWidth / box.clientHeight, 0.05, 60);
    this.camera.position.set(0.95, 0.78, 1.05);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.target.set(0, 0.24, 0);
    this.controls.minDistance = 0.35;
    this.controls.maxDistance = 4.5;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.update();
    this._orbiting = false;
    this.controls.addEventListener('start', () => { this._orbiting = true; this._fitTarget = null; });
    this.controls.addEventListener('end', () => { this._orbiting = false; });

    /* 光照：一主一辅一背光，浅背景上把体积感做出来 */
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb9c2cc, 0.8));

    const key = new THREE.DirectionalLight(0xffffff, 1.95);
    key.position.set(1.8, 3.0, 2.2);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-2.2, 1.2, -1.8);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffffff, 0.38);
    rim.position.set(0.2, 0.6, -3.0);
    this.scene.add(rim);

    this._buildGround();

    /* 机器狗本体装在一个容器里，方便整体变换 */
    this.root = new THREE.Group();
    this.root.rotation.x = -Math.PI / 2;   // MJCF 是 z 向上，转到 three 的 y 向上
    this.root.position.y = 0;
    this.root.userData.isRoot = true;
    this.scene.add(this.root);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    this._clock = new THREE.Clock();
    this._frames = 0;

    addEventListener('resize', () => this.resize());
    new ResizeObserver(() => this.resize()).observe(this.canvas.parentElement);
  }

  _buildGround() {
    const S = 512;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');

    g.fillStyle = '#fafbfd';
    g.fillRect(0, 0, S, S);

    // 细分格（0.1 m）
    g.strokeStyle = '#e3e9f0';
    g.lineWidth = 1;
    for (let i = 1; i < 5; i++) {
      const p = (i * S) / 5;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, S); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(S, p); g.stroke();
    }
    // 主格（0.5 m）
    g.strokeStyle = '#cbd5e1';
    g.lineWidth = 2.5;
    g.strokeRect(0, 0, S, S);

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(80, 80);          // 40 m 地面 / 0.5 m 一格
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    tex.colorSpace = THREE.SRGBColorSpace;

    // 径向 alpha：地面向外渐隐，避免出现生硬的矩形边界
    const fc = document.createElement('canvas');
    fc.width = fc.height = 256;
    const fg = fc.getContext('2d');
    const fade = fg.createRadialGradient(128, 128, 20, 128, 128, 128);
    fade.addColorStop(0, '#ffffff');
    fade.addColorStop(0.55, '#d8d8d8');
    fade.addColorStop(1, '#000000');
    fg.fillStyle = fade;
    fg.fillRect(0, 0, 256, 256);
    const alpha = new THREE.CanvasTexture(fc);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({
        map: tex, alphaMap: alpha, transparent: true,
        roughness: 0.95, metalness: 0.0, depthWrite: false,
      })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.001;
    this.scene.add(ground);

    // 机身下方的接触暗影：不用 shadowMap，省一遍 60 万三角形的渲染
    const sc = document.createElement('canvas');
    sc.width = sc.height = 256;
    const sg = sc.getContext('2d');
    const rad = sg.createRadialGradient(128, 128, 0, 128, 128, 128);
    rad.addColorStop(0, 'rgba(38, 52, 70, 0.30)');
    rad.addColorStop(0.45, 'rgba(38, 52, 70, 0.11)');
    rad.addColorStop(1, 'rgba(38, 52, 70, 0)');
    sg.fillStyle = rad;
    sg.fillRect(0, 0, 256, 256);

    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 1.5),
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false,
      })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.002;
    this.scene.add(shadow);
  }

  /* ── 加载 17 个网格并搭装配树 ─────────────────────── */
  async load(onProgress = () => {}) {
    const loader = new STLLoader();
    const names = ['base_link'];
    for (const leg of LEGS) {
      for (const t of ['hip', 'thigh', 'calf', 'foot']) names.push(`${leg.key}_${t}`);
    }

    const geo = {};
    let done = 0;
    for (const n of names) {
      geo[n] = await loader.loadAsync(`meshes/${n}.STL`);
      geo[n].computeBoundingBox();
      geo[n].computeBoundingSphere();
      done++;
      onProgress(done / names.length, n);
    }
    this.geo = geo;

    this._buildAssembly();
    this._applyPose();
    this._computeExplodeOffsets();
    this._buildJointMarkers();
    this.refreshMaterials();
    this.fit(0);
  }

  _buildAssembly() {
    for (const part of this.parts) {
      const material = new THREE.MeshStandardMaterial({
        color: BASE_COLOR[part.type],
        metalness: part.type === 'foot' ? 0.05 : 0.22,
        roughness: part.type === 'foot' ? 0.85 : 0.46,
        side: THREE.DoubleSide,
      });
      part.material = material;
      part.meshes = [];
    }

    // 机身
    const basePart = this.byId.get('base');
    basePart.node = this.root;
    basePart.basePos = new THREE.Vector3(0, 0, 0);
    basePart.offset = new THREE.Vector3();
    this._addMesh(basePart, 'base_link');

    // 四条腿
    for (const leg of LEGS) {
      const hipPart = this.byId.get(`${leg.key}_hip`);
      const hipNode = new THREE.Group();
      hipNode.position.set(leg.sx * HIP_X, leg.sy * HIP_Y, 0);
      this.root.add(hipNode);
      hipPart.node = hipNode;
      hipPart.basePos = hipNode.position.clone();
      hipPart.offset = EXPLODE.hip(leg);
      this._addMesh(hipPart, `${leg.key}_hip`);

      const thighPart = this.byId.get(`${leg.key}_thigh`);
      const thighNode = new THREE.Group();
      thighNode.position.set(0, leg.sy * THIGH_DY, 0);
      hipNode.add(thighNode);
      thighPart.node = thighNode;
      thighPart.basePos = thighNode.position.clone();
      thighPart.offset = new THREE.Vector3();   // 由 _computeExplodeOffsets 反算
      this._addMesh(thighPart, `${leg.key}_thigh`);

      const calfPart = this.byId.get(`${leg.key}_calf`);
      const calfNode = new THREE.Group();
      calfNode.position.set(0, 0, -L1);
      thighNode.add(calfNode);
      calfPart.node = calfNode;
      calfPart.basePos = calfNode.position.clone();
      calfPart.offset = new THREE.Vector3();
      this._addMesh(calfPart, `${leg.key}_calf`);

      const footPart = this.byId.get(`${leg.key}_foot`);
      const footNode = new THREE.Group();
      footNode.position.set(0, 0, -L2);
      calfNode.add(footNode);
      footPart.node = footNode;
      footPart.basePos = footNode.position.clone();
      footPart.offset = new THREE.Vector3();
      this._addMesh(footPart, `${leg.key}_foot`);

      // 记录关节节点，做姿态与标注用
      hipPart.jointNode = hipNode;
      thighPart.jointNode = thighNode;
      calfPart.jointNode = calfNode;
    }
  }

  _addMesh(part, name) {
    const mesh = new THREE.Mesh(this.geo[name], part.material);
    mesh.userData.partId = part.id;
    mesh.name = name;
    part.node.add(mesh);
    part.meshes.push(mesh);
  }

  /* 站立姿态：四腿对称，髋轴离地 300 mm，足端球底接地。
     注意 IK 的目标横向量是「足端到髋轴的距离」= 大腿横向偏置本身
     （105.4 mm），不是足端到机身中线的距离（165.4 mm）——
     髋座已经位于 ±60 mm 处，重复计入会让整条腿多滚 11°、外扩 60 mm。 */
  _applyPose() {
    for (const leg of LEGS) {
      const q = solveLeg(0, leg.sy * THIGH_DY, STAND_Z, leg.sy * THIGH_DY);
      const hip = this.byId.get(`${leg.key}_hip`);
      const thigh = this.byId.get(`${leg.key}_thigh`);
      const calf = this.byId.get(`${leg.key}_calf`);
      hip.jointNode.rotation.x = q.q1;
      thigh.node.rotation.y = q.q2;
      calf.node.rotation.y = q.q3;
      hip.q = q;
    }
    // 机身抬到髋轴离地 300 mm
    this.root.position.y = STAND_Y;
  }

  /* 把「沿腿中心线」的 root 局部方向反算到每个零件自己的父坐标系。
     各连杆带旋转，直接给同一个向量会让腿像扇子一样散开；
     反算之后所有零件沿同一条直线退出，才是爆炸视图该有的样子。 */
  _computeExplodeOffsets() {
    this.root.updateWorldMatrix(true, true);

    const qRoot = new THREE.Quaternion();
    const qParent = new THREE.Quaternion();
    this.root.getWorldQuaternion(qRoot);

    for (const leg of LEGS) {
      // 腿的中线：髋 → 足端（root 局部坐标，z 向上）
      const dir = new THREE.Vector3(0, leg.sy * THIGH_DY, STAND_Z).normalize();

      for (const type of ['thigh', 'calf', 'foot']) {
        const part = this.byId.get(`${leg.key}_${type}`);
        part.node.parent.getWorldQuaternion(qParent);
        const qRel = qParent.invert().multiply(qRoot);
        part.offset.copy(dir).applyQuaternion(qRel).multiplyScalar(EXPLODE.dist[type]);
      }
    }
  }

  /* 自动抬升：分解时保证最低的零件不钻到地面以下。
     先按未抬升的姿态量一次包围盒，得到需要抬多少，再落位，
     避免「抬升 → 位置变 → 又要重算」的反馈抖动。 */
  _updateLift(dt) {
    this.root.position.y = STAND_Y;
    this.root.updateWorldMatrix(true, true);

    const box = new THREE.Box3().setFromObject(this.root);
    const target = box.isEmpty() ? 0 : Math.max(0, 0.045 - box.min.y);

    if (this._lift === undefined) this._lift = target;
    else this._lift += (target - this._lift) * (1 - Math.exp(-dt * 7));

    this.root.position.y = STAND_Y + this._lift;
    this.root.updateWorldMatrix(true, true);
  }

  /* ── 关节标注：指示环 + 轴线，穿透零件显示 ─────────
     环的半径要大于关节壳体，否则整圈被包在零件内部看不见；
     depthTest 关掉 + renderOrder 拉高，轴线才能「穿透」显示成 X 光效果。
     ───────────────────────────────────────────────── */
  _buildJointMarkers() {
    this.markers = [];
    const ringGeo = new THREE.TorusGeometry(0.037, 0.0026, 8, 40);

    for (const part of this.parts) {
      if (!part.joint) continue;
      const g = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({
        color: 0xf97316, transparent: true, opacity: 0.95,
        depthTest: false, depthWrite: false,
      });
      const lineMat = new THREE.LineBasicMaterial({
        color: 0xea580c, transparent: true, opacity: 0.85,
        depthTest: false, depthWrite: false,
      });

      // 环：环面法向对齐关节轴
      const ring = new THREE.Mesh(ringGeo, mat);
      if (part.joint.axis === 'X') ring.rotation.y = Math.PI / 2;  // 法向 → x 轴
      else ring.rotation.x = Math.PI / 2;                          // 法向 → y 轴
      ring.renderOrder = 20;
      g.add(ring);

      // 轴线：贯穿关节的一根细线，长度取关节壳体外
      const L = 0.082;
      const pts = part.joint.axis === 'X'
        ? [new THREE.Vector3(-L, 0, 0), new THREE.Vector3(L, 0, 0)]
        : [new THREE.Vector3(0, -L, 0), new THREE.Vector3(0, L, 0)];
      const axis = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat);
      axis.renderOrder = 19;
      g.add(axis);

      // 轴心点：一个小方块，标出转轴中心
      const hub = new THREE.Mesh(
        new THREE.SphereGeometry(0.0055, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xea580c, depthTest: false, depthWrite: false })
      );
      hub.renderOrder = 21;
      g.add(hub);

      g.visible = false;
      part.jointNode.add(g);
      part.marker = g;
      part.markerAxis = axis;   // 非关注腿只留环，轴线收起来，否则一团乱线
      this.markers.push(g);
    }
  }

  /* ── 状态 ─────────────────────────────────────────── */

  select(id) {
    this.selectedId = id;
    this.refreshMaterials();
    this._refreshMarkers();
  }

  hover(id) {
    if (this.hoveredId === id) return;
    this.hoveredId = id;
    this.refreshMaterials();
    this.canvas.style.cursor = id ? 'pointer' : 'grab';
  }

  setGhost(on) {
    this.ghost = on;
    this.refreshMaterials();
  }

  setJoints(on) {
    this.jointsOn = on;
    this._refreshMarkers();
    this.refreshMaterials();   // 打开时整体转 X 光，否则轴线看不见
  }

  /* 关注腿：只有这条腿的环保持实色，其余压淡，否则 12 个环互相打架 */
  setFocusLeg(leg) {
    if (this.focusLeg === leg) return;
    this.focusLeg = leg;
    this._refreshMarkers();
  }

  _refreshMarkers() {
    if (!this.markers) return;
    for (const part of this.parts) {
      if (!part.marker) continue;
      const on = this.jointsOn || part.id === this.selectedId;
      part.marker.visible = on;
      if (!on) continue;
      const isFocus = !part.leg || part.leg === this.focusLeg;
      const fade = isFocus ? 1 : 0.18;
      if (part.markerAxis) part.markerAxis.visible = isFocus;
      part.marker.traverse((o) => {
        if (!o.material) return;
        if (o.material.userData.baseOpacity === undefined) {
          o.material.userData.baseOpacity = o.material.opacity;
        }
        o.material.opacity = o.material.userData.baseOpacity * fade;
      });
    }
  }

  refreshMaterials() {
    for (const part of this.parts) {
      const m = part.material;
      if (!m) continue;
      const isSel = part.id === this.selectedId;
      const isHover = part.id === this.hoveredId;
      // 透视：只看选中件；关节标注：整体变 X 光，让轴线露出来
      const seeThrough = (this.ghost && this.selectedId && !isSel)
        || (this.jointsOn && !isSel && !isHover);

      if (seeThrough) {
        m.transparent = true;
        m.opacity = this.ghost ? 0.14 : 0.2;
        m.depthWrite = false;
        m.color.setHex(BASE_COLOR[part.type]);
        m.emissive.setHex(0x000000);
      } else {
        m.transparent = false;
        m.opacity = 1;
        m.depthWrite = true;
        if (isSel) {
          m.color.setHex(part.type === 'foot' ? 0x3b6ef0 : 0xa9c4ff);
          m.emissive.setHex(0x2f62d6);
          m.emissiveIntensity = 0.34;
        } else if (isHover) {
          m.color.setHex(part.type === 'foot' ? 0x5a7fd8 : 0xcfdcff);
          m.emissive.setHex(0x2f62d6);
          m.emissiveIntensity = 0.14;
        } else {
          m.color.setHex(BASE_COLOR[part.type]);
          m.emissive.setHex(0x000000);
          m.emissiveIntensity = 0;
        }
      }
      m.needsUpdate = true;
    }
  }

  /* ── 爆炸：整体滑块 ──────────────────────────────── */
  setExplode(t) {
    this.explodeTarget = clamp(t, 0, 1);
    for (const part of this.parts) part.targetT = this.explodeTarget;
    this.refitToTargets();
  }

  /* 按「目标状态」量一次包围盒，算出相机该退到多远。
     分解会把装配体撑大好几倍，相机不跟着退，零件就飞出画面了。 */
  refitToTargets() {
    const saves = [];
    for (const part of this.parts) {
      if (part.id === 'base') continue;
      saves.push([part.node, part.node.position.clone()]);
      const e = (part.targetT ?? 0) * (part.targetT ?? 0) * (3 - 2 * (part.targetT ?? 0));
      part.node.position.set(
        part.basePos.x + part.offset.x * e,
        part.basePos.y + part.offset.y * e,
        part.basePos.z + part.offset.z * e
      );
    }
    this.root.updateWorldMatrix(true, true);

    const box = new THREE.Box3().setFromObject(this.root);
    const minY = box.min.y;

    for (const [node, pos] of saves) node.position.copy(pos);
    this.root.updateWorldMatrix(true, true);

    if (box.isEmpty()) return;

    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const vFov = (this.camera.fov * Math.PI) / 180;
    const dist = (sphere.radius / Math.sin(vFov / 2)) * 1.02;

    // 包围盒是在「未抬升」的姿态上量的，这里把抬升量补进中心，
    // 否则相机看的位置会低一截，机身顶部被切出画面
    const yLift = Math.max(0, 0.045 - minY);
    const center = sphere.center.clone();
    center.y += yLift;

    this._fitTarget = { center, dist };
  }

  /* 单个零件的拆下 / 装回 */
  setPartOut(id, out) {
    const part = this.byId.get(id);
    if (!part) return;
    part.targetT = out ? 1 : 0;
    this.refitToTargets();
  }

  setAllOut(out) {
    for (const part of this.parts) if (part.id !== 'base') part.targetT = out ? 1 : 0;
    this.explodeTarget = out ? 1 : 0;
    this.refitToTargets();
  }

  resetAll() {
    for (const part of this.parts) part.targetT = 0;
    this.explodeTarget = 0;
    this.refitToTargets();
  }

  /* ── 拾取 ─────────────────────────────────────────── */
  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const meshes = [];
    for (const p of this.parts) meshes.push(...p.meshes);

    const hits = this.raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;

    // 透视模式下，半透明的件不该抢拾取：优先取不透明的第一个
    for (const h of hits) {
      const id = h.object.userData.partId;
      if (!this.ghost || !this.selectedId || id === this.selectedId) return id;
    }
    return hits[hits.length - 1].object.userData.partId;
  }

  /* ── 视角 ─────────────────────────────────────────── */
  _worldBox(onlyId = null) {
    const box = new THREE.Box3();
    const targets = onlyId ? [this.byId.get(onlyId)] : this.parts;
    for (const p of targets) if (p && p.node) box.expandByObject(p.node);
    return box;
  }

  fit(dir = null) {
    this.refitToTargets();
    const ft = this._fitTarget;
    if (!ft) return;

    const center = ft.center.clone();

    let d;
    if (dir) {
      d = dir.clone().normalize();
    } else {
      d = this.camera.position.clone().sub(this.controls.target);
      if (d.lengthSq() < 1e-6) d.set(0.8, 0.6, 0.8);
      d.normalize();
    }

    this._camTween = {
      fromPos: this.camera.position.clone(),
      toPos: center.clone().addScaledVector(d, ft.dist),
      fromTarget: this.controls.target.clone(),
      toTarget: center,
      t: 0,
    };
    this._fitTarget = null;
  }

  focus(id) {
    const part = this.byId.get(id);
    if (!part) return;
    const box = this._worldBox(id);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const vFov = (this.camera.fov * Math.PI) / 180;
    // 局部查看时至少留 0.45 m 距离，别糊在脸上
    const dist = Math.max((sphere.radius / Math.sin(vFov / 2)) * 1.5, 0.5);

    this._camTween = {
      fromPos: this.camera.position.clone(),
      toPos: sphere.center.clone().addScaledVector(dir, dist),
      fromTarget: this.controls.target.clone(),
      toTarget: sphere.center.clone(),
      t: 0,
    };
  }

  /* ── 步进与渲染分离 ─────────────────────────────────
     step() 只算状态，render() 只画。分开是为了能在截图/自动化里
     用 settle() 同步推进若干帧，拿到稳定姿态 —— 无头环境里
     requestAnimationFrame 往往只跑一两帧，靠它等补间会一直等不到。
     ───────────────────────────────────────────────── */
  step(dt) {
    let moving = false;

    for (const part of this.parts) {
      if (part.targetT === undefined) part.targetT = 0;
      if (part.t === undefined) part.t = 0;

      if (Math.abs(part.t - part.targetT) > 1e-4) {
        part.t += (part.targetT - part.t) * (1 - Math.exp(-dt * 9));
        moving = true;
      } else {
        part.t = part.targetT;
      }

      if (part.id === 'base') continue;
      const e = part.t * part.t * (3 - 2 * part.t);
      part.node.position.set(
        part.basePos.x + part.offset.x * e,
        part.basePos.y + part.offset.y * e,
        part.basePos.z + part.offset.z * e
      );
    }

    if (this._camTween) {
      const tw = this._camTween;
      tw.t = Math.min(tw.t + dt / 0.55, 1);
      const k = tw.t * tw.t * (3 - 2 * tw.t);
      this.camera.position.lerpVectors(tw.fromPos, tw.toPos, k);
      this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, k);
      if (tw.t >= 1) this._camTween = null;
    }
    this._updateLift(dt);

    if (this._fitTarget && !this._orbiting) {
      const ft = this._fitTarget;
      const center = ft.center.clone();

      const dir = this.camera.position.clone().sub(this.controls.target);
      const curDist = dir.length() || 1;
      dir.normalize();

      const k = 1 - Math.exp(-dt * 4.5);
      const wantPos = center.clone().addScaledVector(dir, ft.dist);

      this.camera.position.lerp(wantPos, k);
      this.controls.target.lerp(center, k);

      if (Math.abs(curDist - ft.dist) < 0.02 && this.controls.target.distanceTo(center) < 0.01) {
        this._fitTarget = null;
      }
    }

    this.controls.update();
    return moving;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
    // 标注层要跟相机同步，画完 3D 再刷 2D，避免一帧的错位
    if (this.afterRender) this.afterRender();
  }

  /* 同步推进 n 帧，然后画一帧 */
  settle(n = 48, dt = 1 / 60) {
    for (let i = 0; i < n; i++) this.step(dt);
    this.render();
  }

  start() {
    const tick = () => {
      // 时间戳可能倒退（切标签页 / 无头虚拟时钟），负 dt 会让缓动系数变号
      const raw = this._clock.getDelta();
      const dt = Math.min(Math.max(raw, 0), 0.05) || 1 / 60;
      this.step(dt);
      this.render();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  resize() {
    const box = this.canvas.parentElement;
    const w = box.clientWidth;
    const h = box.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }
}
