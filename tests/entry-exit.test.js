/**
 * 门票与退出路径测试（jsdom）
 * 覆盖：统一门票表 / 金币场与排位都收门票 / 练习场免费 / 余额不足拒绝进场 /
 *       进场扣费落入事务 / 小游戏与德州退出都回到「选择模式」而不是大厅 /
 *       骰子同轮多押（单注上限 vs 单轮上限）/ 中奖与未中奖档位的返还与扣除。
 * 运行: node tests/entry-exit.test.js
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
const dom = new JSDOM(html.replace(/<script>[\s\S]*?<\/script>/, ''), { url: 'https://ee.test', runScripts: 'outside-only' });
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
function enter(game, mode, difficulty) {
  w.G.active = false;
  w.Arcade.round = null;
  w.player.arcade = { stats: {}, pending: null, history: [] };
  w.hubGame = game;
  w.App.difficulty = difficulty || 'easy';
  w.Arcade.difficulty = difficulty || 'easy';
  w.App.mode = mode === 'ranked' ? 'ranked' : 'quick';
  w.Arcade.mode = mode || 'coins';
  /* 排位需要满 100 排位积分才能进场 */
  if (mode === 'ranked') w.profile15(game).rankPoints = w.RANKED_ENTRY_MIN;
  if (game !== 'holdem') return w.openArcade(game);
  const start = w.startGame, started = { n: 0 };
  w.startGame = () => { started.n++; };
  const ok = w.tryEnterGame(difficulty || 'easy');
  w.startGame = start;
  return ok;
}

/* ---------------- 门票 ---------------- */

test('门票表四档递增，六馆与德州配置同源', () => {
  assert.deepEqual(w.ENTRY_FEE, { easy: 50, normal: 200, hard: 800, champion: 3000 });
  w.GAME_LEVELS.forEach((k, i) => {
    assert.equal(w.entryFeeFor(k), [50, 200, 800, 3000][i], k + ' 门票');
    assert.equal(w.DIFFICULTY_CONFIG[k].entryFee, w.ENTRY_FEE[k], k + ' 德州配置应与门票表一致');
  });
});

test('金币场进场按难度扣门票', () => {
  w.createNewSaveAt(1);
  w.player.coins = 5000;
  assert.equal(enter('blackjack', 'coins', 'easy'), true);
  assert.equal(w.player.coins, 5000 - w.ENTRY_FEE.easy, '进小游戏金币场应扣门票');
  assert.equal(w.Arcade.entryFeePaid, w.ENTRY_FEE.easy, '应记录已付门票');
  w.createNewSaveAt(1);
  w.player.coins = 5000;
  assert.equal(enter('diceduel', 'coins', 'hard'), true);
  assert.equal(w.player.coins, 5000 - w.ENTRY_FEE.hard);
});

test('排位同样收门票，且不影响比赛筹码结算（骰类娱乐场拒绝排位）', () => {
  assert.equal(enter('dice', 'ranked', 'normal'), false, '骰类玩法不参与排位');
  assert.equal(enter('diceduel', 'ranked', 'normal'), false, '骰子比大小同样不参与排位');
  w.createNewSaveAt(1);
  w.player.coins = 5000;
  assert.equal(enter('blackjack', 'ranked', 'normal'), true);
  assert.equal(w.player.coins, 5000 - w.ENTRY_FEE.normal, '排位也要门票');
  assert.equal(w.Arcade.rankedBank, w.arcadeBank15(), '比赛筹码独立发放，不受门票影响');
});

test('练习场免门票', () => {
  w.createNewSaveAt(1);
  w.player.coins = 120;
  assert.equal(enter('blackjack', 'practice', 'champion'), true, '练习场不校验金币');
  assert.equal(w.player.coins, 120, '练习场不扣金币');
  assert.equal(w.Arcade.entryFeePaid, 0);
});

test('余额不足门票时拒绝进场且不扣款', () => {
  w.createNewSaveAt(1);
  w.player.coins = w.ENTRY_FEE.easy - 1;
  const before = w.player.coins;
  assert.equal(enter('blackjack', 'coins', 'easy'), false, '余额不足应拒绝');
  assert.equal(w.player.coins, before, '被拒绝时不扣款');
  assert.equal(w.App.screen !== 'arcade' || !w.Arcade.round, true);
  w.player.coins = w.ENTRY_FEE.easy;
  assert.equal(enter('blackjack', 'coins', 'easy'), true, '刚好够门票可进场');
  assert.equal(w.player.coins, 0);
});

test('德州进场同样收门票，余额不足被拒', () => {
  w.createNewSaveAt(1);
  w.player.coins = 20000;
  assert.equal(enter('holdem', 'coins', 'easy'), true);
  assert.equal(w.player.coins, 20000 - w.ENTRY_FEE.easy);
  w.G.active = false;
  w.player.coins = w.ENTRY_FEE.easy - 1;
  assert.equal(enter('holdem', 'coins', 'easy'), false, '付不起门票不得入场');
  w.player.coins = 40000;
  assert.equal(enter('holdem', 'ranked', 'hard'), true, '排位德州也要门票');
  assert.equal(w.player.coins, 40000 - w.ENTRY_FEE.hard);
});

test('门票扣款失败（存储故障）时拒绝进场', () => {
  w.createNewSaveAt(1);
  w.player.coins = 5000;
  const proto = Object.getPrototypeOf(w.localStorage);
  const old = proto.setItem;
  proto.setItem = () => { throw new Error('QuotaExceededError'); };
  const ok = enter('blackjack', 'coins', 'easy');
  proto.setItem = old;
  assert.equal(ok, false, '事务失败应拒绝进场');
  assert.equal(w.player.coins, 5000, '门票应整体回滚');
});

/* ---------------- 退出路径 ---------------- */

test('小游戏返回按钮回到「选择模式」而不是大厅', () => {
  w.createNewSaveAt(1);
  w.player.coins = 5000;
  assert.equal(enter('blackjack', 'coins', 'easy'), true);
  assert.equal(w.App.screen, 'arcade');
  w.arcadeLeave(true);
  assert.equal(w.App.screen, 'mode', '应回到选择模式界面，实际 ' + w.App.screen);
  assert.equal(doc.getElementById('lobbyScreen').style.display, 'none', '不直接回大厅');
  assert.equal(doc.getElementById('modeScreen').classList.contains('active'), true);
});

test('小游戏未结算时先确认再离开', () => {
  w.createNewSaveAt(1);
  w.player.coins = 5000;
  assert.equal(enter('blackjack', 'coins', 'easy'), true);
  const restore = rig([card(10), card(5), card(10), card(7)]);
  try {
    w.blackjackStart(30);
    w.arcadeLeave(false);
    assert.equal(doc.getElementById('arcExit').hidden, false, '应先弹确认');
    doc.getElementById('arcExitNo').click();
    assert.equal(doc.getElementById('arcExit').hidden, true, '继续本局应关闭确认');
    assert.equal(w.App.screen, 'arcade');
    w.arcadeLeave(false);
    doc.getElementById('arcExitYes').click();
    assert.equal(w.App.screen, 'mode', '确认后回选择模式');
  } finally { restore(); }
});

test('德州退出回到选择模式，离桌汇总按钮也回选择模式', () => {
  w.createNewSaveAt(1);
  w.player.coins = 30000;
  w.initPlayers();
  w.G.active = true;
  w.G.handOver = true;
  w.G.handSettled = true;
  w.G.session = { hands: 2, wins: 1, net: 10, coins: w.player.coins, rank: 0, fee: w.ENTRY_FEE.easy };
  w.exitGame();
  assert.equal(w.App.screen, 'mode', '德州退出也应回到选择模式，实际 ' + w.App.screen);
  assert.ok(doc.getElementById('ovSession').classList.contains('show'), '应显示离桌汇总');
  doc.getElementById('sessionBack').click();
  assert.equal(doc.getElementById('ovSession').classList.contains('show'), false, '汇总按钮应关闭面板');
  assert.equal(w.App.screen, 'mode', '关闭后仍停留在选择模式');
});

test('选择模式可以从模式卡重新进场，也可以退回大厅', () => {
  w.createNewSaveAt(1);
  w.player.coins = 5000;
  w.hubGame = 'dice';
  w.goModeScreen();
  assert.equal(doc.getElementById('modeScreen').classList.contains('active'), true);
  const cards = [...doc.querySelectorAll('#modeBody .mode-card')];
  console.log('  [mode-cards]', cards.length, cards.map(c => c.className).join(','));
  assert.ok(cards.length >= 2 && cards.length <= 3, '模式卡 2~3 张（实际 ' + cards.length + '）');
  assert.ok(cards[0].textContent.includes('免费') || cards[0].textContent.includes('门票'), '模式卡写明免费或门票');
  doc.getElementById('modeBack').click();
  assert.equal(doc.getElementById('lobbyScreen').style.display, 'flex', '可以退回大厅');
});

/* ---------------- 骰子多押 ---------------- */

test('骰子同轮可押多个结果：单注上限与单轮上限分离', () => {
  w.createNewSaveAt(1);
  w.player.coins = 20000;
  assert.equal(enter('dice', 'coins', 'easy'), true);
  w.Arcade.diceCount = 3;
  const lim = w.arcadeLimit15(), round = w.arcadeDiceRoundLimit();
  assert.equal(round, lim * w.DICE_ROUND_FACTOR, '单轮上限应为单注上限的 5 倍');
  assert.equal(w.diceAddBet('small', lim), true, '单注可到上限');
  assert.equal(w.diceAddBet('small', 10), false, '同一档超过单注上限应拒绝');
  ['big', 'any', 'sum12', 'triple3', 'triple6'].forEach(c => assert.equal(w.diceAddBet(c, 10), true, c + ' 可另押一档'));
  assert.equal(w.Arcade.basket.length, 6, '6 个不同结果可同时押注');
  const total = w.Arcade.basket.reduce((a, b) => a + b.amount, 0);
  assert.equal(total, lim + 50, '多档金额累加到同一单轮');
  assert.equal(w.diceAddBet('big', lim), false, '同一档超过单注上限仍拒绝');
  /* 用 5 个档位各押满，正好到达单轮总投入上限 */
  w.Arcade.basket = [];
  ['small', 'big', 'any', 'sum3', 'sum18'].forEach(c => assert.equal(w.diceAddBet(c, lim), true, c + ' 押满单档'));
  assert.equal(w.Arcade.basket.reduce((a, b) => a + b.amount, 0), round, '5 档各押满刚好等于单轮上限');
  assert.equal(w.diceAddBet('triple1', 10), false, '再多押一档就超出单轮总投入上限');
});

test('多押结算：中奖档返还（含本金），未中奖档本金扣除', () => {
  w.createNewSaveAt(1);
  w.player.coins = 20000;
  assert.equal(enter('dice', 'coins', 'easy'), true);
  w.Arcade.diceCount = 3;
  const coins0 = w.player.coins;
  assert.equal(w.diceAddBet('small', 100), true);
  assert.equal(w.diceAddBet('any', 100), true);
  assert.equal(w.diceAddBet('triple6', 100), true);
  const stake = 300;
  const random = w.randomInt;
  /* 固定开出 1,1,1：小不中（豹子大小均输）、任意豹子中、全 6 不中 */
  w.randomInt = () => 0;
  assert.equal(w.diceRollBasket(), true);
  w.randomInt = random;
  const r = w.Arcade.round;
  const small = r.bets.find(b => b.choice === 'small');
  const any = r.bets.find(b => b.choice === 'any');
  const t6 = r.bets.find(b => b.choice === 'triple6');
  assert.equal(small.payout, 0, '未中奖档位不返还');
  assert.equal(t6.payout, 0, '未中奖的指定豹子不返还');
  assert.ok(any.payout > 100, '中奖档按倍数返还（含本金）');
  assert.equal(r.payout, any.payout, '总返还只累加中奖档');
  assert.equal(w.player.coins, coins0 - stake + r.payout, '未中奖的 200 本金已扣除');
  assert.equal(w.Arcade.basket.length, 0, '结算后清空待下注清单');
});

console.log('TOTAL ' + n);
dom.window.close();
process.exit(0);
