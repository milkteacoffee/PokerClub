/**
 * 排位积分规则测试（jsdom）
 * 覆盖：初始 0 分 / 满 100 分才能开始排位 / 单局胜 5~10、负 5~10 / 掉到 0 无法再排位 /
 *       每日兑换：仅在积分为 0 时可换、每次最多 100、每天最多 3 次、100 金币=1 分、跨天重置 /
 *       快捷局不产出排位积分 / 模式界面与段位面板的提示与按钮状态。
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
const card = (r, s = 0) => ({ r, s });
function rig(cards) { const sh = w.shuffle; w.shuffle = () => cards.slice().reverse(); return () => w.shuffle = sh; }
function fresh(game) {
  w.G.active = false;
  w.G.players = [];
  w.Arcade.round = null;
  w.player.rankedPending = null;
  w.player.arcade.pending = null;
  w.createNewSaveAt(1);
  w.hubGame = game || 'holdem';
  w.App.mode = 'ranked';
  App: w.App.difficulty = 'easy';
}
function rankedEnter(game, key) {
  const start = w.startGame, cnt = { n: 0 };
  w.startGame = () => { cnt.n++; };
  const ok = w.tryEnterGame(key || 'easy');
  w.startGame = start;
  return { ok, started: cnt.n };
}

/* ---------------- 初始与门槛 ---------------- */

test('排位积分初始为 0，门槛常量与兑换规则明确', () => {
  fresh();
  assert.equal(w.profile15('holdem').rankPoints, 0, '新档排位积分从 0 开始');
  assert.equal(w.RANKED_ENTRY_MIN, 100);
  assert.deepEqual(w.RANK_EXCHANGE, { perTime: 100, timesPerDay: 3, coinPerPoint: 100 });
  w.GAME_IDS.forEach(g => assert.equal(w.profile15(g).rankPoints, 0, g + ' 初始 0 分'));
});

test('积分不满 100 不能开始排位对局', () => {
  fresh();
  const s = w.profile15('holdem');
  s.rankPoints = 99;
  let r = rankedEnter('holdem');
  assert.equal(r.ok, false, '99 分不得进场');
  assert.equal(r.started, 0, '不得进入牌桌');
  s.rankPoints = 0;
  r = rankedEnter('holdem');
  assert.equal(r.ok, false, '0 分不得进场');
  s.rankPoints = w.RANKED_ENTRY_MIN;
  r = rankedEnter('holdem');
  assert.equal(r.ok, true, '满 100 分可以进场');
  assert.equal(r.started, 1);
});

test('小游戏排位同样受 100 分门槛限制', () => {
  w.G.active = false;
  w.Arcade.round = null;
  w.player.arcade.pending = null;
  w.createNewSaveAt(1);
  w.hubGame = 'dice';
  w.App.mode = 'ranked';
  w.Arcade.mode = 'ranked';
  assert.equal(w.profile15('dice').rankPoints, 0);
  assert.equal(w.openArcade('dice'), false, '内部入口同样拒绝');
  assert.equal(w.App.screen !== 'arcade' || !w.Arcade.game, true);
  const start = w.startGame;
  w.startGame = () => {};
  assert.equal(w.tryEnterGame('easy'), false, '0 分不得进入小游戏排位');
  w.profile15('dice').rankPoints = 99;
  assert.equal(w.tryEnterGame('easy'), false, '99 分不得进入');
  w.profile15('dice').rankPoints = w.RANKED_ENTRY_MIN;
  assert.equal(w.tryEnterGame('easy'), true, '满 100 分可进入');
  w.startGame = start;
  w.arcadeLeave(true);
});

/* ---------------- 单局加减 ---------------- */

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

test('掉到 0 分后无法再开始排位，必须先兑换', () => {
  fresh();
  w.player.coins = 100000;
  const s = w.profile15('holdem');
  s.rankPoints = 100;
  const start = w.startGame;
  w.startGame = () => {};
  assert.equal(w.tryEnterGame('easy'), true, '100 分先打一局');
  w.G.active = false;
  /* 连输到 0 */
  for (let i = 0; i < 30; i++) w.applyRankResult15('holdem', 'champion', -1);
  assert.equal(s.rankPoints, 0, '最低扣到 0');
  assert.equal(w.tryEnterGame('easy'), false, '0 分无法再进场');
  w.startGame = start;
});

/* ---------------- 每日兑换 ---------------- */

test('仅当积分为 0 时可兑换，非 0 分被拒绝', () => {
  fresh();
  w.player.coins = 100000;
  const s = w.profile15('holdem');
  s.rankPoints = 5;
  assert.ok(w.rankExchangeBlockedReason('holdem').includes('仅排位积分为 0'), '非 0 分应说明原因');
  assert.equal(w.exchangeRankedPoints('holdem', 100), false, '非 0 分不得兑换');
  assert.equal(s.rankPoints, 5, '被拒绝时不加分');
  s.rankPoints = 0;
  assert.equal(w.rankExchangeBlockedReason('holdem'), '');
  assert.equal(w.exchangeRankedPoints('holdem', 100), true, '0 分时可以兑换');
  assert.equal(s.rankPoints, 100, '兑换到 100 分刚好够排位门槛');
  assert.equal(w.player.coins, 100000 - 100 * w.RANK_EXCHANGE.coinPerPoint, '按 100 金币 = 1 分扣费');
});

test('每次最多兑换 100 分', () => {
  fresh();
  w.player.coins = 100000;
  const s = w.profile15('holdem');
  s.rankPoints = 0;
  assert.ok(w.rankExchangeBlockedReason('holdem', 101).includes('单次最多'), '超过 100 分应被拒');
  assert.equal(w.exchangeRankedPoints('holdem', 101), false);
  assert.equal(w.exchangeRankedPoints('holdem', 0), false, '0 分不合法');
  assert.equal(w.exchangeRankedPoints('holdem', 60), true, '可以少换');
  assert.equal(s.rankPoints, 60);
});

test('每天最多兑换 3 次，跨天重置', () => {
  fresh();
  w.player.coins = 100000;
  const s = w.profile15('holdem');
  assert.equal(w.rankExchangeLeft(), 3);
  for (let i = 0; i < 3; i++) {
    s.rankPoints = 0;                     /* 每次兑换后要重新归零才能再换 */
    assert.equal(w.exchangeRankedPoints('holdem', 100), true, '第 ' + (i + 1) + ' 次应成功');
  }
  assert.equal(w.rankExchangeLeft(), 0);
  s.rankPoints = 0;
  assert.ok(w.rankExchangeBlockedReason('holdem').includes('次数已用完'));
  assert.equal(w.exchangeRankedPoints('holdem', 100), false, '第 4 次应被拒');
  /* 跨天重置 */
  w.player.rankExchange = { date: '2000-01-01', used: 3 };
  assert.equal(w.rankExchangeLeft(), 3, '跨天后次数恢复');
  s.rankPoints = 0;
  assert.equal(w.exchangeRankedPoints('holdem', 100), true);
  assert.equal(w.ensureRankExchange().date, w.todayStr());
});

test('金币不足时兑换失败且不改动积分与次数', () => {
  fresh();
  w.player.coins = 100 * 100 - 1;
  const s = w.profile15('holdem');
  s.rankPoints = 0;
  assert.ok(w.rankExchangeBlockedReason('holdem').includes('金币不足'));
  assert.equal(w.exchangeRankedPoints('holdem', 100), false);
  assert.equal(s.rankPoints, 0);
  assert.equal(w.rankExchangeLeft(), 3, '失败不消耗次数');
});

test('兑换写入失败时整体回滚（金币与积分都不变）', () => {
  fresh();
  w.player.coins = 50000;
  const s = w.profile15('holdem');
  s.rankPoints = 0;
  const coins0 = w.player.coins;
  const proto = Object.getPrototypeOf(w.localStorage);
  const old = proto.setItem;
  proto.setItem = () => { throw new Error('QuotaExceededError'); };
  const ok = w.exchangeRankedPoints('holdem', 100);
  proto.setItem = old;
  assert.equal(ok, false, '存储失败应拒绝');
  /* 回滚会整体替换 player，需要重新取一次档案对象再断言 */
  assert.equal(w.profile15('holdem').rankPoints, 0, '积分不加');
  assert.equal(w.player.coins, coins0, '金币不扣');
  assert.equal(w.rankExchangeLeft(), 3, '次数不消耗');
});

/* ---------------- 快捷局不产出 ---------------- */

test('快捷局不再产出排位积分', () => {
  fresh();
  w.App.mode = 'quick';
  const s = w.profile15('holdem');
  s.rankPoints = 0;
  w.player.coins = 50000;
  const start = w.startGame;
  w.startGame = () => {};
  assert.equal(w.tryEnterGame('easy'), true, '快捷局不需要排位积分');
  w.startGame = start;
  assert.equal(s.rankPoints, 0, '快捷局不改变排位积分');
});

/* ---------------- 界面 ---------------- */

test('模式界面显示排位门槛、单局区间与兑换按钮状态', () => {
  fresh();
  w.player.coins = 50000;
  w.renderModeCards();
  const bar = doc.getElementById('modeRankBar');
  assert.equal(bar.hidden, false, '模式界面应显示排位积分条');
  let text = bar.textContent;
  assert.ok(text.includes('排位积分'), '应显示排位积分');
  assert.ok(text.includes('门槛 100'), '应显示 100 分门槛，实际：' + text.slice(0, 60));
  assert.ok(text.includes('+5'), '应显示胜局加分区间');
  assert.ok(text.includes('-10'), '应显示负局扣分区间');
  assert.ok(text.includes('今日兑换 0 / 3'), '应显示今日兑换次数');
  let btn = doc.getElementById('rankedExchangeBtn');
  assert.ok(btn, '应有兑换按钮');
  assert.equal(btn.disabled, false, '0 分且金币充足时可兑换');
  btn.click();
  assert.equal(w.profile15('holdem').rankPoints, 100, '点按钮完成兑换');
  text = doc.getElementById('modeRankBar').textContent;
  assert.ok(text.includes('今日兑换 1 / 3'), '兑换后次数递增，实际：' + text.slice(0, 80));
  assert.equal(doc.getElementById('rankedExchangeBtn').disabled, true, '已非 0 分，按钮禁用');
});

test('段位面板展示排位门槛与兑换入口', () => {
  fresh();
  w.player.coins = 50000;
  w.profile15('holdem').rankPoints = 0;
  w.renderRank();
  const panel = doc.getElementById('rankPanel');
  const text = panel.textContent;
  assert.ok(text.includes('攒够 100 分才能开始排位对局'), '应说明门槛');
  assert.ok(text.includes('胜 +5'), '应显示单局加分');
  assert.ok(text.includes('都要门票'), '应说明门票规则');
  const btn = doc.getElementById('rankExchangeBtn15');
  assert.ok(btn, '段位面板应提供兑换按钮');
  btn.click();
  assert.equal(w.profile15('holdem').rankPoints, 100);
});

console.log('TOTAL ' + n);
dom.window.close();
process.exit(0);
