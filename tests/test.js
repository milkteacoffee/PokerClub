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
  ok(injected === 0, '新版成就需手动领取，不在对局自动注币');

  // 存档持久化
  const raw = storage.get(ctx.SAVE_KEY_ALL);
  ok(!!raw, '存档已写入 localStorage');
  try {
    const parsed = JSON.parse(raw);
    ok(!!parsed.slots && !!parsed.slots[1], '存档结构含 3 槽位');
    ok(typeof parsed.slots[1].player.coins === 'number', '存档记录了金币');
  } catch (e) { ok(false, '存档 JSON 可解析'); }

  // 多存档：新建 + 切换 + 删除
  try {
    ctx.G.active = false;
    ctx.createNewSaveAt(2);
    ok(!!ctx.allSaves.slots[2], '可在槽位 2 创建新档');
    ok(ctx.player.coins === 500 && ctx.START_COINS === 500, '单机新档直接获得500金币');
    ctx.deleteSlot(2);
    ok(!ctx.allSaves.slots[2], '可删除槽位 2');
  } catch (e) {
    ok(false, '多存档增删异常: ' + e.message);
  }

  /* ============================================================
     测试 4：v11 生态新系统（段位 / 签到 / 周常 / 商城 / 图鉴 / BGM）
     ============================================================ */
  console.log('【测试 4】v12 生态新系统（含结算与排位入场）');
  ctx.G.active = false;   // 停掉上一轮对局，避免干扰

  /* ---- 段位 ---- */
  ctx.createNewSaveAt(1);
  ok(ctx.player.rankPoints === 0 && ctx.player.rankTier === 0, '新档段位从青铜 0 分开始');
  ok(ctx.player.rankedPoints === 0 && ctx.player.games && ctx.player.games.holdem.redeemPoints === 0, '新档不预发排位兑换积分，四游戏资产独立');
  ctx.player.name = '自定义牌手';
  ok(ctx.player.name === '自定义牌手', '用户名称可自定义并写入玩家存档');
  ctx.player.coins = 500; // 单机初始余额
  var rankCoins = ctx.player.coins;
  ok(ctx.spendCoins(100) === true, '金币扣除底层接口可用');
  ctx.player.coins = rankCoins;
  ok(ctx.exchangePoints('holdem','buy',1) === false && ctx.player.coins === rankCoins, '金币不能购买积分，积分只能靠排位赢取');
  ctx.profile15('holdem').redeemPoints = 1; // 模拟排位赢得的积分
  ok(ctx.exchangePoints('holdem','sell',1) === true && ctx.player.coins === rankCoins + 100 && ctx.profile15('holdem').redeemPoints === 0, '1个排位积分可兑换100金币');
  ctx.addRankPoints(1000);                      // 每 1000 分升一个大段位
  ok(ctx.rankTierFor(ctx.player.rankPoints) === 1, '积分 1000 升第 2 档');
  ok(ctx.rankInfo().name === '读牌学徒 III', 'rankInfo 返回「读牌学徒 III」（大段位 + 小段位）');
  var coinsBeforeRank = ctx.player.coins;
  ctx.addRankPoints(1000);                      // 2000 → 黄金
  ok(ctx.rankTierFor(ctx.player.rankPoints) === 2, '积分 2000 升第 3 档');
  ok(ctx.rankInfo().name === '老练牌手 III', 'rankInfo 跟随小段位');
  ok(ctx.player.coins === coinsBeforeRank,
     '升段不直接发放金币（' + coinsBeforeRank + ' → ' + ctx.player.coins + '）');
  ctx.addRankPoints(-99999);
  ok(ctx.player.rankPoints === 0, '积分不会低于 0');
  ok(ctx.rankTierFor(0) === 0, '0 分回落青铜');
  ok(ctx.player.rankPeak === 2, '历史最高段位保留为黄金');

  /* ---- 每日签到 ---- */
  ctx.createNewSaveAt(1);
  ctx.ensureCheckin();
  ok(ctx.player.checkin.streak === 1, '首次签到连续天数 = 1');
  ok(ctx.hasCheckinClaimable() === true, '首日可领取');
  var c0 = ctx.player.coins;
  ctx.claimCheckin();
  var ci1 = ctx.CHECKIN_REWARDS[0];
  ok(ctx.player.coins === c0 + ci1, '领取第 1 天奖励 ' + ci1 + '（' + c0 + ' → ' + ctx.player.coins + '）');
  ok(ctx.hasCheckinClaimable() === false, '领取后不可再领');
  ok(ctx.claimCheckin() === false, '重复领取被拒绝');
  ok(ctx.checkinRewardOf(7) === ctx.CHECKIN_REWARDS[6], '第 7 天奖励 ' + ctx.CHECKIN_REWARDS[6]);
  ok(ctx.checkinRewardOf(8) === ci1, '第 8 天循环回第 1 档');
  ok(ctx.CHECKIN_REWARDS.length === 7 && ci1 >= 100, '签到额度已上调：首档 ' + ci1 + '，7 天共 '
    + ctx.CHECKIN_REWARDS.reduce(function (a, b) { return a + b; }, 0));
  ctx.player.checkin = { date: '2000-01-01', streak: 5, claimed: true };
  ctx.ensureCheckin();
  ok(ctx.player.checkin.streak === 1, '断签后连续天数重置为 1');

  /* ---- 周常挑战 ---- */
  ctx.createNewSaveAt(1);
  ctx.ensureWeekly();
  ok(!!ctx.player.weekly && !!ctx.player.weekly.week,
     '周常已初始化，周键 = ' + (ctx.player.weekly && ctx.player.weekly.week));
  ok(ctx.weekKeyOf('2026-09-13') === '2026-09-07', '2026-09-13（周日）归属周键 2026-09-07');
  ok(ctx.weekKeyOf('2026-09-14') === '2026-09-14', '2026-09-14（周一）开启新周');
  var weeklyTask = ctx.WEEKLY_TASKS.find(function(t){return t.game==='holdem'&&t.event==='hands';});
  ctx.recordGrowth15('holdem',{hands:10},'easy');
  ok(ctx.player.weekly.progress[weeklyTask.id] === 10, '德州周常准确累计10局');
  ok(ctx.checkWeeklyHasClaimable() === false, '未达15局不可领取');
  ctx.recordGrowth15('holdem',{hands:5},'easy');
  ok(ctx.checkWeeklyHasClaimable() === true, '达到15局出现可领取提醒');
  var cWeekly = ctx.player.coins;
  ok(ctx.claimWeekly(weeklyTask.id) === true, '达标周常领取成功');
  ok(ctx.player.coins === cWeekly + weeklyTask.reward, '周常奖励金额准确');
  ok(ctx.claimWeekly(weeklyTask.id) === false, '周常不可重复领取');

  /* ---- 商城与道具 ---- */
  ctx.createNewSaveAt(1);
  ctx.player.coins = 50000;
  ok(ctx.buyItem('cb_gold').ok === true, '购买鎏金牌背成功');
  ok(ctx.player.coins === 48000, '扣除 2,000 金币');
  ok(ctx.hasItem('cb_gold') === true, '背包记录已拥有');
  ok(ctx.buyItem('cb_gold').ok === false, '外观不可重复购买');
  ctx.equipItem('cb_gold');
  ok(ctx.isEquipped('cb_gold') === true, '装备成功');
  ok(ctx.cardBackClass().indexOf('back-gold') >= 0, '牌背样式生效：' + ctx.cardBackClass());
  ctx.equipItem('cb_gold');
  ok(ctx.isEquipped('cb_gold') === false, '再次点击卸下');
  ctx.player.coins = 100;
  var poor = ctx.buyItem('t_dragon');
  ok(poor.ok === false && poor.msg.indexOf('金币不足') >= 0, '金币不足时购买被拒');
  ctx.player.coins = 50000;
  ctx.buyItem('peek3');
  ok(ctx.player.buffs.peek === 0, '购买透视卡不直接加 buff');
  ok(ctx.useItem('peek3').ok === true && ctx.player.buffs.peek === 3, '使用透视卡 +3 次');
  ok((ctx.player.inventory['peek3'] || 0) === 0, '使用后库存清空');
  ctx.buyItem('revive');
  ok(ctx.useItem('revive').ok === false, '复活券不可手动使用（破产时自动生效）');
  ctx.buyItem('exp2x');
  ctx.useItem('exp2x');
  ok(ctx.player.buffs.exp2x === 10, '双倍经验卡生效 10 手');
  ok(ctx.useItem('exp2x').ok === false, '双倍经验生效中不可重复使用');
  ctx.equipItem('t_shark');
  ok(ctx.titleText() === '', '未购买称号时无称号文本');
  ctx.player.coins = 50000;
  ctx.buyItem('t_shark');
  ctx.equipItem('t_shark');
  ok(ctx.titleText() === '牌桌鲨鱼', '装备称号后文本正确：' + ctx.titleText());

  /* ---- 图鉴与统计 ---- */
  ctx.createNewSaveAt(1);
  ctx.recordDex(5); ctx.recordDex(5); ctx.recordDex(8);
  ok(ctx.player.handDex[5] === 2, '同花图鉴计数 2');
  ok(ctx.player.handDex[8] === 1, '同花顺图鉴计数 1');
  ok(ctx.dexUnlocked() === 2, '已解锁 2 种牌型');
  ctx.bumpStat('vpipTotal', 4);
  ctx.bumpStat('vpip', 2);
  ok(ctx.statPct(2, 4) === '50%', 'statPct 比例计算正确');
  ok(ctx.player.stats.vpipTotal === 4, '统计字段累加');

  /* ---- 程序化 BGM ---- */
  ok(!!ctx.TRACKS.lobby && ctx.TRACKS.lobby.bars.length === 8, '大厅曲目含 8 小节和声进行（A/B 段）');
  ['easy', 'normal', 'hard', 'champion'].forEach(function (k) {
    ok(!!ctx.TRACKS[k], '存在 ' + k + ' 场次曲目');
    ok(ctx.TRACKS[k].bars.length === 8, k + ' 场次为 8 小节');
    ok(ctx.TRACKS[k].melA.length === 16 && ctx.TRACKS[k].melB.length === 16,
       k + ' 场次 A/B 段旋律各 16 格');
    ok(!!ctx.DRUMS[ctx.TRACKS[k].drums], k + ' 场次鼓组型存在：' + ctx.TRACKS[k].drums);
  });
  ok(!!ctx.DRUMS.brush && ctx.DRUMS.brush.ride.length === 16, '爵士鼓组含 16 步叮叮镲型');
  ok(ctx.TRACKS.lobby.swing > 0 && ctx.TRACKS.champion.swing === 0,
     '大厅有摇摆律动、冠军场为直拍');
  ok(ctx.TRACKS.lobby.keys === 'rhodes', '大厅使用电钢音色');

  /* ---- 外置音频接管层 ---- */
  ok(typeof ctx.bgmPlay === 'function' && typeof ctx.bgmStop === 'function',
     'BGM 门面函数 bgmPlay / bgmStop 存在');
  ok(typeof ctx.bgmSourceLabel() === 'string', 'bgmSourceLabel 返回来源说明：' + ctx.bgmSourceLabel());
  ok(!!ctx.BGM_FILES.lobby && ctx.BGM_FILES.lobby[0] === 'bgm-lobby.mp3',
     '大厅外置音频文件名约定为 bgm-lobby.mp3');
  ok(ctx.BGM_FILES.lobby[0] !== ctx.BGM_FILES.table[0],
     '主界面与牌桌使用不同的外置音频文件');
  // 无 assets 文件时的回落行为在装配假 AudioContext 之后单独验证（见下）
  ok(ctx.TRACKS.champion.tempo > ctx.TRACKS.easy.tempo,
     '冠军场节奏快于简单场（' + ctx.TRACKS.champion.tempo + ' > ' + ctx.TRACKS.easy.tempo + '）');
  ok(Math.abs(ctx.NOTE['A4'] - 440) < 0.01, '音名表 A4 = 440Hz');
  ok(Math.abs(ctx.NOTE['C4'] - 261.63) < 0.05, '音名表 C4 ≈ 261.63Hz');
  try {
    ctx.Music.play('lobby');
    ctx.Music.stop();
    ctx.unlockAudio();
    ok(true, '无 AudioContext 环境下 Music / unlockAudio 调用安全');
  } catch (e) {
    ok(false, 'Music 调用异常：' + e.message);
  }

  /* ---- 用可控时钟的假 AudioContext 驱动调度器 ---- */
  function FakeParam() { this.value = 0; }
  ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime']
    .forEach(function (m) { FakeParam.prototype[m] = function () { return this; }; });
  function FakeNode(ctx) {
    this.gain = new FakeParam(); this.frequency = new FakeParam();
    this.Q = new FakeParam(); this.type = ''; this.buffer = null;
  }
  FakeNode.prototype.connect = function () {};
  FakeNode.prototype.start = function () { this._ctx.started++; };
  FakeNode.prototype.stop = function () {};
  function FakeAC() {
    this.currentTime = 0; this.sampleRate = 48000; this.state = 'running';
    this.started = 0; this.buffers = 0;
    var self = this;
    this.destination = new FakeNode(this);
    ['createGain', 'createOscillator', 'createBiquadFilter', 'createBufferSource',
     'createConvolver'].forEach(function (m) {
      self[m] = function () { var n = new FakeNode(self); n._ctx = self; return n; };
    });
  }
  FakeAC.prototype.createBuffer = function (ch, len) {
    this.buffers++;
    return { getChannelData: function () { return new Float32Array(len); } };
  };
  FakeAC.prototype.resume = function () { this.state = 'running'; };

  var savedST = ctx.setTimeout;
  ctx.setTimeout = function () { return 0; };          // 禁止调度器自我续期，改为手动驱动
  try {
    ctx.window.AudioContext = FakeAC;
    ctx.audioCtx = null; ctx.masterGain = null; ctx.sfxGain = null; ctx.musicGain = null;
    ctx.initAudio();
    ok(!!ctx.audioCtx, 'initAudio 成功创建 AudioContext');
    ok(!!ctx.masterGain && !!ctx.sfxGain && !!ctx.musicGain, '音频图三条总线建立');
    ctx.applyVolumes();
    ok(Math.abs(ctx.masterGain.gain.value - 0.8) < 0.001, '主音量默认 0.8');
    ok(Math.abs(ctx.musicGain.gain.value - 0.17) < 0.001, '音乐总线 = 0.5 × 0.34 = 0.17');

    var fake = ctx.audioCtx;
    var notes = 0, hats = 0;
    var origNote = ctx.Music._note.bind(ctx.Music);
    var origNoise = ctx.Music._noise.bind(ctx.Music);
    ctx.Music._note = function () { notes++; return origNote.apply(ctx.Music, arguments); };
    ctx.Music._noise = function () { hats++; return origNoise.apply(ctx.Music, arguments); };

    ctx.Music.play('champion');
    ok(ctx.Music.playing === true, 'Music.play 启动调度器');
    ok(ctx.Music.name === 'champion', '曲目切换为 champion');
    // 模拟 8 秒音频时钟（每 100ms 推进一次）
    for (var ti = 0; ti < 80; ti++) {
      fake.currentTime += 0.1;
      ctx.Music._tick();
    }
    ok(notes > 40, '8 秒调度了 ' + notes + ' 个音符（和声 + 贝斯 + 旋律）');
    ok(hats > 15, '8 秒调度了 ' + hats + ' 次打击噪声');
    ok(fake.started > 0, '振荡器实际启动 ' + fake.started + ' 次');
    ok(fake.buffers > 0, '噪声缓冲区创建 ' + fake.buffers + ' 次');
    ok(ctx.Music.step >= 0 && ctx.Music.step < 16, '步进指针在 0..15 内循环（当前 ' + ctx.Music.step + '）');
    ok(ctx.Music.bar >= 0 && ctx.Music.bar < 8, '小节指针在 0..7 内循环（当前 ' + ctx.Music.bar + '）');

    // 时钟跳变保护：一次性跳 30 秒，不应补发海量音符
    var beforeJump = notes;
    fake.currentTime += 30;
    ctx.Music._tick();
    ok(notes - beforeJump < 40, '时钟跳变 30 秒仅补发 ' + (notes - beforeJump) + ' 个音符（有上限保护）');

    ctx.Music.stop();
    ok(ctx.Music.playing === false, 'Music.stop 停止调度');
    ctx.Music._note = origNote; ctx.Music._noise = origNoise;
  } catch (e) {
    ok(false, 'BGM 调度器测试异常：' + e.message);
  }

  /* ---- 四游戏独立曲目、循环及开关恢复 ---- */
  try {
    const previousScreen = ctx.App.screen;
    const previousDifficulty = ctx.App.difficulty;
    const previousGame = ctx.Arcade.game;
    const melodies = ['lobby','easy','blackjack','gold','dice'].map(k => JSON.stringify(ctx.TRACKS[k].melA));
    ok(new Set(melodies).size === 5, '大厅与四款游戏旋律互不重复');
    for (const game of ['blackjack','gold','dice']) {
      const tr = ctx.TRACKS[game];
      const pitches = tr.bars.flatMap(b => [b.b, ...b.c]).concat(tr.melA, tr.melB).filter(Boolean);
      ok(pitches.every(p => Number.isFinite(ctx.NOTE[p])), game + '全部音高可合成');
      ok(!ctx.BGM_FILES[game].some(p => /bgm-(table|lobby)/.test(p)), game + '外置音频不串用大厅/德州');
      ctx.Arcade.game = game; ctx.showScreen('arcade');
      ok(ctx.currentTrackName() === game && ctx.Music.name === game && ctx.Music.playing, game + '场景真实启动对应调度器');
      let scheduled = 0; const baseSchedule = ctx.Music._schedule;
      ctx.Music._schedule = function(...args) { scheduled++; return baseSchedule.apply(this, args); };
      for (let i = 0; i < 500; i++) { ctx.audioCtx.currentTime += 0.04; ctx.Music._tick(); }
      ctx.Music._schedule = baseSchedule;
      ok(scheduled > 64 && ctx.Music.bar < tr.bars.length, game + '跨完整循环持续调度');
      ctx.Music.toggle(); ok(!ctx.Music.playing, game + '关闭音乐停止调度');
      ctx.Music.toggle(); ok(ctx.Music.name === game, game + '重新开启恢复当前游戏而非大厅');
      ctx.bgmStop(); ctx.unlockAudio(); ok(ctx.Music.name === game, game + '音频恢复仍使用本场主题');
    }
    ctx.App.difficulty='normal'; ctx.showScreen('game');
    ok(ctx.Music.name === 'normal', '德州保留分难度曲目');
    ctx.showScreen('lobby'); ok(ctx.Music.name === 'lobby', '返回大厅切回大厅音乐');
    ctx.bgmStop(); ctx.App.screen=previousScreen; ctx.App.difficulty=previousDifficulty; ctx.Arcade.game=previousGame;
  } catch (e) { ok(false, '四游戏音乐测试异常：' + e.stack); }

  /* ---- 外置音频缺失时应回落内置合成 ---- */
  try {
    // vm 环境没有 Audio 构造器，bgmFileEl 必须判空并回落
    ok(ctx.bgmFileEl('lobby') === null, '无 Audio 构造器时外置音频判为不可用');
    ok(ctx.bgmFailed.lobby === true, '失败一次后不再重复探测');
    ctx.bgmPlay('lobby');
    ok(ctx.Music.playing === true, '无外置音频时 bgmPlay 回落到内置合成引擎');
    ok(ctx.bgmSourceLabel().indexOf('合成') >= 0, '来源标注为合成：' + ctx.bgmSourceLabel());
    ok(ctx.bgmSourceLabel().indexOf('外置') < 0, '无文件时不得谎报为外置音频');
    ok(ctx.fileBgm.ok === false, 'fileBgm.ok 保持 false，不做乐观判断');
    ctx.bgmStop();
    ok(ctx.Music.playing === false, 'bgmStop 停止播放');
  } catch (e) {
    ok(false, 'bgmPlay 回落异常：' + e.message);
  }
  // 文件加载未完成时立即合成兜底，旧场景回调不得抢占当前音乐。
  try {
    class FakeAudio {
      constructor() { this.events = {}; this.paused = true; this.readyState = 0; this.error = null; }
      addEventListener(k, f) { this.events[k] = f; }
      pause() { this.paused = true; }
      play() { return new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); }
    }
    ctx.Audio = FakeAudio; ctx.bgmFailed = {}; ctx.bgmEls = {};
    ctx.player.musicOn = true;
    ctx.bgmPlay('lobby');
    const oldAudio = ctx.fileBgm.audio;
    ok(ctx.Music.playing && ctx.Music.name === 'lobby', '文件加载中立即合成兜底');
    ctx.bgmPlay('easy');
    const currentAudio = ctx.fileBgm.audio;
    oldAudio.readyState = 4; oldAudio.paused = false; oldAudio.resolve();
    await Promise.resolve();
    ok(ctx.Music.name === 'easy' && !ctx.fileBgm.ok, '旧文件成功回调不抢占新场景');
    currentAudio.readyState = 4; currentAudio.paused = false; currentAudio.resolve();
    await Promise.resolve();
    ok(ctx.fileBgm.ok && !ctx.Music.playing && ctx.musicGain.gain.value === 0, '文件真实播放后停止并静音合成');
    currentAudio.events.waiting();
    ok(!ctx.fileBgm.ok && ctx.Music.playing, '文件缓冲中断恢复合成');
    ctx.bgmStop(); oldAudio.events.error();
    ok(!ctx.Music.playing && ctx.desiredBgm === '', '停止后的旧error不得重启音乐');
    ctx.document.hidden = true; ctx.bgmPlay('lobby');
    ok(!ctx.Music.playing, '后台不重启音乐');
    ctx.document.hidden = false;
    ctx.bgmFailed = {lobby:true}; ctx.audioCtx.state = 'suspended';
    ctx.bgmPlay('lobby');
    ok(ctx.audioCtx.state === 'running' && ctx.Music.playing, '返回后恢复暂停的音频上下文');
    const oldContext = ctx.audioCtx; oldContext.state = 'closed';
    ctx.bgmPlay('lobby');
    ok(ctx.audioCtx !== oldContext && ctx.Music.playing, '已关闭上下文重建并重新调度');
    ctx.player.volMusic = 0; ctx.applyVolumes();
    ok(ctx.musicGain.gain.value === 0, '零音量不会被默认值覆盖');
    ctx.player.volMusic = 0.5; ctx.bgmStop();
    delete ctx.Audio; ctx.bgmEls = {}; ctx.bgmFailed = {};
  } catch (e) { ok(false, '音频竞态测试异常：' + e.stack); }
  ctx.setTimeout = savedST;
  ctx.audioCtx = null;   // 复位，避免影响后续用例

  /* ---- 横屏 / 伪横屏（手机竖屏适配） ---- */
  console.log('【测试 5】横屏与竖屏适配');
  var savedW = ctx.window.innerWidth, savedH = ctx.window.innerHeight;
  var savedTouch = ctx.navigator.maxTouchPoints;
  var stageEl = ctx.document.getElementById('stage');
  var hintEl = ctx.document.getElementById('rotateHint');

  ok(ctx.isTouchDevice() === false, '桌面环境识别为非触摸设备');
  ok(ctx.isPortraitNarrow() === false, '桌面横屏不触发竖屏提示');

  // 模拟手机竖屏
  ctx.window.innerWidth = 390; ctx.window.innerHeight = 844;
  ctx.navigator.maxTouchPoints = 5;
  ok(ctx.isTouchDevice() === true, '识别为触摸设备');
  ok(ctx.isPortraitNarrow() === true, '识别为手机竖屏');

  ctx.checkOrientation();
  ok(hintEl.style.display === 'flex', '竖屏时弹出「请横屏」提示层');
  ok(ctx.isFakeLandscape() === false, '未开启强制横屏时不做 CSS 旋转');
  ok(String(stageEl.style.transform).indexOf('rotate') < 0,
     '未开启时舞台按普通方式缩放：' + stageEl.style.transform);

  // 点击「强制横屏」：本环境无 fullscreen / orientation.lock，应走 CSS 旋转兜底
  ctx.forceLandscape();
  ok(ctx.App.forceLandscape === true, '强制横屏状态已开启');
  ok(ctx.isFakeLandscape() === true, '识别为「伪横屏」状态');
  ok(String(stageEl.style.transform).indexOf('rotate(90deg)') >= 0,
     '舞台被 CSS 旋转 90° 填满竖屏：' + stageEl.style.transform);
  ok(hintEl.style.display === 'none', '开启后隐藏提示层');

  // 旋转后的缩放应显著大于竖屏直排（避免画面变得极小）
  var mRot = String(stageEl.style.transform).match(/scale\(([\d.]+)\)/);
  var rotScale = mRot ? parseFloat(mRot[1]) : 0;
  var plainScale = Math.min(390 / 960, 844 / 540);
  ok(rotScale > plainScale * 1.5,
     '伪横屏缩放 ' + rotScale.toFixed(3) + ' 明显大于竖屏直排 ' + plainScale.toFixed(3));

  // 设备真的转成横屏 → 自动取消 CSS 旋转
  ctx.window.innerWidth = 844; ctx.window.innerHeight = 390;
  ctx.checkOrientation();
  ok(ctx.isFakeLandscape() === false, '设备转横后不再需要伪横屏');
  ok(String(stageEl.style.transform).indexOf('rotate') < 0,
     '转横后移除 CSS 旋转：' + stageEl.style.transform);

  // 再转回竖屏（系统锁定竖屏的情况）→ 自动恢复伪横屏
  ctx.window.innerWidth = 390; ctx.window.innerHeight = 844;
  ctx.checkOrientation();
  ok(ctx.isFakeLandscape() === true, '系统锁竖屏时自动恢复伪横屏');

  // 记忆
  ok(ctx.localStorage.getItem('texas_poker_force_landscape_v1') === '1',
     '强制横屏选择已写入 localStorage');
  ctx.App.forceLandscape = false;
  if (ctx.localStorage.getItem('texas_poker_force_landscape_v1') === '1') ctx.App.forceLandscape = true;
  ctx.checkOrientation();
  ok(ctx.App.forceLandscape === true, '重新打开后能记住横屏选择');

  // 恢复正常
  ctx.resetLandscape();
  ok(ctx.App.forceLandscape === false, 'resetLandscape 恢复正常');
  ok(ctx.localStorage.getItem('texas_poker_force_landscape_v1') === null, '记忆被清除');
  ctx.checkOrientation();
  ok(hintEl.style.display === 'flex', '恢复后重新出现横屏提示');

  ctx.window.innerWidth = savedW; ctx.window.innerHeight = savedH;
  ctx.navigator.maxTouchPoints = savedTouch;
  ctx.checkOrientation();

  /* ---- 发牌动画：只有桌面牌动，手牌静止 ---- */
  console.log('【测试 6】发牌动画作用域');
  var RE_DEAL = /card[^"]*deal/;
  function mkSeat(id, human) {
    return { id: id, name: human ? '你' : 'AI' + id, avatar: '🙂', human: !!human,
             style: 'balanced', styleName: '平衡型', chips: 1000,
             hole: [{ r: 14, s: 0 }, { r: 13, s: 1 }], bet: 0, totalBet: 0,
             folded: false, allIn: false, acted: false, reveal: false,
             lastAction: '', resultText: '', winner: false, _v: null, psych: null };
  }
  var prevPlayers = ctx.G.players, prevCommunity = ctx.G.community, prevActive = ctx.G.active;
  ctx.G.players = [mkSeat(0, true), mkSeat(1), mkSeat(2), mkSeat(3)];
  ctx.G.community = [{ r: 2, s: 0 }, { r: 5, s: 1 }, { r: 9, s: 2 }];
  ctx.G.dealer = 1; ctx.G.actor = -1; ctx.G.pot = 30; ctx.G.handOver = false;

  var boardEl = ctx.document.getElementById('boardArea');
  var seatEl = ctx.document.getElementById('seat0');

  ctx.renderTable();
  ok(RE_DEAL.test(boardEl.innerHTML), '首次亮出的桌面牌带发牌动画');
  ok(RE_DEAL.test(ctx.document.getElementById('seat0').innerHTML) === false,
     '座位手牌不含发牌动画（手牌静止）');

  ctx.renderTable();
  ok(RE_DEAL.test(boardEl.innerHTML) === false, '重复 render 时桌面牌不重播动画');

  // 转牌：只应该有新亮出的那一张带动画
  ctx.G.community.push({ r: 13, s: 3 });
  ctx.renderTable();
  var dealCount = (boardEl.innerHTML.match(/card[^"]*deal/g) || []).length;
  ok(dealCount === 1, '转牌只有新亮出的 1 张带动画（实际 ' + dealCount + ' 张）');

  // 河牌后再次渲染，全部静止
  ctx.G.community.push({ r: 7, s: 2 });
  ctx.renderTable();
  ctx.renderTable();
  ok(RE_DEAL.test(boardEl.innerHTML) === false, '河牌后重复渲染全部静止');
  ok(RE_DEAL.test(seatEl.innerHTML) === false, '手牌自始至终保持静止');

  ctx.G.players = prevPlayers; ctx.G.community = prevCommunity; ctx.G.active = prevActive;

  /* ---- 老存档迁移 v10 → v11 ---- */
  var legacy = {
    name: '老玩家', version: 10, level: 7, coins: 4242, totalHands: 88,
    achievements: {}, newbieTasks: {}, newbieProgress: {}
  };
  var mg = ctx.migratePlayer(legacy);
  ok(mg.version === 16, '迁移后版本号升级到 16');
  ok(mg.coins === 4242 && mg.level === 7, '迁移保留原有金币与等级');
  ok(mg.rankPoints === 0 && typeof mg.musicOn === 'boolean', '迁移补齐段位与音乐字段');
  ok(!!mg.stats && mg.stats.vpip === 0, '迁移补齐统计结构');
  ok(!!mg.equipped && mg.equipped.cardBack === 'classic', '迁移补齐装备结构');
  ok(!!mg.handDex && !!mg.inventory && !!playerBuffsOk(mg), '迁移补齐图鉴 / 背包 / 增益');
  function playerBuffsOk(p) { return p.buffs && typeof p.buffs.exp2x === 'number'; }

  /* ---- 排位资格、兑换与首次升段奖励 ---- */
  ctx.G.active = false; ctx.G.players = [];
  ctx.createNewSaveAt(1); ctx.App.mode = 'ranked'; ctx.hubGame='holdem';
  ctx.player.coins = 500;
  const realStart = ctx.startGame;
  let started = 0; ctx.startGame = () => { started++; ctx.G.active = true; };
  ok(ctx.buyRankedPoints(1) === false && ctx.player.coins === 500, '金币不能购买积分');
  ok(ctx.profile15('holdem').rankPoints === 0, '兑换不购买段位分');
  ok(!ctx.buyRankedPoints(-1) && !ctx.buyRankedPoints(1.5), '拒绝负数和小数兑换');
  ctx.profile15('holdem').redeemPoints = 1; // 积分来自排位
  ok(ctx.exchangePoints('holdem','sell',1) && ctx.player.coins === 600, '1积分可单向兑换100金币');
  /* 排位积分与赠送都先归零并标记今日已赠送，单独测「门槛 + 门票」两件事 */
  ctx.player.games.holdem.rankPoints=0;
  ctx.player.games.holdem.giftDate=ctx.todayStr();
  ctx.player.coins=0;
  ok(!ctx.tryEnterGame('champion') && started===0, '金币为 0 时连门票都付不起，拒绝进入排位');
  ctx.player.coins=ctx.ENTRY_FEE.champion;
  ok(!ctx.tryEnterGame('champion') && started===0, '排位积分不满 '+ctx.RANKED_ENTRY_MIN+' 时不得进入');
  ctx.profile15('holdem').rankPoints=ctx.RANKED_ENTRY_MIN;
  ok(ctx.tryEnterGame('champion') && started===1 && ctx.player.coins===0, '排位同样收门票（冠军档 '+ctx.ENTRY_FEE.champion+'）');
  ok(!ctx.tryEnterGame('easy') && !ctx.buyRankedPoints(1), '在牌桌拒绝重复入场及兑换');
  ctx.startGame = realStart; ctx.G.active = false;
  ctx.player.rankPoints = 0; ctx.player.rankPeak = 0;
  const firstThreshold = ctx.RANKS[1].min;
  ctx.addRankPoints(firstThreshold);
  const coinsAfterReward = ctx.player.coins;
  ctx.addRankPoints(-firstThreshold); ctx.addRankPoints(firstThreshold);
  ok(ctx.player.coins === coinsAfterReward, '跌段后重升不重复发金币');
  ctx.addRankPoints(-100000);
  ok(ctx.player.rankPoints === 0, '段位积分最低为零');
  ok(ctx.escapeHTML('<b>&\"') === '&lt;b&gt;&amp;&quot;', '用户名HTML转义');
  ctx.App.mode = 'quick';

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
  ctx.player.coins = 500;
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
  ok(ctx.claimDailyRelief() === true, '破产面板可领取当日救济金');
  ok(ctx.player.coins >= ctx.RELIEF.amount, '领取救济金后金币恢复（' + ctx.player.coins + '）');
  ok(ctx.claimDailyRelief() === true && ctx.claimDailyRelief() === true, '每日可领 ' + ctx.RELIEF.timesPerDay + ' 次');
  ok(ctx.claimDailyRelief() === false, '超出当日次数后拒绝领取');
  doc.getElementById('ovGameOver').classList.remove('show');
  ctx.showScreen('lobby');

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

  // 隔离验证离桌：投入计入亏损，结算后退出不重复扣分。
  ctx.createNewSaveAt(1); ctx.App.mode = 'ranked';
  ctx.player.rankPoints = 3; ctx.profile15('holdem').rankPoints=3; ctx.profile15('holdem').redeemPoints=2; ctx.player.coins = 1000;
  ctx.player.rankedPending={id:'exit-test',game:'holdem',difficulty:'easy'};
  ctx.G.players = [ctx.makePlayer(0, '测试', '', true, 'human', 950, '')];
  ctx.G.players[0].totalBet = 50;
  ctx.G.active = true; ctx.G.handOver = false; ctx.G.handSettled = false; ctx.G.settling = false;
  ctx.G.session = {hands:0,wins:0,net:0,coins:1000,rank:3,fee:0};
  let actionReleased = false; ctx.humanResolve = () => { actionReleased = true; };
  ctx.exitGame();
  ok(actionReleased && !ctx.G.active && ctx.G.players.length === 0, '离桌释放待操作Promise并清空牌桌');
  ok(ctx.player.coins === 1000 && ctx.player.stats.totalNet === 0 && ctx.player.rankPoints === 0 && ctx.profile15('holdem').redeemPoints===1, '排位离桌扣本游戏积分，不扣金币不混入金币盈亏');
  ok(doc.getElementById('ovSession').classList.contains('show'), '离桌显示本次汇总');
  const exitCoins = ctx.player.coins; ctx.exitGame();
  ok(ctx.player.coins === exitCoins && ctx.player.stats.totalNet === 0 && ctx.profile15('holdem').redeemPoints===1, '重复离桌不重复扣款或统计');

  // ---- 邀请链接（房间分享）----
  const rsl = ctx.roomShareLink, prs = ctx.parseRoomShare;
  ok(typeof rsl === 'function' && typeof prs === 'function', 'roomShareLink/parseRoomShare 存在于主作用域');
  eq(rsl('646685', 'guandan'), 'https://milkteacoffee.github.io/PokerClub/?room=646685&game=guandan', '无 location 环境回落线上地址（含 game）');
  eq(rsl('646685', ''), 'https://milkteacoffee.github.io/PokerClub/?room=646685', '无 game 只带房号');
  ctx.location = { protocol: 'https:', origin: 'https://demo.example', pathname: '/games/', search: '?room=123456&game=holdem' };
  eq(rsl('888888', ''), 'https://demo.example/games/?room=888888', 'http(s) 环境用当前页面地址拼链接');
  eq(prs(), { room: '123456', game: 'holdem' }, '解析 room+game 参数');
  ctx.location = { protocol: 'file:', search: '?code=646685' };
  eq(prs(), { room: '646685', game: '' }, '兼容 ?code= 且 file 协议可解析');
  eq(rsl('646685', ''), 'https://milkteacoffee.github.io/PokerClub/?room=646685', 'file 协议拼链回落线上地址');
  ctx.location = { protocol: 'file:', search: '?room=12345&room2=646685' };
  eq(prs(), { room: '', game: '' }, '非 6 位房号拒绝解析');
  ctx.location = undefined;

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
