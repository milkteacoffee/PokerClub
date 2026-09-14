'use strict';
/**
 * 万场压力回归测试（极简 DOM 桩 + vm）
 * 覆盖六个游戏：德州扑克 / 21点 / 炸金花 / 猜骰子 / 骰子比大小 / 掼蛋
 * 每个游戏跑大量对局，断言：不抛异常、资金守恒、无 NaN、无非法余额、状态正确终结。
 *
 * 运行: node tests/stress-10k.test.js [ARCADE] [COINS] [RANKED] [HOLDEM] [GUANDAN]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

/* ---------------- 1. 抽脚本 + 去壳 ---------------- */
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('✗ 未找到 <script> 块'); process.exit(1); }
const stripped = m[1]
  .replace(/\(function \(\) \{\s*'use strict';/, '')
  .replace(/\}\)\(\);\s*$/, '');
if (stripped === m[1]) { console.error('✗ IIFE 去壳失败'); process.exit(1); }

/* ---------------- 2. 极简 DOM 桩 ---------------- */
function makeElement(doc, tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    _listeners: {}, children: [], parentNode: null,
    _id: '', _cls: new Set(), style: {}, dataset: {},
    textContent: '', value: '', min: 0, max: 0, step: 1, type: '',
    disabled: false, title: '', className: '',
  };
  el.classList = {
    add(...cs) { cs.forEach(c => el._cls.add(c)); el.className = Array.from(el._cls).join(' '); },
    remove(...cs) { cs.forEach(c => el._cls.delete(c)); el.className = Array.from(el._cls).join(' '); },
    contains(c) { return el._cls.has(c); },
    toggle(c, force) { const want = force === undefined ? !el._cls.has(c) : !!force; if (want) el._cls.add(c); else el._cls.delete(c); el.className = Array.from(el._cls).join(' '); return want; },
  };
  Object.defineProperty(el, 'id', { get() { return el._id; }, set(v) { el._id = v; if (v) doc._registry.set(v, el); } });
  Object.defineProperty(el, 'innerHTML', { get() { return el._html || ''; }, set(v) { el._html = String(v); el.children.length = 0; } });
  el.addEventListener = (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); };
  el.removeEventListener = (t, fn) => { const a = el._listeners[t]; if (!a) return; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
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
function makeNodeList(arr) { const nl = { length: arr.length, forEach: (f, t) => arr.forEach(f, t) }; arr.forEach((v, i) => { nl[i] = v; }); return nl; }
function fire(el, type, ev) { const a = el._listeners[type] || []; a.slice().forEach(fn => fn.call(el, ev || { preventDefault() {}, key: '' })); }

const doc = {
  _registry: new Map(), readyState: 'complete', documentElement: {}, body: {},
  getElementById(id) { if (!doc._registry.has(id)) { const el = makeElement(doc, 'div'); el._id = id; doc._registry.set(id, el); } return doc._registry.get(id); },
  createElement(tag) { return makeElement(doc, tag); },
  querySelectorAll() { return makeNodeList([]); },
  querySelector() { return null; },
  addEventListener() {},
};

const storage = new Map();
const sandbox = {
  document: doc,
  navigator: { maxTouchPoints: 0, userAgent: 'node-stress' },
  screen: {},
  localStorage: {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k),
  },
  crypto,
  performance: { now: () => Date.now() },
  console,
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
  setTimeout: (fn) => setImmediate(fn),
  clearTimeout: () => {},
  setImmediate,
  addEventListener() {},
  innerWidth: 1280, innerHeight: 720,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(stripped, sandbox);
const ctx = sandbox;

/* ---------------- 3. 辅助 ---------------- */
function findAll(root, pred, out) {
  out = out || [];
  if (!root || !root.children) return out;
  for (const c of root.children) { if (pred(c)) out.push(c); findAll(c, pred, out); }
  return out;
}
function findBtn(root, cls) { return findAll(root, e => String(e.className || '').indexOf(cls) >= 0)[0] || null; }
const sleepTick = () => new Promise(r => setImmediate(r));
const bottomBar = doc.getElementById('bottomBar');

let pass = 0, fail = 0;
const failures = [];
function assert(cond, msg) { if (!cond) { fail++; failures.push(msg); throw new Error(msg); } }
assert.equal = (a, b, msg) => { if (a !== b) { fail++; const m = (msg || 'assert.equal') + ' (got ' + a + ', want ' + b + ')'; failures.push(m); throw new Error(m); } };
assert.deepEqual = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) { fail++; const m = (msg || 'assert.deepEqual') + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'; failures.push(m); throw new Error(m); } };
// 不抛异常的软校验（用于热循环内，避免一手失败中断整轮压测）
function check(cond, msg) { if (!cond) { fail++; failures.push(msg); } }
function section(name) { console.log('\n==== ' + name + ' ===='); }

/* 资金守恒校验：NaN / 负数 / 大数 */
function saneMoney(v, where) {
  assert(Number.isFinite(v), where + ' 出现非有限值: ' + v);
  assert(Number.isInteger(v), where + ' 不是整数: ' + v);
  assert(v >= -0.0001, where + ' 余额为负: ' + v);
  assert(v < 1e15, where + ' 余额异常偏大: ' + v);
}

/* ---------------- 4. 参数 ---------------- */
const ARC = Number(process.argv[2] || 2500);   // 每个同步小游戏练习局数
const COINS = Number(process.argv[3] || 300);  // 金币场经济局数
const RANKED = Number(process.argv[4] || 200); // 排位局数
const HOLDEM = Number(process.argv[5] || 800); // 德州手数
const GUAN = Number(process.argv[6] || 800);   // 掼蛋局数

let totalGames = 0;

/* ============================================================
   5. 四个同步小游戏：练习模式守恒
   ============================================================ */
function freshArcade(game, mode) {
  ctx.G.active = false;
  ctx.Arcade.round = null;
  ctx.player.arcade = { stats: {}, pending: null, history: [] };
  ctx.player.coins = 5000;
  ctx.Arcade.practice = 500;
  ctx.Arcade.mode = mode || 'practice';
  ctx.Arcade.difficulty = 'easy';
  ctx.App.mode = (mode === 'ranked') ? 'ranked' : 'quick';
  if (mode === 'ranked') ctx.profile15(game).rankPoints = ctx.RANKED_ENTRY_MIN;
  assert.equal(ctx.openArcade(game), true, 'openArcade(' + game + ',' + mode + ')');
}

function practiceConservation(game, n) {
  freshArcade(game, 'practice');
  for (let i = 0; i < n; i++) {
    ctx.Arcade.practice = 500;            // 每局重置练习筹码（与 ranked 在 arcadeBegin 内重置比赛筹码一致）
    const bal0 = ctx.Arcade.practice;     // = 500
    if (game === 'blackjack') {
      ctx.blackjackStart(10);
      let guard = 0;
      while (!ctx.Arcade.round.done && guard++ < 30) {
        const r = ctx.Arcade.round;
        if (r.hand.length === 2 && r.stake * 2 <= ctx.arcadeRoundLimit15() && Math.random() < 0.15) ctx.blackjackHit(true);
        else if (ctx.blackjackValue(r.hand).total < 17) ctx.blackjackHit(false);
        else ctx.blackjackStand();
      }
    } else if (game === 'gold') {
      ctx.goldStart(10);
      let guard = 0;
      while (!ctx.Arcade.round.done && guard++ < 25) {
        const r = ctx.Arcade.round, se = r.seats[0];
        const acts = [];
        if (!se.seen) acts.push('peek');
        acts.push('fold', 'call');
        if (r.turn >= 3) { const t = 1 + (Math.random() * 3 | 0); if (r.seats[t] && !r.seats[t].folded) acts.push('compare-' + t); }
        const pick = acts[Math.random() * acts.length | 0];
        if (pick === 'peek') { if (!se.seen) ctx.goldAction('peek'); continue; }
        if (pick.indexOf('compare-') === 0) { ctx.goldAction('compare', Number(pick.split('-')[1])); continue; }
        ctx.goldAction(pick);
      }
      // 兜底：AI 可能已摊牌，强制结算
      if (!ctx.Arcade.round.done) { let g2 = 0; while (!ctx.Arcade.round.done && g2++ < 25) { const rr = ctx.Arcade.round; ctx.goldAction(rr.seats[0].seen ? 'call' : 'fold'); } }
    } else if (game === 'dice') {
      ctx.Arcade.basket = [];
      const choices = ['small', 'big', 'any', 'sum3', 'sum18', 'triple6'];
      const k = 1 + (Math.random() * 3 | 0);
      for (let j = 0; j < k; j++) ctx.diceAddBet(choices[Math.random() * choices.length | 0], 10);
      if (!ctx.Arcade.basket.length) ctx.diceAddBet('small', 10);
      ctx.diceRollBasket();
    } else if (game === 'diceduel') {
      ctx.ddStart(30);
    }
    const r = ctx.Arcade.round;
    assert(r.done, game + ' 第 ' + i + ' 局未终结');
    saneMoney(r.stake, game + ' stake');
    saneMoney(r.payout, game + ' payout');
    saneMoney(ctx.Arcade.practice, game + ' practice');
    const expect = bal0 - r.stake + r.payout;
    assert(Math.abs(ctx.Arcade.practice - expect) < 1e-6, game + ' 练习守恒失败: ' + ctx.Arcade.practice + ' != ' + expect + ' (stake=' + r.stake + ',payout=' + r.payout + ')');
    if (game === 'gold') {
      const rr = r;
      assert.equal(rr.pot, rr.seats.reduce((s, p) => s + p.paid, 0), 'gold 底池=已付总和');
      rr.seats.slice(1).forEach(p => assert(p.stack >= 0 && p.stack + p.paid === 500, 'gold AI 筹码守恒'));
    }
    if (game === 'dice') assert.equal(ctx.Arcade.basket.length, 0, 'dice 开奖后清单清空');
    totalGames++;
  }
}

section('练习模式守恒（各 ' + ARC + ' 局）');
['blackjack', 'gold', 'dice', 'diceduel'].forEach(g => {
  const before = totalGames;
  try { practiceConservation(g, ARC); assert(true, g + ' 练习'); console.log('  PASS ' + g + ' 练习 ' + (totalGames - before) + ' 局'); }
  catch (e) { console.log('  FAIL ' + g + ': ' + e.message); }
});

/* ============================================================
   6. 金币场经济守恒（含门票）
   ============================================================ */
function coinsEconomy(game, n) {
  ctx.player.coins = 100000;
  ctx.Arcade.mode = 'coins'; ctx.Arcade.difficulty = 'easy'; ctx.App.mode = 'quick';
  const fee = ctx.ENTRY_FEE.easy;
  assert.equal(ctx.openArcade(game), true, 'coins openArcade(' + game + ')');
  assert.equal(100000 - ctx.player.coins, fee, '进场扣门票 ' + fee);
  for (let i = 0; i < n; i++) {
    const c0 = ctx.player.coins;
    if (game === 'blackjack') { ctx.blackjackStart(10); let g = 0; while (!ctx.Arcade.round.done && g++ < 30) { const r = ctx.Arcade.round; if (ctx.blackjackValue(r.hand).total < 17) ctx.blackjackHit(false); else ctx.blackjackStand(); } }
    else if (game === 'gold') { ctx.goldStart(10); let g = 0; while (!ctx.Arcade.round.done && g++ < 25) { const r = ctx.Arcade.round; ctx.goldAction(r.seats[0].seen ? 'call' : 'fold'); } if (!ctx.Arcade.round.done) { let g2 = 0; while (!ctx.Arcade.round.done && g2++ < 25) ctx.goldAction('fold'); } }
    else if (game === 'dice') { ctx.Arcade.basket = []; ctx.diceAddBet(Math.random() < 0.5 ? 'small' : 'big', 10); ctx.diceRollBasket(); }
    else if (game === 'diceduel') { ctx.ddStart(30); }
    const r = ctx.Arcade.round;
    assert(r.done, game + ' 金币场第 ' + i + ' 局未终结');
    saneMoney(ctx.player.coins, game + ' coins');
    const expect = c0 - r.stake + r.payout;
    assert.equal(ctx.player.coins, expect, game + ' 金币场守恒: ' + ctx.player.coins + ' != ' + expect);
    assert.equal(ctx.arcadeData().pending, null, game + ' 结算后 pending 应清空');
    totalGames++;
  }
}

section('金币场经济守恒（各 ' + COINS + ' 局，含门票）');
['blackjack', 'gold'].forEach(g => {
  const before = totalGames;
  try { coinsEconomy(g, COINS); console.log('  PASS ' + g + ' 金币场 ' + (totalGames - before) + ' 局'); }
  catch (e) { console.log('  FAIL ' + g + ': ' + e.message); }
});

/* ============================================================
   7. 排位模式（积分边界 + 比赛筹码守恒）
   ============================================================ */
function rankedRun(game, n) {
  ctx.player.coins = 100000;
  ctx.Arcade.mode = 'ranked'; ctx.Arcade.difficulty = 'easy'; ctx.App.mode = 'ranked';
  ctx.profile15(game).rankPoints = ctx.RANKED_ENTRY_MIN;
  ctx.profile15(game).redeemPoints = 0;
  const fee = ctx.ENTRY_FEE.easy;
  assert.equal(ctx.openArcade(game), true, 'ranked openArcade(' + game + ')');
  assert.equal(100000 - ctx.player.coins, fee, '排位扣门票 ' + fee);
  for (let i = 0; i < n; i++) {
    const bank0 = ctx.arcadeBank15();     // 每轮比赛筹码在 arcadeBegin 内重置为基准
    if (game === 'blackjack') { ctx.blackjackStart(10); let g = 0; while (!ctx.Arcade.round.done && g++ < 30) { const r = ctx.Arcade.round; if (ctx.blackjackValue(r.hand).total < 17) ctx.blackjackHit(false); else ctx.blackjackStand(); } }
    else if (game === 'gold') { ctx.goldStart(10); let g = 0; while (!ctx.Arcade.round.done && g++ < 25) { const r = ctx.Arcade.round; ctx.goldAction(r.seats[0].seen ? 'call' : 'fold'); } if (!ctx.Arcade.round.done) { let g2 = 0; while (!ctx.Arcade.round.done && g2++ < 25) ctx.goldAction('fold'); } }
    const r = ctx.Arcade.round;
    assert(r.done, game + ' 排位第 ' + i + ' 局未终结');
    saneMoney(ctx.Arcade.rankedBank, game + ' rankedBank');
    const expect = bank0 - r.stake + r.payout;
    assert.equal(ctx.Arcade.rankedBank, expect, game + ' 排位比赛筹码守恒: ' + ctx.Arcade.rankedBank + ' != ' + expect);
    // 结算只动积分，不碰金币
    assert.equal(100000 - fee, ctx.player.coins, game + ' 排位不结算金币');
    const rp = ctx.profile15(game).rankPoints;
    assert(rp >= 0, game + ' 排位积分不可为负: ' + rp);
    assert(rp <= 100000, game + ' 排位积分异常: ' + rp);
    totalGames++;
  }
}

section('排位守恒（各 ' + RANKED + ' 局，积分边界 + 比赛筹码）');
['blackjack', 'gold'].forEach(g => {
  const before = totalGames;
  try { rankedRun(g, RANKED); console.log('  PASS ' + g + ' 排位 ' + (totalGames - before) + ' 局'); }
  catch (e) { console.log('  FAIL ' + g + ': ' + e.message); }
});

/* ============================================================
   8. 德州扑克：异步驱动，筹码守恒 + 无异常
   ============================================================ */
section('德州扑克（' + HOLDEM + ' 手，异步驱动）');
async function runHoldem() {
  const cfg = ctx.DIFFICULTY_CONFIG['easy'];
  ctx.G.bb = cfg.bb; ctx.G.sb = cfg.sb; ctx.G.buyIn = cfg.buyIn; ctx.G.minRaiseUnit = cfg.minRaiseUnit;
  const origAdd = ctx.addCoins;
  let injected = 0, liveInjected = 0;
  ctx.addCoins = function (n) { injected += n; liveInjected += n; return origAdd(n); };
  let hands = 0, ticks = 0, maxTicks = 8000000;
  try {
    ctx.player.coins = 2000000;
    ctx.App.difficulty = 'easy';
    ctx.G.active = true; ctx.G.handOver = true; ctx.G.handNo = 0; ctx._prevHandNo = -1;
    ctx.startGame('easy');
    while (hands < HOLDEM && ticks < maxTicks) {
      ticks++;
      if (ticks % 200 === 0) await sleepTick();
      if (ctx.G.handOver === false && ctx._prevHandNo !== ctx.G.handNo) {
        ctx._prevHandNo = ctx.G.handNo;
        ctx._chipsAtStart = ctx.G.players.reduce((s, p) => s + p.chips, 0) + ctx.G.pot;
        liveInjected = 0;
      }
      if (!ctx.G.active) break;
      if (ctx.G.actor === 0 && !ctx.G.handOver) {
        const canCheck = findBtn(bottomBar, 'abtn check');
        const canCall = findBtn(bottomBar, 'abtn call');
        const canRaise = findBtn(bottomBar, 'abtn raise');
        const canAllin = findBtn(bottomBar, 'abtn allin');
        const canFold = findBtn(bottomBar, 'abtn fold');
        const p = ctx.G.players[0];
        const r = Math.random();
        try {
          if (canAllin && r < 0.05) fire(canAllin, 'click');
          else if (canFold && r < 0.15) fire(canFold, 'click');
          else if (canRaise && r < 0.40) fire(canRaise, 'click');
          else if (canCheck) fire(canCheck, 'click');
          else if (canCall && (ctx.G.currentBet - p.bet) <= p.chips * 0.35) fire(canCall, 'click');
          else if (canFold) fire(canFold, 'click');
        } catch (e) { check(false, '德州人类回合点击异常: ' + e.message); }
        await sleepTick();
        continue;
      }
      if (ctx.G.handOver) {
        if (ctx._chipsAtStart != null) {
          const now = ctx.G.players.reduce((s, p) => s + p.chips, 0) + ctx.G.pot;
          const expected = ctx._chipsAtStart + liveInjected;
          check(now === expected, '德州第 ' + hands + ' 手筹码守恒: 实际 ' + now + ' 期望 ' + expected + '（注入 ' + liveInjected + '）');
          check(ctx.G.pot === 0, '德州第 ' + hands + ' 手底池残留 ' + ctx.G.pot);
          ctx._chipsAtStart = null;
        }
        hands++; totalGames++;
        if (hands >= HOLDEM) break;
        const start = findBtn(bottomBar, 'abtn start');
        if (!start) { check(false, '第 ' + hands + ' 手后找不到"下一手"按钮'); break; }
        if (ctx.G.players[0].chips <= 0) { ctx.G.players[0].chips = 2000000; ctx.player.coins = 2000000; }
        try { fire(start, 'click'); } catch (e) { check(false, '德州下一手点击异常: ' + e.message); break; }
        await sleepTick();
        continue;
      }
      await sleepTick();
    }
    console.log('  PASS 德州 ' + hands + ' 手（ticks=' + ticks + '）');
  } catch (e) { console.log('  FAIL 德州: ' + e.message); }
  ctx.addCoins = origAdd;
}

/* ============================================================
   9. 掼蛋：纯逻辑引擎同步压测
   ============================================================ */
section('掼蛋（' + GUAN + ' 局，纯引擎）');
function runGuandan() {
  try {
    const G = ctx.Guandan;
    assert(G && typeof G.create === 'function', 'Guandan 引擎可用');
    for (let run = 0; run < GUAN; run++) {
      const level = 2 + (run % 3); // 掼蛋常用 level 2/3/4
      let g = G.create(level);
      const used = new Set();
      let guard = 0;
      while (!g.done && g.moves < 2000 && guard++ < 2000) {
        const s = g.turn;
        const ids = G.choose(g, s);
        if (ids) ids.forEach(id => { assert(!used.has(id), '掼蛋牌复用 run=' + run); used.add(id); });
        assert(G.act(g, s, ids), '掼蛋 AI 动作非法 run=' + run);
        assert.equal(used.size + g.hands.flat().length, 108, '掼蛋牌数守恒 run=' + run);
      }
      assert(g.done, '掼蛋第 ' + run + ' 局未终结（moves=' + g.moves + '）');
      assert.equal(new Set(g.order).size, 4, '掼蛋 4 家出完顺序');
      assert([1, 2, 3].includes(g.up), '掼蛋升级数合法: ' + g.up);
      totalGames++;
    }
    console.log('  PASS 掼蛋 ' + GUAN + ' 局');
  } catch (e) { console.log('  FAIL 掼蛋: ' + e.message); }
}

/* ============================================================
   10. 汇总
   ============================================================ */
(async function main() {
  await runHoldem();
  runGuandan();
  console.log('\n============================');
  console.log('  万场压力测试汇总');
  console.log('  总对局数: ' + totalGames + '（目标 ≥ 10000）');
  console.log('  失败项: ' + (fail === 0 ? '无' : fail + ' 处'));
  console.log('============================');
  if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
})();
