/**
 * 月度挑战与破产救济金测试（jsdom）
 * 覆盖：月度按月刷新 / 按游戏隔离推进 / 单项与批量领取 / 存储失败回滚，
 *       救济金每日 3 次、跨日重置、大厅按钮可见性、破产面板接线。
 * 运行: node tests/monthly-relief.test.js
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
const dom = new JSDOM(html.replace(/<script>[\s\S]*?<\/script>/, ''), { url: 'https://p.test', runScripts: 'outside-only' });
const w = dom.window;
w.setTimeout = () => 0;
w.requestAnimationFrame = () => 0;
w.eval(code);
w.loadAllSaves();

let FAKE = '2026-09-14';
w.todayStr = function () { return FAKE; };

let n = 0;
function test(name, fn) { fn(); n++; console.log('PASS ' + name); }
/* 让 localStorage.setItem 抛错，验证 atomic15 整体回滚 */
function quota() {
  const proto = Object.getPrototypeOf(w.localStorage);
  const old = proto.setItem;
  proto.setItem = function () { throw new Error('QuotaExceededError'); };
  return function () { proto.setItem = old; };
}
function resetMonthly() { w.player.monthly = null; w.player.relief = null; }
const doc = w.document;
function click(el) { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); }
/* 本用例不执行 init()，这里把大厅与破产按钮的绑定补上（与 init 中一致）以验证点击链路 */
doc.getElementById('lbBtnRelief').addEventListener('click', function () { w.claimDailyRelief(); });
doc.getElementById('goAgain').addEventListener('click', function () {
  if (!w.claimDailyRelief()) return;
  doc.getElementById('ovGameOver').classList.remove('show');
  w.showScreen('lobby');
});

/* ---------------- 月度挑战 ---------------- */

test('月度挑战按月建表，10 项共 4000 金币', () => {
  assert.equal(w.MONTHLY_TASKS.length, 10);
  assert.equal(w.MONTHLY_TASKS.reduce((a, t) => a + t.reward, 0), 4000);
  resetMonthly();
  const m = w.ensureMonthly();
  assert.equal(m.month, '2026-09');
  assert.deepEqual(m.progress, {});
  assert.deepEqual(m.claimed, {});
});

test('跨月自动重置进度与已领标记', () => {
  resetMonthly();
  w.ensureMonthly();
  w.player.monthly.progress['m_dice_hands'] = 120;
  w.player.monthly.claimed['m_dice_hands'] = true;
  const old = w.monthKeyOf;
  w.monthKeyOf = () => '2026-10';
  w.ensureMonthly();
  assert.equal(w.player.monthly.month, '2026-10', '换月应重建');
  assert.deepEqual(w.player.monthly.progress, {}, '进度应清空');
  assert.deepEqual(w.player.monthly.claimed, {}, '已领应清空');
  w.monthKeyOf = old;
});

test('进度按游戏隔离，通用项接受任意游戏，且不超过目标', () => {
  resetMonthly();
  w.recordGrowth15('dice', { hands: 3, wins: 1 }, 'easy');
  assert.equal(w.player.monthly.progress.m_dice_hands, 3, '骰子的局数只推进骰子');
  assert.equal(w.player.monthly.progress.m_dice_wins, 1);
  assert.equal(w.player.monthly.progress.m_holdem_hands || 0, 0, '德州不应被骰子推进');
  assert.equal(w.player.monthly.progress.m_any_hands, 3, '通用项累计任意游戏');
  assert.equal(w.player.monthly.progress.m_any_wins, 1);
  w.bumpMonthlyProgress('dice', 'hands', 99999);
  assert.equal(w.player.monthly.progress.m_dice_hands, 120, '不应超过目标值');
});

test('未达标不能领取，达标后单项领取发放奖励', () => {
  resetMonthly();
  w.ensureMonthly();
  const t = w.getMonthlyTaskById('m_dice_hands');
  assert.equal(w.claimMonthly('m_dice_hands'), false, '未达标应拒绝');
  w.player.monthly.progress.m_dice_hands = t.target;
  const c0 = w.player.coins;
  assert.equal(w.monthlyClaimableCount(), 1);
  assert.equal(w.claimMonthly('m_dice_hands'), true);
  assert.equal(w.player.coins, c0 + t.reward);
  assert.equal(w.claimMonthly('m_dice_hands'), false, '重复领取应拒绝');
  assert.equal(w.monthlyClaimableCount(), 0);
});

test('月度一键领取走事务，存储失败整体回滚', () => {
  resetMonthly();
  w.ensureMonthly();
  w.player.monthly.progress.m_dice_hands = 999;
  w.player.monthly.progress.m_any_wins = 999;
  assert.equal(w.monthlyClaimableCount(), 2);
  const c0 = w.player.coins;
  const stop = quota();
  assert.equal(w.claimAllMonthly(), 0, '存储失败应返回 0');
  stop();
  assert.equal(w.player.coins, c0, '金币不应变化');
  assert.deepEqual(w.player.monthly.claimed, {}, '不应留下已领标记');
  const got = w.claimAllMonthly();
  assert.equal(got, 2);
  assert.equal(w.player.coins, c0 + 300 + 700);
  assert.equal(w.monthlyClaimableCount(), 0);
});

test('任务面板渲染月度页并可一键领取，可领取项置顶', () => {
  resetMonthly();
  w.ensureMonthly();
  w.player.monthly.progress.m_gold_hands = 999;
  w.renderTasks();
  const box = doc.getElementById('taskListMonthly');
  assert.ok(box.textContent.includes('月度挑战'), '应渲染月度标题');
  assert.ok(box.textContent.includes('炸金花 · 完成 120 局'));
  const bar = box.querySelector('[data-claim-all="monthly"]');
  assert.ok(bar, '应有一键领取按钮');
  assert.ok(!bar.disabled, '有可领取项时按钮可用');
  const first = box.querySelector('.task-group');
  assert.ok(first.textContent.includes('待领取'), '可领取组应排在最前');
  const c0 = w.player.coins;
  click(bar);
  assert.equal(w.player.coins, c0 + 300, '点击后应发放奖励');
  assert.ok(box.textContent.includes('已领取'), '领取后应出现已领取分组');
});

test('无可领取时月度一键领取按钮禁用', () => {
  resetMonthly();
  w.ensureMonthly();
  w.renderTasks();
  const bar = doc.getElementById('taskListMonthly').querySelector('[data-claim-all="monthly"]');
  assert.ok(bar && bar.disabled, '无可领取时应禁用');
  const c0 = w.player.coins;
  click(bar);
  assert.equal(w.player.coins, c0, '禁用按钮点击无效');
});

test('切换月度页签只显示月度列表', () => {
  w.switchTaskTab('monthly');
  assert.equal(doc.getElementById('taskListMonthly').style.display, 'block');
  assert.equal(doc.getElementById('taskListNewbie').style.display, 'none');
  assert.equal(doc.getElementById('taskListDaily').style.display, 'none');
  assert.ok(doc.getElementById('tabMonthly').classList.contains('active'));
  w.switchTaskTab('daily');
  assert.equal(doc.getElementById('taskListDaily').style.display, 'block');
  assert.equal(doc.getElementById('taskListMonthly').style.display, 'none');
});

test('看门狗跨月也能触发刷新', () => {
  resetMonthly();
  w.ensureMonthly();
  w.player.monthly.progress.m_dice_hands = 5;
  const old = w.monthKeyOf;
  w.monthKeyOf = () => '2026-11';
  assert.equal(w.refreshPeriodic({ toast: false }), true, '换月应被检出');
  assert.deepEqual(w.player.monthly.progress, {}, '换月后进度清空');
  w.monthKeyOf = old;
});

/* ---------------- 破产救济金 ---------------- */

test('救济金每日 3 次，每次 500，超出拒绝', () => {
  resetMonthly();
  w.player.coins = 10;
  assert.equal(w.reliefLeft(), w.RELIEF.timesPerDay);
  assert.equal(w.reliefAvailable(), true, '金币低于门槛应可领');
  let c0 = w.player.coins;
  for (let i = 0; i < w.RELIEF.timesPerDay; i++) {
    assert.equal(w.claimDailyRelief(), true, '第 ' + (i + 1) + ' 次应成功');
    c0 += w.RELIEF.amount;
    assert.equal(w.player.coins, c0);
  }
  assert.equal(w.reliefLeft(), 0);
  assert.equal(w.claimDailyRelief(), false, '超出次数应拒绝');
  assert.equal(w.player.coins, c0, '失败不应改金币');
});

test('救济金跨日重置次数', () => {
  resetMonthly();
  w.player.coins = 0;
  w.claimDailyRelief();
  assert.equal(w.reliefLeft(), w.RELIEF.timesPerDay - 1);
  FAKE = '2026-09-15';
  assert.equal(w.reliefLeft(), w.RELIEF.timesPerDay, '新的一天应恢复次数');
  const c0 = w.player.coins;
  assert.equal(w.claimDailyRelief(), true);
  assert.equal(w.player.coins, c0 + w.RELIEF.amount);
  FAKE = '2026-09-14';
});

test('救济金存储失败整体回滚，不吞次数也不发币', () => {
  resetMonthly();
  w.player.coins = 20;
  const c0 = w.player.coins;
  const stop = quota();
  assert.equal(w.claimDailyRelief(), false);
  stop();
  assert.equal(w.player.coins, c0, '金币应回滚');
  assert.equal(w.reliefLeft(), w.RELIEF.timesPerDay, '次数应回滚');
});

test('持有复活券时救济金翻倍且消耗一张', () => {
  resetMonthly();
  w.player.coins = 0;
  w.player.inventory = w.player.inventory || {};
  w.player.inventory.revive = 2;
  const c0 = w.player.coins;
  assert.equal(w.claimDailyRelief(), true);
  assert.equal(w.player.coins, c0 + w.RELIEF.amount * 2, '应翻倍');
  assert.equal(w.player.inventory.revive, 1, '应消耗一张');
  w.claimDailyRelief();
  assert.equal(w.player.inventory.revive, 0 || undefined, '用尽后应删除条目');
});

test('大厅救济金按钮只在金币低于门槛且有次数时出现', () => {
  resetMonthly();
  w.player.coins = 5000;
  w.renderLobby();
  assert.equal(doc.getElementById('lbBtnRelief').hidden, true, '金币充足时应隐藏');
  w.player.coins = 20;
  w.renderLobby();
  assert.equal(doc.getElementById('lbBtnRelief').hidden, false, '破产时应出现');
  assert.equal(doc.getElementById('lbReliefN').textContent, String(w.RELIEF.timesPerDay));
  const c0 = w.player.coins;
  click(doc.getElementById('lbBtnRelief'));
  assert.equal(w.player.coins, c0 + w.RELIEF.amount, '点击应发放');
  assert.equal(doc.getElementById('lbReliefN').textContent, String(w.RELIEF.timesPerDay - 1));
});

test('签到面板展示救济金卡片，次数用尽后禁用', () => {
  resetMonthly();
  w.player.coins = 0;
  w.renderCheckin();
  const card = doc.getElementById('ciPanel').querySelector('.relief-card');
  assert.ok(card, '应渲染救济金卡片');
  assert.ok(card.textContent.includes('500'));
  const btn = doc.getElementById('btnRelief');
  assert.ok(btn && !btn.disabled);
  const c0 = w.player.coins;
  click(btn);
  assert.equal(w.player.coins, c0 + w.RELIEF.amount);
  w.claimDailyRelief(); w.claimDailyRelief();
  w.renderCheckin();
  assert.equal(doc.getElementById('btnRelief').disabled, true, '用尽后应禁用');
  assert.ok(doc.getElementById('ciPanel').textContent.includes('今日已领完'));
});

test('破产面板按钮领取救济金后关闭并返回大厅', () => {
  resetMonthly();
  w.player.coins = 0;
  assert.equal(w.claimRelief, undefined, '旧的无限补充金入口应已移除');
  w.showGameOver();
  const btn = doc.getElementById('goAgain');
  assert.ok(btn.textContent.includes('500'), '按钮应显示救济金额度');
  assert.equal(btn.disabled, false);
  click(btn);
  assert.equal(w.player.coins, w.RELIEF.amount);
  assert.equal(doc.getElementById('ovGameOver').classList.contains('show'), false, '应关闭面板');
  assert.equal(w.App.screen, 'lobby', '应返回大厅');
});

console.log('TOTAL ' + n);
dom.window.close();
