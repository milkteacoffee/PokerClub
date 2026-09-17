/* 联机称号 + 联机战绩 测试
   验证：v16 存档字段、联机战绩累加、8 个联机称号的解锁边界、称号总数、老档迁移。
   采用与 test.js 相同的「IIFE 去壳 + vm 沙箱」手法，以便访问内部函数。 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('✗ 未找到 script 块'); process.exit(1); }
const src = m[1];
const stripped = src
  .replace(/\(function \(\) \{\s*'use strict';/, '')
  .replace(/\}\)\(\);\s*$/, '');
if (stripped === src) { console.error('✗ IIFE 去壳失败'); process.exit(1); }

/* ---------------- 用 jsdom 提供完整 DOM，脚本去壳后跑在 vm 里 ---------------- */
const { JSDOM, VirtualConsole } = require('jsdom');
const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/Not implemented/.test(e.message)) console.log('  [jsdom] ' + e.message); });
const dom = new JSDOM(html, { pretendToBeVisual: true, url: 'https://localhost/', virtualConsole: vc });
const win = dom.window, doc = win.document;

const storage = new Map();
const sandbox = {
  document: doc,
  window: win,
  navigator: win.navigator,
  screen: win.screen,
  location: win.location,
  localStorage: {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k),
  },
  performance: { now: () => Date.now() },
  requestAnimationFrame: (fn) => 1,
  cancelAnimationFrame: () => {},
  setTimeout: (fn) => setImmediate(fn),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: () => 1,
  clearInterval: () => {},
  console,
  Math, JSON, Object, Array, Date, parseInt, parseFloat, isNaN, isFinite,
  String, Number, Boolean, Error, Promise, Map, Set, Symbol,
  fetch: undefined,
};
sandbox.globalThis = sandbox;
/* 让 window 上的属性也能从全局访问（脚本同时用两种写法） */
['addEventListener', 'removeEventListener', 'innerWidth', 'innerHeight', 'matchMedia',
 'AudioContext', 'webkitAudioContext', 'requestAnimationFrame', 'cancelAnimationFrame'].forEach(k => {
  try {
    const v = win[k];
    if (typeof v === 'function') sandbox[k] = v.bind(win); else if (v !== undefined) sandbox[k] = v;
  } catch (_) {}
});

const ctx = vm.createContext(sandbox);
try {
  vm.runInContext(stripped, ctx, { filename: 'game.js' });
} catch (e) {
  console.error('✗ 脚本载入失败:', e.message, '\n', e.stack);
  console.log('联机称号测试: 0 项通过, 1 项失败');
  process.exit(1);
}

/* ---------------- 断言 ---------------- */
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.log('  ✗ ' + msg); }
}

const g = ctx;
function has(fn) { return typeof g[fn] === 'function'; }

console.log('=== 联机称号与战绩 ===');

/* 1. 基础设施（联机战绩累加器在主作用域，可直接单测） */
ok(has('onlineStat'), 'onlineStat(p,key) 已定义');
ok(has('onlineGame'), 'onlineGame(p,game,key) 已定义');
ok(has('addOnlineRecord'), 'addOnlineRecord(p,game,won) 已定义（联机战绩累加）');

/* 2. 存档版本与字段 */
ok(g.SAVE_VERSION === 16, 'SAVE_VERSION=16（实际 ' + g.SAVE_VERSION + '）');
const np = g.createNewPlayer('测试');
ok(!!np.online && typeof np.online === 'object', '新档含 player.online');
ok(np.online.games === 0 && np.online.wins === 0, 'online 初始计数为 0');
ok(!!np.online.byGame, 'online.byGame 存在');
ok(np.buffs.goldBoost === 0 && np.buffs.diceLucky === 0, 'buffs 含 goldBoost/diceLucky');

/* 3. 称号注册 */
const titles = g.TITLES || [];
const onlineTitles = titles.filter(t => String(t.id).indexOf('tt_online') === 0);
ok(onlineTitles.length === 13, '联机称号共 13 个（8 通用 + 5 新增玩法专属，实际 ' + onlineTitles.length + '）');
ok(titles.length === 67, '称号总数 67（2026-09-17 富化 +20，实际 ' + titles.length + '）');

/* 4. 战绩累加 */
const pl = g.createNewPlayer('牌友');

ok(g.onlineStat(pl, 'games') === 0, '初始 games=0');
g.addOnlineRecord(pl, 'holdem', true);
ok(g.onlineStat(pl, 'games') === 1, '胜局后 games=1');
ok(g.onlineStat(pl, 'wins') === 1, '胜局后 wins=1');
ok(g.onlineStat(pl, 'losses') === 0, '胜局后 losses=0');
ok(g.onlineStat(pl, 'streak') === 1, '胜局后 streak=1');
ok(g.onlineStat(pl, 'maxStreak') === 1, '胜局后 maxStreak=1');

g.addOnlineRecord(pl, 'holdem', true);
ok(g.onlineStat(pl, 'maxStreak') === 2, '连胜累积 maxStreak=2');

g.addOnlineRecord(pl, 'guandan', false);
ok(g.onlineStat(pl, 'streak') === 0, '败局清空当前连胜');
ok(g.onlineStat(pl, 'maxStreak') === 2, '败局保留 maxStreak');
ok(g.onlineStat(pl, 'losses') === 1, '败局后 losses=1');

ok(g.onlineGame(pl, 'holdem', 'games') === 2, 'holdem 计 2 局');
ok(g.onlineGame(pl, 'holdem', 'wins') === 2, 'holdem 胜 2 局');
ok(g.onlineGame(pl, 'guandan', 'games') === 1, 'guandan 计 1 局');
ok(g.onlineGame(pl, 'guandan', 'wins') === 0, 'guandan 胜 0 局');

/* 容错：online 缺失/半损时也能累加，不抛错 */
const broken = { name: 'X' };
g.addOnlineRecord(broken, 'holdem', true);
ok(broken.online && broken.online.games === 1, 'online 缺失时自动初始化并累加');
const half = { name: 'Y', online: { games: 3 } };
g.addOnlineRecord(half, 'holdem', false);
ok(half.online.games === 4 && half.online.losses === 1, '半损 online 补齐字段并累加');
ok(g.addOnlineRecord(null, 'holdem', true) === null, '空玩家安全返回 null');

/* 5. 称号解锁边界 */
const byId = {};
titles.forEach(t => byId[t.id] = t);
function pOnline(o) {
  const p = g.createNewPlayer('边界');
  p.online = Object.assign({ games: 0, wins: 0, losses: 0, streak: 0, maxStreak: 0, byGame: {} }, o);
  return p;
}
ok(byId.tt_online_1.check(pOnline({ games: 0 })) === false, '初入牌局：0 局不解锁');
ok(byId.tt_online_1.check(pOnline({ games: 1 })) === true, '初入牌局：1 局解锁');
ok(byId.tt_online_10.check(pOnline({ games: 9 })) === false, '常来常往：9 局不解锁');
ok(byId.tt_online_10.check(pOnline({ games: 10 })) === true, '常来常往：10 局解锁');
ok(byId.tt_online_50.check(pOnline({ games: 49 })) === false, '牌友满座：49 局不解锁');
ok(byId.tt_online_50.check(pOnline({ games: 50 })) === true, '牌友满座：50 局解锁');
ok(byId.tt_online_win_1.check(pOnline({ wins: 0 })) === false, '开张大吉：0 胜不解锁');
ok(byId.tt_online_win_1.check(pOnline({ wins: 1 })) === true, '开张大吉：1 胜解锁');
ok(byId.tt_online_win_20.check(pOnline({ wins: 19 })) === false, '房中之王：19 胜不解锁');
ok(byId.tt_online_win_20.check(pOnline({ wins: 20 })) === true, '房中之王：20 胜解锁');
ok(byId.tt_online_win_100.check(pOnline({ wins: 99 })) === false, '一方霸主：99 胜不解锁');
ok(byId.tt_online_win_100.check(pOnline({ wins: 100 })) === true, '一方霸主：100 胜解锁');
ok(byId.tt_online_streak5.check(pOnline({ maxStreak: 4 })) === false, '五连霸桌：4 连不解锁');
ok(byId.tt_online_streak5.check(pOnline({ maxStreak: 5 })) === true, '五连霸桌：5 连解锁');
ok(byId.tt_online_both.check(pOnline({ byGame: { guandan: { games: 9 }, holdem: { games: 10 } } })) === false, '双修：掼蛋 9 局不解锁');
ok(byId.tt_online_both.check(pOnline({ byGame: { guandan: { games: 10 }, holdem: { games: 10 } } })) === true, '双修：各 10 局解锁');

/* 6. 老档迁移 */
const legacy = g.createNewPlayer('老档');
delete legacy.online;
delete legacy.buffs.goldBoost;
const migrated = g.migratePlayer(legacy);
ok(!!migrated.online && typeof migrated.online === 'object', '老档迁移补齐 online');
ok(migrated.online.games === 0, '迁移后 online.games=0');
ok(migrated.buffs.goldBoost === 0, '迁移后 buffs.goldBoost=0');
ok(migrated.version === 16, '迁移后 version=16');

/* 7. 称号不可购买 */
ok((g.SHOP_ITEMS || []).every(i => String(i.id).indexOf('tt_online') !== 0), '联机称号未出现在商城中');

/* 8. 商城道具：15 件；所有非皮肤商品都必须有限购（用户要求「每个道具都限购」） */
const shop = g.SHOP_ITEMS || [];
ok(shop.length === 15, '商城商品 15 件（实际 ' + shop.length + '）');
const consumables = shop.filter(i => i.type !== 'skin');
ok(consumables.length === 7, '消耗/排位类道具 7 件（实际 ' + consumables.length + '）');
const noLimit = consumables.filter(i => !i.limits || typeof i.limits.day !== 'number');
ok(noLimit.length === 0, '所有消耗/排位道具都有日限购（缺失：' + noLimit.map(i => i.id).join(',') + '）');
const noWeek = consumables.filter(i => !i.limits || typeof i.limits.week !== 'number');
ok(noWeek.length === 0, '所有消耗/排位道具都有周限购');
const noHold = consumables.filter(i => !i.limits || typeof i.limits.hold !== 'number');
ok(noHold.length === 0, '所有消耗/排位道具都有持有上限');
/* 皮肤是一次性购买，不应重复购买 */
const skins = shop.filter(i => i.type === 'skin');
ok(skins.length === 8, '外观类 8 件（实际 ' + skins.length + '）');
ok(skins.every(i => i.slot), '每件外观都有 slot（牌背/边框/称号）');
/* 限购数值合理性：日 ≤ 周 ≤ 持有×若干，且持有上限 ≥ 1 */
const bad = consumables.filter(i => {
  const L = i.limits || {};
  return !(L.hold >= 1 && L.day >= 1 && L.week >= L.day);
});
ok(bad.length === 0, '限购数值合理（日≤周 且 持有≥1）（异常：' + bad.map(i => i.id).join(',') + '）');
/* 排位道具必须存在且为 2 件 */
const rankItems = shop.filter(i => i.type === 'rank');
ok(rankItems.length === 2, '排位道具 2 件：保护卡 + 翻倍卡（实际 ' + rankItems.length + '）');

console.log(`\n联机称号测试: ${pass} 项通过, ${fail} 项失败`);
process.exit(fail ? 1 : 0);
