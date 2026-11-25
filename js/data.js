/* ══════════════════════════════════════════════════════
   data.js — AS2 拆装站的数据层
   ──────────────────────────────────────────────────────
   数据来源（务必区分）：
   · 官方 MJCF  unitreerobotics/unitree_mujoco → unitree_robots/as2/as2.xml
     给出：刚体层级、关节轴与行程、执行器力矩上限、质量、连杆长度、
           关节阻尼与转子惯量、足端摩擦系数 —— 全部标 verified
   · 工程推断  材料、紧固件规格、拆卸工具 —— 官方未公开，标 infer
   ══════════════════════════════════════════════════════ */

/* ── 结构尺寸（MJCF 实测，单位 m）──────────────────── */
export const L1 = 0.212;          // 大腿 髋 → 膝
export const L2 = 0.21344;        // 小腿 膝 → 足
export const HIP_X = 0.2119;      // 髋关节前后位置
export const HIP_Y = 0.06;        // 髋关节左右位置
export const THIGH_DY = 0.1054;   // 大腿相对髋的横向偏置
export const FOOT_Y = HIP_Y + THIGH_DY;   // 腿伸直时足端到机身中线（165.4 mm）

/* 足端接触球：MJCF 里是原点处 R28 的球，实际网格最低点 −26.8 mm。
   接地点在球底而不是球心，差这 26.8 mm 整只脚就会陷进地面。 */
export const FOOT_R = 0.0268;
export const STAND_H = 0.37;      // 站立时髋轴线离地高度（腿长 425 mm 的 87%）

export const MASS = { base: 11.178, hip: 0.695, thigh: 1.3525, calf: 0.288, foot: 0.045 };

export const LEGS = [
  { key: 'FL', cn: '左前', sx: 1, sy: 1, idx: 1 },
  { key: 'FR', cn: '右前', sx: 1, sy: -1, idx: 2 },
  { key: 'RL', cn: '左后', sx: -1, sy: 1, idx: 3 },
  { key: 'RR', cn: '右后', sx: -1, sy: -1, idx: 4 },
];

/* ── 关节规格（MJCF 实测）────────────────────────────
   行程区间前后腿不同：大腿关节区间整体相差 0.699 rad，跨度都是 5.49 rad
   → 前后腿零位安装角不同，腿部不能互换
   ───────────────────────────────────────────────── */
const damp = { hip: 0.2, thigh: 0.2, calf: 0.5 };
const arm = { hip: 0.026, thigh: 0.026, calf: 0.038 };

function jointOf(type, isFront) {
  if (type === 'hip') {
    return { label: '髋关节', axis: 'X', axisDesc: '横摆（绕机身前后轴）',
      range: [-0.785, 0.785], torque: 60, damping: damp.hip, armature: arm.hip };
  }
  if (type === 'thigh') {
    return { label: '髋俯仰关节', axis: 'Y', axisDesc: '前后摆动（绕横向轴）',
      range: isFront ? [-2, 3.492] : [-1.3, 4.19], torque: 60,
      damping: damp.thigh, armature: arm.thigh };
  }
  if (type === 'calf') {
    return { label: '膝关节', axis: 'Y', axisDesc: '膝部屈伸（绕横向轴）',
      range: [-2.7677, -0.8133], torque: 90, damping: damp.calf, armature: arm.calf };
  }
  return null;
}

/* ── 零件档案模板 ───────────────────────────────────
   每种零件写一份工程说明，四个角复用（除前/后腿行程差异）
   ───────────────────────────────────────────────── */
const TEMPLATE = {
  base: {
    code: 'AS2-100',
    name: '机身总成',
    short: '机身',
    mass: MASS.base,
    duty: '主承力结构。四个髋关节座的安装基准，内部容纳电池、主控与 IMU。',
    conn: '作为装配基准固定在工装上。四条腿经 x = ±211.9 mm、y = ±60 mm 的髋座与之连接。',
    removal: '基准件，不参与拆卸。整机分解到「腿总成」为止，是为了保留定位基准 —— 若把机身也拆散，四腿的相对位置就失去参照。',
    tool: '—',
    facts: [
      ['轴距', '423.8 mm'],
      ['髋座轮距', '120 mm'],
      ['整机质量', '20.70 kg'],
      ['腿部占比', '46.0 %'],
    ],
  },

  hip: {
    code: (i) => `AS2-${i}10`,
    name: '髋关节支架',
    short: '髋',
    mass: MASS.hip,
    duty: '连接机身与腿，提供绕机身前后轴的横摆自由度。关节模组容纳在支架内，输出端直接驱动大腿。',
    conn: '以 4 颗螺栓固定在机身的髋座上，输出端与大腿构成绕 x 轴的转动副。',
    removal: '整腿更换的分离点。只需断开线束插头与 4 颗螺栓，不必深入关节内部 —— 这是整机「模块化维修」的关键设计。',
    tool: '内六角 3 mm、线束拔具',
    facts: null,   // 由 joint 数据自动填充
    note: '官方为四个角分别提供独立网格，左右为镜像结构。拆下后成对摆放，避免装回时左右混淆。',
  },

  thigh: {
    code: (i) => `AS2-${i}20`,
    name: '大腿连杆',
    short: '大腿',
    mass: MASS.thigh,
    duty: '主承力连杆，髋—膝间距 212 mm。腿部质量的主要集中处，同时是膝部驱动模组的安装体。',
    conn: '经 y 轴转动副与髋支架连接；膝端经 y 轴转动副与小腿连接。相对髋关节有 105.4 mm 的横向偏置，腿因此在机身外侧展开。',
    removal: '必须在拆下小腿之后。膝端挂着 288 g 的小腿，带载拆轴会让膝部模组承受整段悬臂弯矩。',
    tool: '内六角 2.5 mm、卡簧钳',
    facts: [
      ['杆长 髋→膝', '212.0 mm'],
      ['单腿质量占比', '56.8 %'],
      ['横向偏置', '105.4 mm'],
    ],
    note: '前后腿的关节行程跨度相同（5.49 rad），但区间整体相差 0.70 rad —— 说明前后腿电机的零位安装角不同，大腿不能前后互换。',
  },

  calf: {
    code: (i) => `AS2-${i}30`,
    name: '小腿连杆',
    short: '小腿',
    mass: MASS.calf,
    duty: '膝—足连杆，长 213.44 mm，与大腿几乎等长。轻量化件：只有大腿质量的 21%，用来压低小腿摆动惯量。',
    conn: '经 y 轴转动副与大腿连接，末端承装足端。',
    removal: '拆下膝关节轴端挡圈/销轴后与大腿分离。松开前先托住小腿，让膝部模组不受悬臂载荷。',
    tool: '卡簧钳、内六角 2 mm',
    facts: [
      ['杆长 膝→足', '213.44 mm'],
      ['相对大腿质量', '21.3 %'],
      ['屈曲角跨度', '112 °'],
    ],
    note: '膝关节行程 −2.7677 ~ −0.8133 rad 全部落在负区间，机构上不可能完全伸直 —— 最小也保持 46.6° 屈曲。这是刻意的：避免膝关节进入奇异位形，同时保证膝部始终有足够的力矩臂。',
  },

  foot: {
    code: (i) => `AS2-${i}40`,
    name: '足端',
    short: '足端',
    mass: MASS.foot,
    duty: '弹性接触件。与地面摩擦系数取 μ = 1.0，接触模型等效为半径 28 mm 的球面。',
    conn: '固定在小腿末端（压装或螺钉，推断）。',
    removal: '最先拆下、最后装回。它是磨损件，四只应成套更换 —— 单只更换会让四足触地高度不一致，直接反映为机身姿态偏差。',
    tool: '—（推断为压装/单螺钉）',
    facts: [
      ['等效半径', '28 mm'],
      ['摩擦系数', 'μ = 1.0'],
      ['单腿质量占比', '1.9 %'],
    ],
    note: '足端只有 45 g，却决定了整机的接地刚度与抓地能力，是典型的「小件定性能」部位。',
  },
};

/* ── 生成 17 个零件 ───────────────────────────────── */
export function buildParts() {
  const parts = [];

  parts.push({
    id: 'base',
    type: 'base',
    leg: null,
    code: TEMPLATE.base.code,
    name: TEMPLATE.base.name,
    short: TEMPLATE.base.short,
    mass: TEMPLATE.base.mass,
    joint: null,
    duty: TEMPLATE.base.duty,
    conn: TEMPLATE.base.conn,
    removal: TEMPLATE.base.removal,
    tool: TEMPLATE.base.tool,
    facts: TEMPLATE.base.facts,
    note: '四角零件均为独立建模，左右互为镜像。装配时按方向标识对位，不要强行互换。',
  });

  for (const leg of LEGS) {
    for (const type of ['hip', 'thigh', 'calf', 'foot']) {
      const t = TEMPLATE[type];
      const isFront = leg.sx > 0;
      const joint = jointOf(type, isFront);
      const facts = t.facts ? t.facts.slice() : [];
      if (joint) {
        const r = joint.range;
        facts.unshift(
          ['关节行程', `${r[0].toFixed(3)} ~ ${r[1].toFixed(3)} rad`],
          ['行程跨度', `${(((r[1] - r[0]) * 180) / Math.PI).toFixed(1)} °`],
          ['力矩上限', `±${joint.torque} N·m`],
        );
      }
      parts.push({
        id: `${leg.key}_${type}`,
        type,
        leg: leg.key,
        code: t.code(leg.idx),
        name: `${leg.cn}${t.name}`,
        short: t.short,
        mass: t.mass,
        joint,
        duty: t.duty,
        conn: t.conn,
        removal: t.removal,
        tool: t.tool,
        facts,
        note: t.note || null,
      });
    }
  }
  return parts;
}

/* ── 拆装工艺序列 ───────────────────────────────────
   两段式，符合真实维修逻辑：
   阶段 A 总成级 —— 整条腿从机身分离（4 步）
   阶段 B 零件级 —— 每条腿由末端向根部逐件拆解（12 步）
   ───────────────────────────────────────────────── */
export function buildSequence() {
  const steps = [];

  for (const leg of LEGS) {
    steps.push({
      phase: `A · 整腿拆卸`,
      phaseNo: 'A',
      part: `${leg.key}_hip`,
      title: `拆下${leg.cn}腿总成`,
      tool: '内六角 3 mm、线束拔具',
      note: `断开线束插头 → 对角交替松开 4 颗螺栓 → 整条腿取下。总成重 2.38 kg，取下时托住大腿，别让小臂悬空受力。`,
      tag: 'infer',
    });
  }

  for (const leg of LEGS) {
    const items = [
      ['foot', '拆下足端', '—', '先拆末端件。足端是空心的弹性件，磕碰后容易变形，取下后单独放。'],
      ['calf', '拆下小腿', '卡簧钳、内六角 2 mm', '拆膝关节轴端挡圈，抽出销轴。松手前托住小腿 —— 288 g 挂在膝端，就是一段悬臂。'],
      ['thigh', '拆下大腿', '内六角 2.5 mm', '此时膝端已无附件，可以只手扶住大腿拆轴。拆下后髋支架只剩关节模组本体。'],
    ];
    for (const [type, title, tool, note] of items) {
      steps.push({
        phase: `B · ${leg.cn}腿分解`,
        phaseNo: 'B',
        part: `${leg.key}_${type}`,
        title,
        tool,
        note,
        tag: type === 'foot' ? 'infer' : 'infer',
      });
    }
  }

  steps.forEach((s, i) => (s.index = i));
  return steps;
}

/* ── 结构洞察（全部由上面的实测数据算出）────────────── */
const legMass = MASS.hip + MASS.thigh + MASS.calf + MASS.foot;
const total = MASS.base + legMass * 4;

export const INSIGHTS = [
  {
    k: '自由度',
    v: '12 DOF',
    text: '17 个刚体，靠 12 个驱动关节连成 4 条腿。每条腿是 3 自由度串联开链：髋横摆 → 髋俯仰 → 膝屈伸。足端无自由度，是纯接触点。',
  },
  {
    k: '质量分布',
    v: `${((MASS.base / total) * 100).toFixed(1)} : ${(((legMass * 4) / total) * 100).toFixed(1)}`,
    text: `整机 ${total.toFixed(2)} kg。机身 ${MASS.base.toFixed(2)} kg 占 54%，四条腿合计 ${(legMass * 4).toFixed(2)} kg 占 46%。腿不轻 —— 这是为了把驱动电机放进腿里，缩短传动链。`,
  },
  {
    k: '单腿构成',
    v: '大腿 56.8%',
    text: `一条腿 ${legMass.toFixed(3)} kg：大腿 ${MASS.thigh} kg（56.8%）、髋 ${MASS.hip} kg（29.2%）、小腿 ${MASS.calf} kg（12.1%）、足端 ${MASS.foot} kg（1.9%）。质量集中在大腿，腿部摆动惯量基本由它决定。`,
  },
  {
    k: '膝关节行程',
    v: '−2.768 ~ −0.813 rad',
    text: '区间全为负，跨度 112°，意味着膝关节在机构上不可能完全伸直，最小也保持 46.6° 屈曲。这样膝关节永远不会落到奇异位形上，力矩臂始终不为零。',
  },
  {
    k: '前后腿差异',
    v: '零位差 0.70 rad',
    text: '前腿大腿关节 −2 ~ 3.492 rad，后腿 −1.3 ~ 4.19 rad。两者行程跨度都是 5.49 rad，区间却整体相差 0.699 rad —— 前后腿电机的零位安装角不同，因此前后腿零件不能互换。',
  },
  {
    k: '膝部载荷',
    v: '90 N·m',
    text: '膝关节力矩上限 90 N·m，髋与髋俯仰关节都是 60 N·m。膝关节要同时承担机身载荷与落地冲击，是整机最重载的关节。',
  },
  {
    k: '支撑宽度',
    v: '331 mm',
    text: '髋关节左右间距只有 120 mm，但大腿有 105.4 mm 的横向偏置，足端横向间距达到 331 mm —— 支撑多边形被放大到髋距的 2.76 倍，这是四足机器人抗侧向倾覆的基本手段。',
  },
  {
    k: '杆长匹配',
    v: '212 : 213.4 mm',
    text: '大腿与小腿几乎等长（相差 0.7%），膝部居中折叠。这种对称布置让腿在折叠时占位短、展开时行程大，是四足腿型的常见比例。',
  },
];

/* ── 数据来源声明 ───────────────────────────────── */
export const SOURCE_NOTE = {
  verified: '几何、质量、关节行程、力矩上限、阻尼与转子惯量、足端摩擦系数，均取自宇树官方 MJCF（unitree_mujoco / unitree_robots / as2）。',
  infer: '材料、紧固件规格、拆卸工具与工艺顺序为工程推断，页面以「推断」标注。实际维修请以宇树官方维修手册为准。',
};
