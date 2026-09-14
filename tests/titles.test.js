/**
 * 称号收集系统测试（jsdom）
 * 覆盖：条件达成自动解锁 / 未达成不解锁 / 佩戴与取消 / 未解锁不可佩戴 /
 *       牌桌与顶栏显示佩戴称号 / 德州 flush·quads 事件累计 / 面板渲染与徽标。
 * 运行: node tests/titles.test.js
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

let n = 0;
function test(name, fn) { fn(); n++; console.log('PASS ' + name); }
const doc = w.document;
function click(el) { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); }
function fresh() {
  w.createNewSaveAt(1);
  w.player.titles = {};
  w.player.equipped = {};
}

/* ---------------- 基础 ---------------- */

test('称号表结构完整：ID 唯一、26 个、均带条件与图标', () => {
  const ids = w.TITLES.map(t => t.id);
  assert.equal(new Set(ids).size, ids.length, 'ID 应唯一');
  assert.equal(w.TITLES.length, 26);
  w.TITLES.forEach(t => {
    assert.ok(t.name && t.desc && t.icon, t.id + ' 缺少展示字段');
    assert.equal(typeof t.check, 'function', t.id + ' 缺少判定函数');
  });
});

test('新档默认没有任何称号，且条件不成立时不解锁', () => {
  fresh();
  assert.deepEqual(w.unlockedTitles(), []);
  assert.equal(w.syncTitles({ silent: true }), 0, '无达成条件不应解锁');
  assert.deepEqual(w.player.titles, {});
});

/* ---------------- 连胜类 ---------------- */

test('连胜 3 / 5 / 10 逐级解锁', () => {
  fresh();
  w.player.maxStreak = 3;
  assert.equal(w.syncTitles({ silent: true }), 1);
  assert.ok(w.titleUnlocked('tt_streak_3'));
  assert.ok(!w.titleUnlocked('tt_streak_5'), '不应越级解锁');
  w.player.maxStreak = 10;
  w.syncTitles({ silent: true });
  assert.ok(w.titleUnlocked('tt_streak_5') && w.titleUnlocked('tt_streak_10'), '应补齐中间档');
});

/* ---------------- 牌型 / 各馆累计 ---------------- */

test('同花与四条按累计次数解锁（德州专属计数）', () => {
  fresh();
  w.profile15('holdem').metrics.flush = 9;
  assert.equal(w.syncTitles({ silent: true }), 0, '9 次未达标');
  w.profile15('holdem').metrics.flush = 10;
  w.syncTitles({ silent: true });
  assert.ok(w.titleUnlocked('tt_flush_10'));
  w.profile15('gold').metrics.flush = 999;
  w.syncTitles({ silent: true });
  assert.ok(!w.titleUnlocked('tt_flush_50'), '其他馆的同花不应计入德州称号');
  w.profile15('holdem').metrics.quads = 5;
  w.syncTitles({ silent: true });
  assert.ok(w.titleUnlocked('tt_quads_5'));
});

test('骰子点数与豹子、炸金花比牌、21 点天然各自独立计数', () => {
  fresh();
  w.profile15('dice').metrics.exactwin = 20;
  w.profile15('gold').metrics.comparewin = 30;
  w.profile15('blackjack').metrics.natural = 10;
  w.syncTitles({ silent: true });
  assert.ok(w.titleUnlocked('tt_dice_20'));
  assert.ok(w.titleUnlocked('tt_gold_30'));
  assert.ok(w.titleUnlocked('tt_bj_10'));
  assert.ok(!w.titleUnlocked('tt_dice_100'), '100 次未达标');
});

test('四馆通用的局数与净赢称号跨游戏累计', () => {
  fresh();
  w.profile15('holdem').metrics.hands = 60;
  w.profile15('dice').metrics.hands = 40;
  w.profile15('blackjack').metrics.wins = 100;
  w.syncTitles({ silent: true });
  assert.ok(w.titleUnlocked('tt_hands_100'), '60+40 应算作 100 局');
  assert.ok(w.titleUnlocked('tt_wins_100'), '任意馆净赢 100 即达成');
  assert.ok(!w.titleUnlocked('tt_hands_500'));
});

/* ---------------- 排位称号 ---------------- */

test('排位段位巅峰与胜场解锁称号，掉段不回收', () => {
  fresh();
  const s = w.profile15('holdem');
  s.rankPeak = 4;
  s.rankedWins = 20;
  w.syncTitles({ silent: true });
  assert.ok(w.titleUnlocked('tt_rank_2') && w.titleUnlocked('tt_rank_4'));
  assert.ok(!w.titleUnlocked('tt_rank_6'), '传奇未达成');
  assert.ok(w.titleUnlocked('tt_ranked_20'));
  s.rankPeak = 0;
  s.rankedWins = 0;
  w.syncTitles({ silent: true });
  assert.ok(w.titleUnlocked('tt_rank_4'), '已解锁称号不应被回收');
});

/* ---------------- 德州事件上报 ---------------- */

test('德州结算会上报 flush 与 quads 事件', () => {
  fresh();
  const before = w.profile15('holdem').metrics.flush || 0;
  w.G.active = false;
  w.App.mode = 'quick';
  w.recordGrowth15('holdem', { hands: 1, flush: 1, quads: 1 }, 'easy');
  assert.equal(w.profile15('holdem').metrics.flush, before + 1);
  assert.equal(w.profile15('holdem').metrics.quads, 1);
});

/* ---------------- 佩戴与展示 ---------------- */

test('未解锁的称号不能佩戴，解锁后可佩戴与取消', () => {
  fresh();
  assert.equal(w.equipTitle('tt_streak_3'), false, '未解锁应拒绝');
  assert.equal(w.player.equipped.title, undefined);
  w.player.maxStreak = 5;
  w.syncTitles({ silent: true });
  assert.equal(w.equipTitle('tt_streak_3'), true);
  assert.equal(w.player.equipped.title, 'tt_streak_3');
  assert.ok(w.titleText().includes('三连捷'), '牌桌称号文本应包含名称，实际：' + w.titleText());
  assert.equal(w.equipTitle(''), true, '可取消佩戴');
  assert.equal(w.titleText(), '');
});

test('装备称号走事务，存储失败不留残留', () => {
  fresh();
  w.player.maxStreak = 3;
  w.syncTitles({ silent: true });
  const proto = Object.getPrototypeOf(w.localStorage);
  const old = proto.setItem;
  proto.setItem = function () { throw new Error('QuotaExceededError'); };
  const ok = w.equipTitle('tt_streak_3');
  proto.setItem = old;
  assert.equal(ok, false, '存储失败应返回 false');
  assert.equal(w.player.equipped.title, undefined, '不应留下佩戴状态');
});

/* ---------------- 面板 ---------------- */

test('称号面板渲染全部条目，已解锁可佩戴、未解锁隐藏名称', () => {
  fresh();
  w.player.maxStreak = 3;
  w.syncTitles({ silent: true });
  w.renderTitleList();
  const box = doc.getElementById('titleList');
  assert.ok(box.textContent.includes('已解锁 1 / 26'), '应显示进度，实际：' + box.textContent.slice(0, 40));
  assert.ok(box.textContent.includes('三连捷'));
  assert.ok(box.textContent.includes('未解锁称号'), '未解锁项应隐藏具体名称');
  const btn = box.querySelector('[data-equip-title="tt_streak_3"]');
  assert.ok(btn, '已解锁项应有佩戴按钮');
  click(btn);
  assert.equal(w.player.equipped.title, 'tt_streak_3');
  assert.ok(doc.getElementById('titleList').textContent.includes('佩戴中'));
});

test('称号页签切换与待解锁徽标', () => {
  fresh();
  w.renderTitleList();
  const badge = doc.getElementById('titleBadge');
  assert.equal(badge.textContent, '26');
  assert.notEqual(badge.style.display, 'none');
  w.switchStatsTab('stitle');
  assert.equal(doc.getElementById('titlePanel').style.display, 'block');
  assert.equal(doc.getElementById('statPanel').style.display, 'none');
  assert.ok(doc.getElementById('tabSTitle').classList.contains('active'));
  w.switchStatsTab('sdata');
  assert.equal(doc.getElementById('titlePanel').style.display, 'none');
});

test('全部解锁后徽标归零', () => {
  fresh();
  w.TITLES.forEach(t => { w.player.titles[t.id] = true; });
  w.renderTitleList();
  assert.equal(doc.getElementById('titleBadge').style.display, 'none');
  assert.ok(doc.getElementById('titleList').textContent.includes('已解锁 26 / 26'));
});

test('大厅静默补解锁：条件达成后回到大厅自动补发', () => {
  fresh();
  w.player.maxStreak = 3;
  w.renderLobby();
  assert.ok(w.titleUnlocked('tt_streak_3'), '回大厅应自动解锁');
});

console.log('TOTAL ' + n);
dom.window.close();
