/**
 * 弹窗交互 + 段位体系测试（jsdom）
 * 覆盖：弹窗互斥（同屏只有一个面板）/ 点击面板外关闭 / Esc 返回 / 每个信息面板都有返回按钮、
 *       大段位 1000 分一档、III-II-I 小段位划分、单局段位分增减、难度随小段位爬升、段位面板渲染。
 * 运行: node tests/overlay-rank.test.js
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
const dom = new JSDOM(html.replace(/<script>[\s\S]*?<\/script>/, ''), { url: 'https://ov.test', runScripts: 'outside-only' });
const w = dom.window;
w.setTimeout = () => 0;
w.requestAnimationFrame = () => 0;
w.eval(code);
w.loadAllSaves();
w.initOverlayUX();

let n = 0;
function test(name, fn) { fn(); n++; console.log('PASS ' + name); }
const doc = w.document;
function click(el) { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); }
function fresh() { w.createNewSaveAt(1); w.player.titles = {}; }
const INFO_PANELS = ['ovAchieve', 'ovTasks', 'ovHelp', 'ovShop', 'ovStats', 'ovCheckin', 'ovSettings', 'ovStorage'];
function shownIds() { return [...doc.querySelectorAll('.overlay.show')].map(o => o.id); }

/* ---------------- 弹窗交互 ---------------- */

test('信息类弹窗都有「返回」按钮，可点击关闭', () => {
  fresh();
  INFO_PANELS.forEach(id => {
    w.openOverlay(id);
    const ov = doc.getElementById(id);
    assert.ok(ov.classList.contains('show'), id + ' 应打开');
    const back = ov.querySelector('.ov-back button') || ov.querySelector('[data-close="' + id + '"]');
    assert.ok(back, id + ' 应有返回入口');
    click(back);
    assert.ok(!ov.classList.contains('show'), id + ' 点返回后应关闭');
  });
});

test('弹窗互斥：同屏只保留一个，避免两个 ✕ 叠在一起', () => {
  fresh();
  w.openOverlay('ovShop');
  w.openOverlay('ovCheckin');
  assert.deepEqual(shownIds(), ['ovCheckin'], '打开签到时商城应自动关闭，实际：' + shownIds().join(','));
  w.openOverlay('ovStats');
  assert.deepEqual(shownIds(), ['ovStats']);
  w.openOverlay('ovAchieve');
  assert.deepEqual(shownIds(), ['ovAchieve']);
});

test('升级提示可以叠在结算面板上，不把结算顶掉', () => {
  fresh();
  w.openOverlay('ovSettle');
  w.openOverlay('ovLevelUp', ['ovSettle']);
  const ids = shownIds();
  assert.ok(ids.includes('ovSettle') && ids.includes('ovLevelUp'), '两个面板应同时在，实际：' + ids.join(','));
  w.closeOverlay('ovLevelUp');
  assert.ok(doc.getElementById('ovSettle').classList.contains('show'), '关掉升级后结算仍在');
  w.closeOverlay('ovSettle');
});

test('点击面板外的遮罩区域即返回', () => {
  fresh();
  w.openOverlay('ovStats');
  const ov = doc.getElementById('ovStats');
  /* 点面板内部不应该关闭 */
  click(ov.querySelector('.panel h2'));
  assert.ok(ov.classList.contains('show'), '点面板内部不应关闭');
  /* 点遮罩本身（e.target === overlay）才关闭 */
  ov.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.ok(!ov.classList.contains('show'), '点遮罩应关闭');
});

test('Esc 关闭信息类弹窗，确认类弹窗不受影响', () => {
  fresh();
  w.openOverlay('ovShop');
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepEqual(shownIds(), [], 'Esc 应关闭商城');

  w.openOverlay('ovDeleteConfirm');
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepEqual(shownIds(), ['ovDeleteConfirm'], '删除确认不应被 Esc 直接关掉');
  w.closeOverlay('ovDeleteConfirm');
});

test('确认类弹窗不注册遮罩关闭，避免误触丢档', () => {
  const keep = ['ovDeleteConfirm', 'ovNewSaveConfirm', 'ovExitConfirm', 'ovSettle', 'ovGameOver'];
  keep.forEach(id => assert.ok(w.OV_CLOSE_ON_BACKDROP.indexOf(id) < 0, id + ' 不应允许点外关闭'));
  INFO_PANELS.forEach(id => assert.ok(w.OV_CLOSE_ON_BACKDROP.indexOf(id) >= 0, id + ' 应允许点外关闭'));
});

/* ---------------- 段位体系 ---------------- */

test('大段位每 1000 分一档，第 1 档 0 分起、满段 6000 封顶', () => {
  assert.equal(w.RANKS.length, 7);
  const mins = w.RANKS.map(r => r.min);
  assert.deepEqual(mins, [0, 1000, 2000, 3000, 4000, 5000, 6000]);
  for (let i = 1; i < w.RANKS.length; i++) {
    assert.equal(w.RANKS[i].min - w.RANKS[i - 1].min, w.RANK_STEP, w.RANKS[i].name + ' 应比上一段高 1000 分');
  }
  assert.equal(w.rankTierFor(999), 0);
  assert.equal(w.rankTierFor(1000), 1);
  assert.equal(w.rankTierFor(5999), 5);
  assert.equal(w.rankTierFor(6000), 6);
  assert.equal(w.rankTierFor(99999), 6);
});

test('每个大段位都有 III / II / I 三个小段位', () => {
  const cases = [
    [0, 0, 'III'], [333, 0, 'III'], [334, 0, 'II'], [667, 0, 'II'], [668, 0, 'I'], [999, 0, 'I'],
    [1000, 1, 'III'], [1668, 1, 'I'], [2000, 2, 'III'], [6000, 6, 'III'], [6668, 6, 'I']
  ];
  cases.forEach(([pts, tier, label]) => {
    const s = w.subTierInfo(pts);
    assert.equal(s.tier, tier, pts + ' 的大段位');
    assert.equal(s.label, label, pts + ' 的小段位');
  });
  assert.deepEqual(w.SUB_TIER_LABELS, ['I', 'II', 'III']);
});

test('小段位名称与封号拼接正确，进度取段内比例', () => {
  assert.equal(w.rankFullName('holdem', 0), '牌桌新人 III');
  assert.equal(w.rankFullName('holdem', 3600), '心理读牌师 II');
  assert.equal(w.rankFullName('dice', 6000), '心眼财神 III');
  const s = w.subTierInfo(0);
  assert.equal(s.got, 0);
  assert.equal(s.nextMin, 334);
  assert.equal(Math.round(w.subTierInfo(167).pct), 50, '333 分中点应约 50%');
  assert.equal(w.subTierInfo(6000).pct, 0, '刚进段落时进度归零');
});

test('小段位序号用于难度爬升，共 21 档', () => {
  assert.equal(w.subTierOrder(0), 0);
  assert.equal(w.subTierOrder(668), 2);
  assert.equal(w.subTierOrder(1000), 3);
  assert.equal(w.subTierOrder(6000), 18);
  assert.equal(w.subTierOrder(6668), 20);
  assert.equal(w.subTierOrder(99999), 20, '封顶后不再增长');
});

test('单局段位分：胜 5~10，负 5~10，平局不变', () => {
  assert.deepEqual(w.RANK_POINT_WIN, [5, 7, 9, 10]);
  assert.deepEqual(w.RANK_POINT_LOSS, [5, 7, 9, 10]);
  w.RANK_POINT_WIN.forEach(v => assert.ok(v >= 5 && v <= 10, '胜局加分应在 5~10：' + v));
  w.RANK_POINT_LOSS.forEach(v => assert.ok(v >= 5 && v <= 10, '负局扣分应在 5~10：' + v));
  fresh();
  w.GAME_LEVELS.forEach((key, i) => {
    const s = w.profile15('holdem');
    s.rankPoints = 2000; s.tierReward = w.rankTierFor(2000); s.redeemPoints = 0;
    w.applyRankResult15('holdem', key, 1);
    assert.equal(s.rankPoints, 2000 + w.RANK_POINT_WIN[i], key + ' 胜局');
    const mid = s.rankPoints;
    w.applyRankResult15('holdem', key, 0);
    assert.equal(s.rankPoints, mid, key + ' 平局不变');
    w.applyRankResult15('holdem', key, -1);
    assert.equal(s.rankPoints, mid - w.RANK_POINT_LOSS[i], key + ' 负局');
  });
  const s = w.profile15('holdem');
  s.rankPoints = 10;
  w.applyRankResult15('holdem', 'champion', -1);
  assert.equal(s.rankPoints, 0, '扣分不低于 0');
});

test('每 1000 分的晋级奖励仍然只发一次', () => {
  fresh();
  const s = w.profile15('holdem');
  s.rankPoints = 0; s.tierReward = 0; s.redeemPoints = 0;
  const c0 = w.player.coins;
  s.rankPoints = 1000;
  assert.deepEqual(w.grantTierReward15(s), { tier: 1, coins: 500, points: 5 });
  s.rankPoints = 2000;
  assert.deepEqual(w.grantTierReward15(s), { tier: 2, coins: 1200, points: 12 });
  assert.equal(w.player.coins, c0 + 1700);
  /* 掉回第 1 档再升回第 2 档，不重复发 */
  s.rankPoints = 0; w.grantTierReward15(s);
  s.rankPoints = 1000; w.grantTierReward15(s);
  assert.equal(w.player.coins, c0 + 1700, '掉段回升不补发');
});

test('段位面板展示大段位+小段位、1000 分门槛与六冠进度', () => {
  fresh();
  const s = w.profile15('holdem');
  s.rankPoints = 2600; s.rankPeak = w.rankTierFor(2600);
  s.redeemPoints = 7; s.rankedWins = 12; s.rankedHands = 20;
  w.renderRank();
  const text = doc.getElementById('rankPanel').textContent;
  assert.ok(text.includes('老练牌手 II'), '应显示小段位（含该游戏专属段位名），实际：' + text.slice(0, 60));
  assert.ok(text.includes('2600'), '应显示段位分');
  assert.ok(text.includes('每 1000 段位分升一个大段位'), '应说明 1000 分一档');
  assert.ok(text.includes('III → II → I'), '应说明小段位划分');
  assert.ok(text.includes('六冠牌神进度'), '应显示六冠进度');
  assert.ok(text.includes('德州王牌'), '段位表应列出最高段「德州王牌」');
  assert.ok(w.rankFullName('holdem', 2600) === '老练牌手 II');
});

test('模式卡显示当前小段位与单局增减', () => {
  fresh();
  w.hubGame = 'holdem';
  w.profile15('holdem').rankPoints = 2600;
  w.player.coins = 5000;
  w.renderModeCards();
  const text = doc.getElementById('modeBody').textContent;
  assert.ok(text.includes('老练牌手 II'), '模式卡应显示小段位（专属段位名），实际：' + text.slice(0, 120));
  assert.ok(text.includes('+5'), '应显示胜局加分区间');
  assert.ok(text.includes('-10'), '应显示负局扣分区间');
});

console.log('TOTAL ' + n);
dom.window.close();
process.exit(0);
