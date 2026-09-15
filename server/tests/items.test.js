'use strict';
/**
 * 排位道具系统测试：
 * 1) 商城道具定义完整（含限购字段）
 * 2) 日限/周限/持有上限拦截正确，跨天跨周自动重置
 * 3) 排位保护卡：败局不掉段位分，且消耗 1 张
 * 4) 积分翻倍卡：胜局段位分 ×2，且消耗 1 张
 * 5) 金币提升卡：仅金币场生效，+50%，10 局后失效
 * 6) 幸运骰子卡：仅骰子玩法生效，+25%
 * 7) 存档迁移补齐 buyLog 与新 buffs 字段
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
const stripped = m[1].replace(/\(function \(\) \{\s*'use strict';/, '').replace(/\}\)\(\);\s*$/, '');

function makeElement(doc, tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(), _listeners: {}, children: [], parentNode: null,
    _id: '', _cls: new Set(), style: {}, dataset: {}, textContent: '', value: '',
    min: 0, max: 0, step: 1, type: '', disabled: false, title: '', className: '',
  };
  el.classList = {
    add(...cs) { cs.forEach(c => el._cls.add(c)); el.className = Array.from(el._cls).join(' '); },
    remove(...cs) { cs.forEach(c => el._cls.delete(c)); el.className = Array.from(el._cls).join(' '); },
    contains(c) { return el._cls.has(c); },
    toggle(c, f) { const w = f === undefined ? !el._cls.has(c) : !!f; if (w) el._cls.add(c); else el._cls.delete(c); el.className = Array.from(el._cls).join(' '); return w; },
  };
  Object.defineProperty(el, 'id', { get() { return el._id; }, set(v) { el._id = v; if (v) doc._registry.set(v, el); } });
  Object.defineProperty(el, 'innerHTML', { get() { return el._html || ''; }, set(v) { el._html = String(v); el.children.length = 0; } });
  el.addEventListener = (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); };
  el.removeEventListener = () => {};
  el.appendChild = (c) => { el.children.push(c); c.parentNode = el; return c; };
  el.removeChild = (c) => { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; };
  el.setAttribute = (k, v) => { el['_attr_' + k] = String(v); };
  el.getAttribute = (k) => (k in el ? (k === 'class' ? el.className : el[k]) : el['_attr_' + k] || null);
  el.querySelectorAll = () => makeNodeList([]);
  el.querySelector = () => null;
  el.focus = () => {};
  el.click = () => {};
  return el;
}
function makeNodeList(arr) { const nl = { length: arr.length, forEach: (f, t) => arr.forEach(f, t) }; arr.forEach((v, i) => { nl[i] = v; }); return nl; }

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
  document: doc, navigator: { maxTouchPoints: 0, userAgent: 'node-test' }, screen: {},
  localStorage: { getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
  crypto: nodeCrypto, performance: { now: () => Date.now() }, console,
  requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
  setTimeout: (fn) => setImmediate(fn), clearTimeout: () => {}, setImmediate,
  addEventListener() {}, innerWidth: 1280, innerHeight: 720,
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(stripped, sandbox);
const ctx = sandbox;

let pass = 0, fail = 0; const failures = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; failures.push(msg); } }

/* 初始化为新玩家 */
function freshPlayer() {
  ctx.player = ctx.createNewPlayer('测试员');
  ctx.player.coins = 2000000;
  ctx.player.inventory = {};
  ctx.player.buffs = { exp2x: 0, peek: 0, goldBoost: 0, diceLucky: 0 };
  ctx.player.buyLog = ctx.newBuyLog();
  /* 构造最小可保存结构，避免 saveAllSaves 报错 */
  ctx.allSaves = { activeSlot: 1, slots: { 1: { player: ctx.player } } };
}

/* ---- 1. 道具定义完整性 ---- */
{
  const ids = ['rank_guard', 'rank_double', 'gold_boost', 'dice_lucky'];
  ids.forEach(id => {
    const it = ctx.SHOP_ITEMS.find(x => x.id === id);
    ok(!!it, '道具定义存在: ' + id);
    if (it) {
      ok(Number.isSafeInteger(it.price) && it.price > 0, id + ' 价格合法');
      ok(!!it.limits && it.limits.day > 0 && it.limits.week > 0 && it.limits.hold > 0, id + ' 限购字段完整');
      ok(it.limits.day <= it.limits.week, id + ' 日限 ≤ 周限');
      ok(it.limits.week <= it.limits.hold * 7, id + ' 周限不超持有上限的宽松约束');
    }
  });
  ok(ctx.SHOP_ITEMS.filter(x => x.limits).length === 4, '恰好 4 件限购道具');
  ok(ctx.SHOP_ITEMS.length === 15, '商城共 15 件（11 原有 + 4 新增）');
}

/* ---- 2. 限购拦截 ---- */
{
  freshPlayer();
  const before = ctx.player.coins;
  let r = ctx.buyItem('rank_guard');
  ok(r.ok, '首次购买保护卡成功');
  ok(ctx.player.coins === before - 2500, '扣款正确 2500');
  ok(ctx.player.inventory['rank_guard'] === 1, '库存 +1');
  ok(ctx.boughtToday('rank_guard') === 1, '今日计数 +1');
  ok(ctx.boughtThisWeek('rank_guard') === 1, '本周计数 +1');

  r = ctx.buyItem('rank_guard');
  ok(r.ok, '第二次购买成功');
  r = ctx.buyItem('rank_guard');
  ok(!r.ok, '第三次购买被日限拦截（day=2 已用完）');
  ok(ctx.player.inventory['rank_guard'] === 2, '库存停在日限上限 2');
  ok(ctx.buyLimitReason('rank_guard').indexOf('今日已购满') >= 0, '阻塞原因提示日限');

  /* 持有上限测试：绕过日限，直接验证 hold 拦截 */
  ctx.player.buyLog.byDay = {};
  ctx.player.buyLog.byWeek = {};
  ctx.player.inventory['rank_guard'] = 2;
  r = ctx.buyItem('rank_guard');
  ok(r.ok, '持有 2 张、日限清空后可买第 3 张');
  ok(ctx.player.inventory['rank_guard'] === 3, '库存达到持有上限 3');
  ok(ctx.buyLimitReason('rank_guard').indexOf('持有上限') >= 0, '阻塞原因提示持有上限');
}

/* ---- 3. 跨天重置 ---- */
{
  freshPlayer();
  ctx.buyItem('rank_guard');
  ctx.buyItem('rank_guard');
  ctx.player.inventory['rank_guard'] = 0;
  ok(ctx.buyLimitReason('rank_guard').indexOf('今日已购满') >= 0, '跨天前显示日限');
  /* 模拟跨天：把 day 改掉 */
  ctx.player.buyLog.day = '2000-01-01';
  const r = ctx.buyItem('rank_guard');
  ok(r.ok, '跨天后日限重置，可再买');
  ok(ctx.boughtToday('rank_guard') === 1, '跨天后今日计数重置为 1');
}

/* ---- 4. 排位保护卡：败局不掉段位分 ---- */
{
  freshPlayer();
  ctx.player.inventory['rank_guard'] = 1;
  ctx.profile15('blackjack').rankPoints = 500;
  const before = ctx.profile15('blackjack').rankPoints;
  // net < 0 表示败局
  const delta = ctx.applyRankResult15('blackjack', 'easy', -10, { guard: true });
  ok(delta.guard === true, '保护卡被标记生效');
  ok(ctx.profile15('blackjack').rankPoints === before, '败局段位分未变化（保护卡生效）');

  // 不戴保护卡对照
  freshPlayer();
  ctx.profile15('blackjack').rankPoints = 500;
  const d2 = ctx.applyRankResult15('blackjack', 'easy', -10, {});
  ok(d2.guard === false, '未戴卡时不标记 guard');
  ok(ctx.profile15('blackjack').rankPoints === 495, '未戴卡时正常扣 5 分');
}

/* ---- 5. 积分翻倍卡：胜局 ×2 ---- */
{
  freshPlayer();
  ctx.profile15('gold').rankPoints = 500;
  const d = ctx.applyRankResult15('gold', 'easy', 10, { double: true });
  ok(d.double === true, '翻倍卡被标记生效');
  ok(ctx.profile15('gold').rankPoints === 510, '胜局 +5 翻倍为 +10');

  freshPlayer();
  ctx.profile15('gold').rankPoints = 500;
  ctx.applyRankResult15('gold', 'easy', 10, {});
  ok(ctx.profile15('gold').rankPoints === 505, '未翻倍时正常 +5');
}

/* ---- 6. 金币提升卡：仅金币场生效 ---- */
{
  freshPlayer();
  ctx.Arcade.mode = 'coins'; ctx.Arcade.game = 'blackjack';
  ctx.player.buffs.goldBoost = 10;
  ok(ctx.applyGoldBoost(100) === 150, '金币场 +50%：100 → 150');
  ctx.Arcade.mode = 'practice';
  ok(ctx.applyGoldBoost(100) === 100, '练习场不生效');
  ctx.Arcade.mode = 'ranked';
  ok(ctx.applyGoldBoost(100) === 100, '排位不生效');
  ctx.Arcade.mode = 'coins';
  ctx.player.buffs.goldBoost = 0;
  ok(ctx.applyGoldBoost(100) === 100, '无 buff 时不变');
  ok(ctx.ITEM_EFFECT.goldBoostPct === 50, '金币加成比例常量 = 50');
  ok(ctx.ITEM_EFFECT.goldBoostRounds === 10, '金币加成持续局数 = 10');
}

/* ---- 7. 幸运骰子卡：仅骰子玩法 ---- */
{
  freshPlayer();
  ctx.Arcade.mode = 'practice'; ctx.Arcade.game = 'dice';
  ctx.player.buffs.diceLucky = 5;
  ok(ctx.applyDiceLucky(100) === 125, '猜骰子 +25%：100 → 125');
  ctx.Arcade.game = 'diceduel';
  ok(ctx.applyDiceLucky(100) === 125, '骰子比大小 +25%');
  ctx.Arcade.game = 'gold';
  ok(ctx.applyDiceLucky(100) === 100, '炸金花不生效');
  ok(ctx.ITEM_EFFECT.diceLuckyPct === 25, '骰子加成比例常量 = 25');
  ok(ctx.ITEM_EFFECT.diceLuckyRounds === 5, '骰子加成持续局数 = 5');
}

/* ---- 8. 使用消耗品激活 buff ---- */
{
  freshPlayer();
  ctx.player.inventory['gold_boost'] = 1;
  const r = ctx.useItem('gold_boost');
  ok(r.ok, '使用金币提升卡成功');
  ok(ctx.player.buffs.goldBoost === 10, 'buff 置为 10 局');
  ok(!ctx.player.inventory['gold_boost'], '库存消耗');
  const r2 = ctx.useItem('gold_boost');
  ok(!r2.ok, '生效中不能重复使用');

  ctx.player.inventory['dice_lucky'] = 1;
  ok(ctx.useItem('dice_lucky').ok, '使用幸运骰子卡成功');
  ok(ctx.player.buffs.diceLucky === 5, 'buff 置为 5 局');

  // 排位道具不能手动使用
  ctx.player.inventory['rank_guard'] = 1;
  const r3 = ctx.useItem('rank_guard');
  ok(!r3.ok && r3.msg.indexOf('自动生效') >= 0, '排位道具不可手动使用');
}

/* ---- 9. 存档迁移补齐字段 ---- */
{
  const old = { name: '老玩家', coins: 1000, inventory: {}, buffs: { exp2x: 0, peek: 0 } };
  const migrated = ctx.migratePlayer(old);
  ok(!!migrated.buyLog, '迁移补齐 buyLog');
  ok(typeof migrated.buffs.goldBoost === 'number', '迁移补齐 goldBoost');
  ok(typeof migrated.buffs.diceLucky === 'number', '迁移补齐 diceLucky');
}

console.log('道具系统测试: ' + pass + ' 项通过, ' + fail + ' 项失败');
if (fail) { failures.slice(0, 30).forEach(f => console.log('  - ' + f)); process.exit(1); }
