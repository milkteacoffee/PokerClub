/**
 * 排位积分规则测试（jsdom）
 * 规则：初始 0 分 / 满 10 分才能开局 / 单局胜 5~10、负 5~10 / 低于 10 分视为输光直接归零 /
 *       兑换：仅 0 分时可用、每天 1 次、单次与每日上限均 100 分、100 金币 = 1 分 /
 *       每日赠送：只有在积分为 0 时每天送 10 分。
 * 运行: node tests/ranked-points.test.js
 */
'use strict';
const fs = require('fs');
const assert = require('assert');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync(require('path').join(__dirname, '../index.html'), 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  .replace(/\(function \(\) \{\s*'use strict';/, '')
  .replace(/\}\)\(\);\s*$/, '')
  .replace(/  init\(\);/, '');
const dom = new JSDOM(html.replace(/<script>[\s\S]*?<\/script>/, ''), { url: 'https://rp.test', runScripts: 'outside-only' });
const w = dom.window;
w.setTimeout = () => 0;
w.requestAnimationFrame = () => 0;
w.eval(code);
w.loadAllSaves();
w.initArcade();
w.bindEvents();

let n = 0;
function test(name, fn) { fn(); n++; console.log('PASS ' + name); }
const doc = w.document;
function fresh(game) {
  w.G.active = false;
  w.G.players = [];
  w.Arcade.round = null;
  w.player.rankedPending = null;
  w.player.arcade.pending = null;
  w.createNewSaveAt(1);
  w.hubGame = game || 'holdem';
  w.App.mode = 'ranked';
  w.App.difficulty = 'easy';
}
function enter(game, key) {
  const start = w.startGame, cnt = { n: 0 };
  w.startGame = () => { cnt.n++; };
  const ok = w.tryEnterGame(key || 'easy');
  w.startGame = start;
  return { ok, started: cnt.n };
}

/* ---------------- 常量与门槛 ---------------- */

test('排位积分初始为 0，门槛 10 分，兑换与赠送规则明确', () => {
  fresh();
  assert.equal(w.profile15('holdem').rankPoints, 0, '新档排位积分从 0 开始');
  assert.equal(w.RANKED_ENTRY_MIN, 10, '门槛应为 10 分');
  assert.equal(w.RANK_DAILY_GIFT, 10, '每日赠送 10 分');
  assert.deepEqual(w.RANK_EXCHANGE, { perTime: 100, dailyCap: 100, timesPerDay: 1, coinPerPoint: 100 });
  w.GAME_IDS.forEach(g => assert.equal(w.profile15(g).rankPoints, 0, g + ' 初始 0 分'));
});

test('不满 10 分不能开始排位对局', () => {
  fresh();
  const s = w.profile15('holdem');
  s.rankPoints = 9;
  s.giftDate = w.todayStr();            /* 排除赠送干扰，只测门槛 */
  let r = enter('holdem');
  assert.equal(r.ok, false, '9 分不得进场');
  assert.equal(r.started, 0);
  s.rankPoints = w.RANKED_ENTRY_MIN;
  r = enter('holdem');
  assert.equal(r.ok, true, '满 10 分可以进场');
  assert.equal(r.started, 1);
});

test('小游戏排位同样受门槛限制（内部入口也拦）', () => {
  w.createNewSaveAt(1);
  w.hubGame = 'dice';
  w.App.mode = 'ranked';
  w.Arcade.mode = 'ranked';
  w.G.active = false;
  w.Arcade.round = null;
  w.player.arcade.pending = null;
  const s = w.profile15('dice');
  s.rankPoints = 5;
  s.giftDate = w.todayStr();
  assert.equal(w.openArcade('dice'), false, '内部入口同样拒绝');
  assert.equal(w.App.screen !== 'arcade', true);
  s.rankPoints = w.RANKED_ENTRY_MIN;
  assert.equal(w.openArcade('gold'), true, '满 10 分可进入（金花）');
  w.arcadeLeave(true);
});

/* ---------------- 单局加减与归零 ---------------- */

test('单局胜 +5~+10、负 -5~-10（按档位），平局不变', () => {
  w.RANK_POINT_WIN.forEach(v => assert.ok(v >= 5 && v <= 10, '胜场 ' + v + ' 应在 5~10'));
  w.RANK_POINT_LOSS.forEach(v => assert.ok(v >= 5 && v <= 10, '负场 ' + v + ' 应在 5~10'));
  fresh();
  const s = w.profile15('holdem');
  w.GAME_LEVELS.forEach((key, i) => {
    s.rankPoints = 500;
    s.tierReward = w.rankTierFor(500);
    s.redeemPoints = 0;
    w.applyRankResult15('holdem', key, 1);
    assert.equal(s.rankPoints, 500 + w.RANK_POINT_WIN[i], key + ' 胜');
    w.applyRankResult15('holdem', key, -1);
    assert.equal(s.rankPoints, 500 + w.RANK_POINT_WIN[i] - w.RANK_POINT_LOSS[i], key + ' 负');
    const mid = s.rankPoints;
    w.applyRankResult15('holdem', key, 0);
    assert.equal(s.rankPoints, mid, key + ' 平局不变');
  });
});

test('低于 10 分视为输光，直接归零', () => {
  fresh();
  const s = w.profile15('holdem');
  s.rankPoints = 12;                     /* 12 - 5~10 会落到 2~7 */
  w.applyRankResult15('holdem', 'easy', -1);
  assert.equal(s.rankPoints, 0, '12 分输一局应归零而不是留 7 分，实际 ' + s.rankPoints);
  s.rankPoints = 10;
  w.applyRankResult15('holdem', 'easy', -1);
  assert.equal(s.rankPoints, 0, '10 分输一局归零');
  s.rankPoints = 30;
  w.applyRankResult15('holdem', 'easy', -1);
  assert.equal(s.rankPoints, 30 - w.RANK_POINT_LOSS[0], '还有余量时正常扣分');
  /* 输光后打不了，只能等第二天赠送或兑换 */
  s.giftDate = w.todayStr();
  s.rankPoints = 0;
  assert.equal(enter('holdem').ok, false, '0 分无法进场');
});

/* ---------------- 每日赠送 ---------------- */

test('积分为 0 时每天系统赠送 10 分，一天只送一次', () => {
  fresh();
  const s = w.profile15('holdem');
  assert.equal(s.rankPoints, 0);
  assert.equal(w.rankGiftAvailable('holdem'), true, '0 分且今日未领，可赠送');
  assert.equal(w.ensureRankGift('holdem', { silent: true }), w.RANK_DAILY_GIFT, '应赠送 10 分');
  assert.equal(s.rankPoints, 10, '赠送后刚好够开局门槛');
  assert.equal(w.rankGiftAvailable('holdem'), false, '今日已赠送');
  assert.equal(w.ensureRankGift('holdem', { silent: true }), 0, '同一天不重复赠送');
  assert.equal(s.rankPoints, 10);
});

test('积分不为 0 时不给赠送；输光后可再领第二天的赠送', () => {
  fresh();
  const s = w.profile15('holdem');
  s.rankPoints = 40;
  s.giftDate = '';
  assert.equal(w.rankGiftAvailable('holdem'), false, '有积分就不赠送');
  assert.equal(w.ensureRankGift('holdem', { silent: true }), 0);
  assert.equal(s.rankPoints, 40);
  /* 输光 → 领今天赠送 → 再输光 → 明天才能再领 */
  s.rankPoints = 0;
  assert.equal(w.ensureRankGift('holdem', { silent: true }), 10);
  s.rankPoints = 0;
  assert.equal(w.ensureRankGift('holdem', { silent: true }), 0, '同一天不再赠送');
  s.giftDate = '2000-01-01';             /* 模拟到了新的一天 */
  s.rankPoints = 0;
  assert.equal(w.ensureRankGift('holdem', { silent: true }), 10, '跨天恢复赠送');
});

test('跨天刷新会给 0 分的馆补赠送', () => {
  fresh();
  w.profile15('holdem').giftDate = '2000-01-01';
  w.profile15('dice').rankPoints = 50;
  w.profile15('dice').giftDate = '2000-01-01';
  w.renderLobby();
  w.refreshPeriodic({ toast: false });
  assert.equal(w.profile15('holdem').rankPoints, w.RANK_DAILY_GIFT, '0 分的馆补 10 分');
  assert.equal(w.profile15('dice').rankPoints, 50, '有积分的馆不赠送');
});

test('进场前会自动结算当天赠送', () => {
  fresh();
  w.player.coins = 5000;
  const s = w.profile15('holdem');
  s.rankPoints = 0;
  s.giftDate = '';
  const r = enter('holdem');
  assert.equal(s.rankPoints, w.RANK_DAILY_GIFT, '进场时先发赠送');
  assert.equal(r.ok, true, '赠送后刚好够门槛可以开局');
});

/* ---------------- 每日兑换 ---------------- */

test('仅积分为 0 时可兑换，且每天只能兑换 1 次', () => {
  fresh();
  w.player.coins = 100000;
  const s = w.profile15('holdem');
  s.giftDate = w.todayStr();             /* 置为已赠送，便于单独观察兑换 */
  s.rankPoints = 5;
  assert.ok(w.rankExchangeBlockedReason('holdem').includes('仅排位积分为 0'), '非 0 分应说明原因');
  assert.equal(w.exchangeRankedPoints('holdem'), false, '非 0 分不得兑换');
  assert.equal(s.rankPoints, 5);
  s.rankPoints = 0;
  assert.equal(w.rankExchangeBlockedReason('holdem'), '');
  assert.equal(w.exchangeRankedPoints('holdem'), true, '0 分时可以兑换');
  assert.equal(s.rankPoints, 100, '默认换满上限 100 分');
  assert.equal(w.player.coins, 100000 - 100 * w.RANK_EXCHANGE.coinPerPoint, '按 100 金币 = 1 分扣费');
  assert.equal(w.rankExchangeLeft(), 0, '每天只有 1 次');
  s.rankPoints = 0;
  assert.ok(w.rankExchangeBlockedReason('holdem').includes('次数已用完'));
  assert.equal(w.exchangeRankedPoints('holdem'), false, '同一天第二次应被拒');
});

test('单次与每日上限都是 100 分，可以少换', () => {
  fresh();
  w.player.coins = 100000;
  const s = w.profile15('holdem');
  s.giftDate = w.todayStr();
  s.rankPoints = 0;
  assert.equal(w.exchangeRankedPoints('holdem', 101), false, '超过单次上限应被拒');
  assert.ok(w.rankExchangeBlockedReason('holdem', 101).includes('单次最多兑换'));
  assert.equal(w.exchangeRankedPoints('holdem', 60), true, '可以少换');
  assert.equal(s.rankPoints, 60);
  assert.equal(w.ensureRankExchange().gained, 60, '记录今日已兑换额度');
  assert.equal(w.rankExchangeQuota(), 40, '每日额度相应减少');
});

test('金币不足时兑换失败且不改动积分与次数', () => {
  fresh();
  w.player.coins = 100 * 100 - 1;
  const s = w.profile15('holdem');
  s.giftDate = w.todayStr();
  s.rankPoints = 0;
  assert.ok(w.rankExchangeBlockedReason('holdem').includes('金币不足'));
  assert.equal(w.exchangeRankedPoints('holdem'), false);
  assert.equal(w.profile15('holdem').rankPoints, 0);
  assert.equal(w.rankExchangeLeft(), 1, '失败不消耗次数');
});

test('兑换写入失败时整体回滚（金币、积分、次数都不变）', () => {
  fresh();
  w.player.coins = 50000;
  const s = w.profile15('holdem');
  s.giftDate = w.todayStr();
  s.rankPoints = 0;
  const coins0 = w.player.coins;
  const proto = Object.getPrototypeOf(w.localStorage);
  const old = proto.setItem;
  proto.setItem = () => { throw new Error('QuotaExceededError'); };
  const ok = w.exchangeRankedPoints('holdem');
  proto.setItem = old;
  assert.equal(ok, false, '存储失败应拒绝');
  assert.equal(w.profile15('holdem').rankPoints, 0, '积分不加');
  assert.equal(w.player.coins, coins0, '金币不扣');
  assert.equal(w.rankExchangeLeft(), 1, '次数不消耗');
});

test('兑换额度跨天重置', () => {
  fresh();
  w.player.coins = 100000;
  w.player.rankExchange = { date: '2000-01-01', used: 1, gained: 100 };
  assert.equal(w.rankExchangeLeft(), 1, '跨天后次数恢复');
  assert.equal(w.rankExchangeQuota(), 100, '跨天后额度恢复');
  const s = w.profile15('holdem');
  s.giftDate = w.todayStr();
  s.rankPoints = 0;
  assert.equal(w.exchangeRankedPoints('holdem'), true);
  assert.equal(s.rankPoints, 100);
});

/* ---------------- 快捷局与界面 ---------------- */

test('快捷局不产出排位积分', () => {
  fresh();
  w.App.mode = 'quick';
  w.player.coins = 50000;
  const s = w.profile15('holdem');
  s.rankPoints = 0;
  s.giftDate = w.todayStr();
  assert.equal(enter('holdem').ok, true, '快捷局不需要排位积分');
  assert.equal(s.rankPoints, 0, '快捷局不改变排位积分');
});

test('模式界面显示门槛 10、每日赠送与兑换额度', () => {
  fresh();
  w.player.coins = 50000;
  const s = w.profile15('holdem');
  s.rankPoints = 0;
  s.giftDate = '';
  w.renderModeCards();
  const bar = doc.getElementById('modeRankBar');
  assert.equal(bar.hidden, false);
  const text = bar.textContent;
  w.renderRank();
  const rtext = doc.getElementById('rankPanel').textContent;
  assert.ok(rtext.includes('10 分'), '段位面板应说明 10 分门槛');
  assert.ok(rtext.includes('+5'), '段位面板应显示胜局区间');
  assert.ok(rtext.includes('赠送 10 分'), '段位面板应说明每日赠送');
  assert.ok(text.includes('今日兑换 0 / 1 次'), '兑换条应显示每日 1 次');
  assert.equal(s.rankPoints, w.RANK_DAILY_GIFT, '打开模式界面时自动发放赠送');
  /* 已送满 10 分 → 可以开局；兑换按钮因积分不为 0 而禁用 */
  const btn = doc.getElementById('rankedExchangeBtn');
  assert.ok(btn, '应有兑换按钮');
  assert.equal(btn.disabled, true, '非 0 分时兑换按钮禁用');
});

test('段位面板展示门槛、赠送与兑换入口', () => {
  fresh();
  w.player.coins = 50000;
  const s = w.profile15('holdem');
  s.rankPoints = 0;
  s.giftDate = w.todayStr();
  w.renderRank();
  const text = doc.getElementById('rankPanel').textContent;
  assert.ok(text.includes('10 分') || text.includes('排位规则'), '应说明排位规则（精简版）');
  assert.ok(text.includes('胜 +5'), '应显示单局加分');
  assert.ok(text.includes('今日赠送已领取'), '应显示赠送状态');
  assert.ok(text.includes('今日已兑换 0 / 100 分'), '应显示每日兑换额度');
  const btn = doc.getElementById('rankExchangeBtn15');
  assert.ok(btn, '段位面板应提供兑换按钮');
  assert.equal(btn.disabled, false, '0 分且金币充足时可兑换');
  btn.click();
  assert.equal(w.profile15('holdem').rankPoints, 100);
});

console.log('TOTAL ' + n);
dom.window.close();
process.exit(0);
