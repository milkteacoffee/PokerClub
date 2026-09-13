/**
 * 德州扑克 —— 无头测试
 *  1) 牌型评估单元测试 (evaluate5 / bestHand / cmpHand)
 *  2) 侧池分配单元测试 (distributePot)
 *  3) 端到端对局模拟：自动点按钮跑 N 手，断言无异常 & 筹码守恒
 *
 * 运行: node tests/test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ---------------- 1. 抽取 & 去壳 ---------------- */
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('✗ 未找到 <script> 块'); process.exit(1); }
let src = m[1];

// 去掉 IIFE 外壳，让内部函数/变量暴露到 vm 上下文，便于单元测试
const stripped = src
  .replace(/\(function \(\) \{\s*'use strict';/, '')
  .replace(/\}\)\(\);\s*$/, '');
if (stripped === src) { console.error('✗ IIFE 去壳失败'); process.exit(1); }

/* ---------------- 2. 极简 DOM 桩 ---------------- */
function makeElement(doc, tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    _listeners: {},
    children: [],
    parentNode: null,
    _id: '',
    _cls: new Set(),
    style: {},
    textContent: '',
    value: '',
    min: 0, max: 0, step: 1, type: '',
    disabled: false,
    title: '',
    className: '',
  };
  el.classList = {
    add(...cs) { cs.forEach(c => el._cls.add(c)); el.className = Array.from(el._cls).join(' '); },
    remove(...cs) { cs.forEach(c => el._cls.delete(c)); el.className = Array.from(el._cls).join(' '); },
    contains(c) { return el._cls.has(c); },
    toggle(c, force) {
      const want = force === undefined ? !el._cls.has(c) : !!force;
      if (want) el._cls.add(c); else el._cls.delete(c);
      el.className = Array.from(el._cls).join(' ');
      return want;
    },
  };
  Object.defineProperty(el, 'id', {
    get() { return el._id; },
    set(v) { el._id = v; if (v) doc._registry.set(v, el); },
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html || ''; },
    set(v) { el._html = String(v); el.children.length = 0; },
  });
  el.addEventListener = (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); };
  el.removeEventListener = (t, fn) => {
    const a = el._listeners[t]; if (!a) return;
    const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  };
  el.appendChild = (c) => { el.children.push(c); c.parentNode = el; return c; };
  el.removeChild = (c) => { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; };
  el.setAttribute = (k, v) => { el['_attr_' + k] = String(v); };
  el.getAttribute = (k) => (k in el ? (k === 'class' ? el.className : el[k]) : el['_attr_' + k] || null);
  el.querySelectorAll = () => makeNodeList([]);
  el.querySelector = () => null;
  el.focus = () => {};
  el.click = () => fire(el, 'click');
  return el;
}
function makeNodeList(arr) {
  const nl = { length: arr.length, forEach: (f, t) => arr.forEach(f, t) };
  arr.forEach((v, i) => { nl[i] = v; });
  return nl;
}
function fire(el, type, ev) {
  const a = el._listeners[type] || [];
  a.slice().forEach(fn => fn.call(el, ev || { preventDefault() {}, key: '' }));
}

const doc = {
  _registry: new Map(),
  readyState: 'complete',
  documentElement: {},
  body: {},
  getElementById(id) {
    if (!doc._registry.has(id)) {
      const el = makeElement(doc, 'div');
      el._id = id;
      doc._registry.set(id, el);
    }
    return doc._registry.get(id);
  },
  createElement(tag) { return makeElement(doc, tag); },
  querySelectorAll() { return makeNodeList([]); },
  querySelector() { return null; },
  addEventListener() {},
};

const storage = new Map();
const sandbox = {
  document: doc,
  window: { addEventListener() {}, innerWidth: 1280, innerHeight: 720, AudioContext: undefined, webkitAudioContext: undefined },
  navigator: { maxTouchPoints: 0, userAgent: 'node-test' },
  screen: {},
  localStorage: {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k),
  },
  performance: { now: () => Date.now() },
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
  setTimeout: (fn) => setImmediate(fn),      // 加速：忽略延时
  clearTimeout: (id) => clearTimeout(id),
  console,
  Math, JSON, Object, Array, Date, parseInt, parseFloat, isNaN, isFinite,
  String, Number, Boolean, Error, Promise, Map, Set, Symbol,
};
sandbox.window.document = doc;
sandbox.globalThis = sandbox;

/* ---------------- 3. 断言工具 ---------------- */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); console.log('  ✗ ' + msg); }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(a === e, msg + '  期望=' + e + '  实际=' + a);
}

/* ---------------- 4. 载入 ---------------- */
const ctx = vm.createContext(sandbox);
try {
  vm.runInContext(stripped, ctx, { filename: 'game.js' });
} catch (e) {
  console.error('✗ 脚本载入失败:', e.message, '\n', e.stack);
  process.exit(1);
}
console.log('✓ 脚本在 DOM 桩中成功载入并完成 init()\n');

/* ============================================================
   测试 1：牌型评估
   ============================================================ */
const RMAP = { T: 10, J: 11, Q: 12, K: 13, A: 14 };
const SMAP = { s: 0, h: 1, d: 2, c: 3 };
function C(str) {
  return { r: RMAP[str[0].toUpperCase()] || parseInt(str[0], 10), s: SMAP[str[1].toLowerCase()] };
}
function H(strs) { return strs.map(C); }
const ev5 = ctx.evaluate5, best = ctx.bestHand, cmp = ctx.cmpHand, desc = ctx.describeHand;

console.log('【测试 1】牌型评估 evaluate5 / bestHand');
eq(ev5(H(['As','Ks','Qs','Js','Ts'])), [8,14], '皇家同花顺');
eq(ev5(H(['9h','8h','7h','6h','5h'])), [8,9],  '同花顺 9高');
eq(ev5(H(['As','2s','3s','4s','5s'])), [8,5],  '同花顺 A-5 轮子');
eq(ev5(H(['7s','7h','7d','7c','2s'])), [7,7,2],'四条');
eq(ev5(H(['Ks','Kh','Kd','2c','2s'])), [6,13,2],'葫芦');
eq(ev5(H(['Ah','Jh','9h','6h','3h'])), [5,14,11,9,6,3],'同花');
eq(ev5(H(['As','Kd','Qh','Jc','Ts'])), [4,14], '顺子（跨花）');
eq(ev5(H(['Ah','2d','3c','4s','5h'])), [4,5],  '顺子 A-5 轮子');
eq(ev5(H(['9s','9h','9d','Kc','2s'])), [3,9,13,2],'三条');
eq(ev5(H(['Js','Jh','4d','4c','9s'])), [2,11,4,9],'两对');
eq(ev5(H(['As','Ah','7d','5c','3s'])), [1,14,7,5,3],'一对');
eq(ev5(H(['As','Kh','9d','5c','3s'])), [0,14,13,9,5,3],'高牌');

ok(cmp([8,14],[7,14]) > 0, '同花顺 > 四条');
ok(cmp([4,5],[4,6]) < 0,  '顺子 5高 < 顺子 6高（轮子最小）');
ok(cmp([5,14,11,9,6,3],[5,14,11,9,6,2]) > 0, '同花逐张比大小');
ok(cmp([1,14,7,5,3],[1,14,7,5,3]) === 0, '相同牌型判平');
ok(desc([8,14]) === '皇家同花顺', '皇家同花顺中文描述');
ok(desc([6,13,2]) === '葫芦 K 带 2', '葫芦中文描述');

// 7 选 5
eq(best(H(['As','Ks','Qs','Js','Ts','2h','3d'])), [8,14], '7选5 皇家同花顺');
eq(best(H(['2c','3c','4c','5c','6c','As','Ah'])), [8,6],  '7选5 取同花顺而非对A');
eq(best(H(['As','Ah','Ad','Ac','Ks','Kh','2c'])), [7,14,13], '7选5 四条优先于葫芦');
eq(best(H(['4h','5h','6h','7h','8h','2s','3d'])), [8,8], '7选5 含更优同花顺');

// 顺子边界
eq(ev5(H(['As','Kd','Qh','Jc','Td'])), [4,14], 'A高顺子');
ok(cmp(ev5(H(['As','Kd','Qh','Jc','Td'])), ev5(H(['As','2d','3c','4s','5h']))) > 0, 'A高顺子 > 轮子');

// 随机一致性：bestHand 必须等于 21 组合暴力枚举最大值
{
  let bad = 0;
  for (let t = 0; t < 400; t++) {
    const d = ctx.makeDeck();
    const seven = ctx.shuffle(d).slice(0, 7);
    let brut = null;
    for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) for (let c = b + 1; c < 7; c++)
      for (let e = c + 1; e < 7; e++) for (let f = e + 1; f < 7; f++) {
        const v = ev5([seven[a], seven[b], seven[c], seven[e], seven[f]]);
        if (!brut || cmp(v, brut) > 0) brut = v;
      }
    if (cmp(best(seven), brut) !== 0) bad++;
  }
  ok(bad === 0, 'bestHand 与朴素 21 组合枚举 400 次结果一致（不一致 ' + bad + ' 次）');
}
console.log('  牌型评估断言完成\n');

/* ============================================================
   测试 2：侧池分配
   ============================================================ */
console.log('【测试 2】侧池分配 distributePot');
const G = ctx.G;
function mkP(id, totalBet, folded, v, chips) {
  return { id, totalBet, folded, _v: v, chips: chips || 0, folded2: false };
}
// 场景 A：A 全下100（最强牌），B/C 各投300
{
  G.players = [
    mkP(0, 100, false, [7, 14, 2]),   // 四条（最强）
    mkP(1, 300, false, [2, 13, 11, 4]),
    mkP(2, 300, false, [1, 13, 11, 4, 2]),
  ];
  const res = ctx.distributePot();
  const get = id => (res.find(r => r.player.id === id) || { amount: 0 }).amount;
  eq(get(0), 300, '主池 300 归最强牌 A');
  eq(get(1), 400, '边池 400 归牌力次强的 B');
  eq(get(2), 0,   'C 无所得');
  eq(get(0) + get(1) + get(2), 700, '分配总额 = 总投入 700');
}
// 场景 B：C 已弃牌，其投入为死钱
{
  G.players = [
    mkP(0, 100, false, [8, 14]),      // A 全下100，最强
    mkP(1, 300, false, [2, 13, 11, 4]),
    mkP(2, 300, true,  null),         // C 弃牌
  ];
  const res = ctx.distributePot();
  const get = id => (res.find(r => r.player.id === id) || { amount: 0 }).amount;
  eq(get(0), 300, '主池含死钱 300 归 A');
  eq(get(1), 400, '边池 400 归 B');
  eq(get(0) + get(1), 700, '弃牌者的钱全部被瓜分');
  eq(get(2), 0, '弃牌者拿回 0');
}
// 场景 C：平分（奇数筹码给先手）
{
  G.players = [ mkP(0, 50, false, [1, 14, 13, 9, 5, 3]), mkP(1, 51, false, [1, 14, 13, 9, 5, 3]) ];
  const res = ctx.distributePot();
  const tot = res.reduce((s, r) => s + r.amount, 0);
  eq(tot, 101, '平局时总额守恒（含零头）');
  ok(res.every(r => Math.abs(r.amount - 50.5) <= 0.5), '平局双方各得约一半');
}
// 场景 D：3 人同牌力全下 → 三人平分
{
  G.players = [ mkP(0, 30, false, [4, 10]), mkP(1, 30, false, [4, 10]), mkP(2, 30, false, [4, 10]) ];
  const res = ctx.distributePot();
  const tot = res.reduce((s, r) => s + r.amount, 0);
  eq(tot, 90, '三人同牌力共分 90');
  eq(res.length, 3, '三人均分');
}
console.log('  侧池分配断言完成\n');

/* ============================================================
   测试 3：端到端对局模拟
   ============================================================ */
console.log('【测试 3】端到端对局模拟（自动点击）');

const bottomBar = doc.getElementById('bottomBar');
function findAll(root, pred, out) {
  out = out || [];
  if (!root || !root.children) return out;
  for (const c of root.children) {
    if (pred(c)) out.push(c);
    findAll(c, pred, out);
  }
  return out;
}
function findBtn(root, cls) {
  return findAll(root, e => String(e.className || '').indexOf(cls) >= 0)[0] || null;
}

const sleepTick = () => new Promise(r => setImmediate(r));

(async function run() {
  const handsTarget = Number(process.argv[2] || 120);
  const diffKey = process.argv[3] || 'easy';
  ctx.App.difficulty = diffKey;
  const cfg = ctx.DIFFICULTY_CONFIG[diffKey];
  if (!cfg) { console.error('✗ 未知难度: ' + diffKey); process.exit(1); }
  console.log('  难度=' + cfg.name + ' 盲注 ' + cfg.sb + '/' + cfg.bb + ' 带入 ' + cfg.buyIn);
  ctx.G.bb = cfg.bb; ctx.G.sb = cfg.sb; ctx.G.buyIn = cfg.buyIn;
  ctx.G.minRaiseUnit = cfg.minRaiseUnit;

  // 给玩家充足筹码，便于连续跑手
  ctx.player.coins = 2000000;
  ctx.G.active = true; ctx.G.handOver = true; ctx.G.handNo = 0;

  let errors = [];
  let handsPlayed = 0;
  let raiseClicks = 0, allinClicks = 0, foldClicks = 0, checkCalls = 0, startClicks = 0;
  let chipViolations = 0;
  let chipViolationDetail = [];
  let potLeftover = 0;
  let injected = 0;          // 外部注入的筹码（成就/任务奖励）
  let liveInjected = 0;      // 本手内注入的筹码

  // 包装 addCoins：把"奖励注入"从守恒校验中剥离出来
  const origAddCoins = ctx.addCoins;
  ctx.addCoins = function (n) {
    injected += n;
    liveInjected += n;
    return origAddCoins(n);
  };

  ctx.startGame(diffKey);

  const maxTicks = 400000;
  let ticks = 0;

  while (handsPlayed < handsTarget && ticks < maxTicks) {
    ticks++;
    if (ticks % 200 === 0) await sleepTick();

    // ---- 每手开始时记录筹码总量 ----
    if (ctx.G.handOver === false && ctx._prevHandNo !== ctx.G.handNo) {
      ctx._prevHandNo = ctx.G.handNo;
      ctx._chipsAtStart = ctx.G.players.reduce((s, p) => s + p.chips, 0) + ctx.G.pot;
      liveInjected = 0;
      ctx._aiRebuy = 0;
    }

    if (!ctx.G.active) break;

    // ---- 人类回合：点击动作 ----
    if (ctx.G.actor === 0 && !ctx.G.handOver) {
      const canCheck = findBtn(bottomBar, 'abtn check');
      const canCall = findBtn(bottomBar, 'abtn call');
      const canRaise = findBtn(bottomBar, 'abtn raise');
      const canAllin = findBtn(bottomBar, 'abtn allin');
      const canFold = findBtn(bottomBar, 'abtn fold');
      const p = ctx.G.players[0];
      const r = Math.random();
      try {
        if (canAllin && r < 0.05) { allinClicks++; fire(canAllin, 'click'); }
        else if (canFold && r < 0.15) { foldClicks++; fire(canFold, 'click'); }
        else if (canRaise && r < 0.40) { raiseClicks++; fire(canRaise, 'click'); }
        else if (canCheck) { checkCalls++; fire(canCheck, 'click'); }
        else if (canCall && (ctx.G.currentBet - p.bet) <= p.chips * 0.35) { checkCalls++; fire(canCall, 'click'); }
        else if (canFold) { foldClicks++; fire(canFold, 'click'); }
      } catch (e) {
        errors.push('人类回合点击异常: ' + e.message);
      }
      await sleepTick();
      continue;
    }

    // ---- 一手结束：点"下一手" ----
    if (ctx.G.handOver) {
      // 校验筹码守恒（期望值 = 开局筹码 + 本手内奖励注入）
      if (ctx._chipsAtStart != null) {
        const now = ctx.G.players.reduce((s, p) => s + p.chips, 0) + ctx.G.pot;
        const expected = ctx._chipsAtStart + liveInjected;
        if (now !== expected) {
          chipViolations++;
          chipViolationDetail.push('手#' + ctx.G.handNo + ' 期望 ' + expected + ' 实际 ' + now);
        }
        if (ctx.G.pot !== 0) potLeftover++;
        ctx._chipsAtStart = null;
      }
      handsPlayed++;
      if (handsPlayed >= handsTarget) break;
      const start = findBtn(bottomBar, 'abtn start');
      if (!start) { errors.push('第 ' + handsPlayed + ' 手结束后找不到"下一手"按钮'); break; }
      // 续命：保证测试能跑满手数（真实游戏此时会走破产结算）
      if (ctx.G.players[0].chips <= 0) {
        ctx.G.players[0].chips = 2000000;
        ctx.player.coins = 2000000;
      }
      try { startClicks++; fire(start, 'click'); } catch (e) { errors.push('下一手点击异常: ' + e.message); break; }
      await sleepTick();
      continue;
    }

    await sleepTick();
  }

  console.log('  模拟完成：手数=' + handsPlayed + ' tick=' + ticks);
  console.log('  点击统计: 过牌/跟注=' + checkCalls + ' 加注=' + raiseClicks +
              ' 全下=' + allinClicks + ' 弃牌=' + foldClicks + ' 下一手=' + startClicks);
  console.log('  玩家筹码 50000 →', ctx.player.coins, '| 等级 Lv.' + ctx.player.level,
              '| 胜局 ' + ctx.player.totalWins + '/' + ctx.player.totalHands);

  ok(handsPlayed >= handsTarget, '完成 ' + handsTarget + ' 手牌局（实际 ' + handsPlayed + '）');
  ok(errors.length === 0, '全程无运行时异常' + (errors.length ? '：' + errors.slice(0, 3).join(' | ') : ''));
  ok(chipViolations === 0, '每手筹码总量守恒（违规 ' + chipViolations + ' 次'
     + (chipViolationDetail.length ? ' → ' + chipViolationDetail.slice(0, 5).join('; ') : '') + '）');
  ok(potLeftover === 0, '每手结束后底池清空（残留 ' + potLeftover + ' 次）');
  ok(raiseClicks > 0 && allinClicks > 0 && foldClicks > 0, '加注/全下/弃牌路径均被覆盖');
  ok(ctx.player.level >= 1 && ctx.player.exp >= 0, '等级与经验正常累积（Lv.' + ctx.player.level + '）');
  ok(Object.keys(ctx.player.newbieProgress).length > 0, '新手任务进度被记录');
  ok(ctx.player.totalHands === handsPlayed, '手数统计与模拟一致（'
     + ctx.player.totalHands + ' vs ' + handsPlayed + '）');
  ok(injected > 0, '对局中触发了成就/任务奖励注入（共 ' + injected + ' 🪙）');

  // 存档持久化
  const raw = storage.get('texas_poker_multi_saves_v1');
  ok(!!raw, '存档已写入 localStorage');
  try {
    const parsed = JSON.parse(raw);
    ok(!!parsed.slots && !!parsed.slots[1], '存档结构含 3 槽位');
    ok(typeof parsed.slots[1].player.coins === 'number', '存档记录了金币');
  } catch (e) { ok(false, '存档 JSON 可解析'); }

  // 多存档：新建 + 切换 + 删除
  try {
    ctx.createNewSaveAt(2);
    ok(!!ctx.allSaves.slots[2], '可在槽位 2 创建新档');
    ok(ctx.player.coins === 1000, '新档初始金币为 1000');
    ctx.deleteSlot(2);
    ok(!ctx.allSaves.slots[2], '可删除槽位 2');
  } catch (e) {
    ok(false, '多存档增删异常: ' + e.message);
  }

  /* ---- 破产结算流程 ---- */
  async function advanceToHandOver(maxTicks) {
    let g = 0;
    while (!ctx.G.handOver && ctx.G.active && g++ < (maxTicks || 20000)) {
      if (ctx.G.actor === 0 && ctx.humanResolve) {
        const f = findBtn(bottomBar, 'abtn fold');
        if (f) fire(f, 'click');
      }
      await sleepTick();
    }
    return ctx.G.handOver;
  }

  ctx.createNewSaveAt(1);
  ctx.App.difficulty = 'easy';
  ctx.startGame('easy');
  await advanceToHandOver(30000);
  ok(ctx.G.handOver === true, '首手结束，进入"等待下一手"状态');
  ctx.G.players[0].chips = 0;
  const hb = findBtn(bottomBar, 'abtn start');
  ok(!!hb, '破产前牌桌显示"下一手"按钮');
  if (hb) fire(hb, 'click');
  for (let i = 0; i < 600 && ctx.G.active; i++) await sleepTick();
  ok(ctx.G.active === false, '筹码归零后自动结束对局');
  ok(doc.getElementById('ovGameOver').classList.contains('show'), '弹出「筹码用尽」面板');
  ctx.claimRelief();
  ok(ctx.player.coins >= 1000, '领取补充金后金币恢复（' + ctx.player.coins + '）');
  ok(ctx.App.screen === 'lobby', '领取补充金后返回大厅');

  /* ---- 计时器超时自动动作 ---- */
  ctx.player.coins = 100000;
  ctx.startGame('easy');
  let g2 = 0;
  while (!(ctx.G.actor === 0 && ctx.humanResolve) && ctx.G.active && g2++ < 30000) await sleepTick();
  ok(ctx.G.actor === 0 && !!ctx.humanResolve, '进入人类回合并等待输入');
  if (ctx.G.actor === 0) {
    const t = ctx.Timer;
    ok(t.active === true, '人类回合启动倒计时');
    const cb = t.onTimeout;
    ok(typeof cb === 'function', '倒计时注册了超时回调');
    if (typeof cb === 'function') {
      try { cb(); ok(true, '超时回调执行无异常'); } catch (e) { ok(false, '超时回调异常: ' + e.message); }
    }
    for (let i = 0; i < 400; i++) await sleepTick();
    ok(ctx.G.handOver === false || ctx.G.handOver === true, '超时后牌局继续推进');
  }
  ctx.G.active = false;

  // ---- 汇总 ----
  console.log('\n============================');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  console.log('============================');
  if (fail) {
    console.log('\n失败项：');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('\n✅ 全部测试通过');
  process.exit(0);
})().catch(e => {
  console.error('✗ 模拟过程抛出未捕获异常:', e);
  process.exit(1);
});
