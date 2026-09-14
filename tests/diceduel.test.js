/**
 * 「骰子比大小」游戏测试（jsdom）
 * 覆盖：注册进四馆体系 / 豹子大于普通点数 / 逐对比分与赔付 / 豹子翻倍 /
 *       30 倍数校验 / 公平性守恒 / 事件上报 / 渲染与再来一局 / 存储失败重试。
 * 运行: node tests/diceduel.test.js
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
const dom = new JSDOM(html.replace(/<script>[\s\S]*?<\/script>/, ''), { url: 'https://dd.test', runScripts: 'outside-only' });
const w = dom.window;
w.setTimeout = () => 0;
w.requestAnimationFrame = () => 0;
w.eval(code);
w.loadAllSaves();
w.initArcade();

let n = 0;
function test(name, fn) { fn(); n++; console.log('PASS ' + name); }
const doc = w.document;
function click(el) { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); }
function fresh(mode) {
  w.G.active = false;
  w.Arcade.round = null;
  w.player.arcade = { stats: {}, pending: null, history: [] };
  w.player.coins = 5000;
  w.Arcade.practice = 500;
  w.Arcade.mode = mode || 'coins';
  assert.equal(w.openArcade('diceduel'), true);
}

/* ---------------- 注册 ---------------- */

test('已登记为第五个小游戏，名字与规则齐全', () => {
  assert.ok(w.GAME_IDS.includes('diceduel'));
  assert.equal(w.GAME_NAMES.diceduel, '骰子比大小');
  assert.equal(w.ARCADE_NAMES.diceduel, '骰子比大小');
  assert.ok(w.ARCADE_RULES.diceduel.includes('豹子'));
  assert.ok(w.GROWTH_ROUTES.diceduel.length === 5, '应有 5 条成长路线');
  assert.ok(!!doc.querySelector('[data-game="diceduel"]'), '大厅应有入口');
});

test('每个游戏都有周常与成就份额，1000 项成就 ID 唯一', () => {
  w.GAME_IDS.forEach(g => {
    assert.ok(w.WEEKLY_TASKS.some(t => t.game === g), g + ' 应有周常');
    assert.ok(w.ACHIEVEMENTS.some(a => a.game === g), g + ' 应有成就');
  });
  assert.equal(new Set(w.ACHIEVEMENTS.map(a => a.id)).size, 1000);
  assert.equal(w.ACHIEVEMENTS.length, 1000);
});

/* ---------------- 牌型与比较 ---------------- */

test('豹子大于任何普通点数，豹子之间比点数', () => {
  assert.equal(w.ddRankOf([2, 2, 2]).triple, true);
  assert.equal(w.ddRankOf([1, 2, 3]).triple, false);
  assert.equal(w.ddRankOf([1, 1, 1]).sum, 3);
  // 豹子 111（点数 3）仍大于普通最大 18 点（如 6,6,5）
  assert.equal(w.ddCmp(w.ddRankOf([1, 1, 1]), w.ddRankOf([6, 6, 5])), 1, '豹子应大于任何普通点数');
  assert.equal(w.ddCmp(w.ddRankOf([6, 6, 6]), w.ddRankOf([5, 5, 5])), 1, '豹子之间比点数');
  assert.equal(w.ddCmp(w.ddRankOf([3, 4, 5]), w.ddRankOf([2, 5, 5])), 0, '同点数应判平');
  assert.equal(w.ddCmp(w.ddRankOf([6, 6, 5]), w.ddRankOf([1, 2, 3])), 1);
});

/* ---------------- 开局与赔付 ---------------- */

test('开局生成 4 个座位（玩家 + 3 AI），骰子均在 1–6', () => {
  fresh();
  w.$('arcBet').value = '30';
  assert.equal(w.ddStart(30), true);
  const r = w.Arcade.round;
  assert.equal(r.seats.length, 4);
  assert.equal(r.seats[0].human, true);
  r.seats.forEach(s => {
    assert.equal(s.dice.length, 3);
    s.dice.forEach(d => assert.ok(d >= 1 && d <= 6, '骰面越界：' + d));
  });
  assert.equal(r.unit, 10);
  assert.equal(r.wins + r.ties + r.losses, 3, '三家的胜负平应合计 3');
});

test('赔付按家数计算：赢 2 倍、平退还、输归零', () => {
  fresh();
  w.$('arcBet').value = '30';
  w.ddStart(30);
  const r = w.Arcade.round;
  const expect = 2 * r.unit * r.wins + r.unit * r.ties;
  const expectTotal = r.rank.triple ? expect * 2 : expect;
  assert.equal(r.payout, expectTotal, '赔付公式不符（wins=' + r.wins + ' ties=' + r.ties + '）');
  assert.equal(r.doubled, r.rank.triple);
});

test('玩家掷出豹子时返还翻倍，输了不加扣', () => {
  fresh();
  const real = w.ddRoll;
  const seq = [[4, 4, 4], [1, 1, 1], [2, 3, 4], [6, 6, 5]];  // 玩家 444 豹子；对手 111(豹子3) / 234(9) / 665(17)
  let i = 0;
  w.ddRoll = function () { return seq[i++]; };
  w.ddStart(30);
  const r = w.Arcade.round;
  w.ddRoll = real;
  assert.equal(r.rank.triple, true, '玩家应为豹子');
  assert.equal(r.doubled, true);
  // 444 的 12 点大于 111 的 3 点，因此三家全胜
  assert.equal(r.wins, 3);
  assert.equal(r.ties, 0);
  assert.equal(r.payout, 2 * 10 * 3 * 2, '豹子应把返还翻倍');

  /* 反向场景：同样是豹子但点数最小，三家全负，翻倍后仍为 0（不倒扣） */
  w.Arcade.round = null;
  i = 0;
  const seq2 = [[1, 1, 1], [6, 6, 6], [5, 5, 5], [4, 4, 4]];
  w.ddRoll = function () { return seq2[i++]; };
  w.ddStart(30);
  const r2 = w.Arcade.round;
  w.ddRoll = real;
  assert.equal(r2.rank.triple, true);
  assert.equal(r2.wins, 0);
  assert.equal(r2.losses, 3);
  assert.equal(r2.payout, 0, '豹子输了也不应倒扣');
  assert.equal(r2.doubled, true);
});

test('非 30 倍数被拒绝，且不扣款不建局', () => {
  fresh();
  const c0 = w.player.coins;
  assert.equal(w.ddStart(20), false, '20 应被拒绝');
  assert.equal(w.ddStart(100), false, '100 应被拒绝');
  assert.equal(w.player.coins, c0, '不应扣款');
  assert.equal(w.Arcade.round, null, '不应建局');
});

/* ---------------- 公平性 ---------------- */

test('3000 局蒙特卡洛：长期返还率接近本金，豹子提供正向上限', () => {
  fresh('practice');
  let stake = 0, payout = 0, triples = 0, sweeps = 0;
  for (let i = 0; i < 3000; i++) {
    w.Arcade.round = null;
    w.Arcade.practice = 100000;
    w.player.coins = 100000;
    if (!w.ddStart(30)) continue;
    const r = w.Arcade.round;
    stake += r.stake; payout += r.payout;
    if (r.rank.triple) triples++;
    if (r.wins === 3) sweeps++;
  }
  const rtp = payout / stake;
  assert.ok(triples > 0 && sweeps > 0, '样本中应出现豹子与通杀');
  assert.ok(rtp > 0.9 && rtp < 1.15, '长期返还率应在 0.9–1.15 之间，实际 ' + rtp.toFixed(3));
  console.log('    返还率 ' + rtp.toFixed(3) + ' · 豹子 ' + triples + ' 次 · 通杀 ' + sweeps + ' 次');
});

/* ---------------- 事件与成长 ---------------- */

test('结算上报 hands / wins / triplewin / sweep / pointwin', () => {
  fresh();
  w.profile15('diceduel').metrics = {};
  w.player.dailyProgress = {};
  w.player.dailyClaimed = {};
  w.player.monthly.progress = {};
  w.ddStart(30);
  const r = w.Arcade.round;
  const m = w.profile15('diceduel').metrics;
  assert.equal(m.hands, 1);
  assert.equal(m.wins || 0, r.payout > r.stake ? 1 : 0, '净赢才计 wins（为 0 时不写入 metrics）');
  assert.equal(m.pointwin || 0, r.wins || 0);
  if (r.rank.triple && r.wins > 0) assert.equal(m.triplewin, 1);
  if (r.wins === 3) assert.equal(m.sweep, 1);
  assert.ok((w.player.dailyProgress['d15_diceduel'] || 0) === 1, '应推进日常任务');
  assert.ok((w.player.monthly.progress.m_any_hands || 0) >= 1, '应推进月度通用项');
});

/* ---------------- 渲染与交互 ---------------- */

test('面板渲染 4 个座位与开局按钮，结束后变再来一局', () => {
  fresh();
  w.renderArcade();
  /* 模拟点筹码片：设置金额并派发 change，与真实交互一致 */
  const chips = [...doc.querySelectorAll('[data-chip]')].map(b => b.dataset.chip);
  w.$('arcBet').value = chips[0];
  w.$('arcBet').dispatchEvent(new w.Event('change'));
  const table = doc.getElementById('arcTable');
  assert.equal(table.querySelectorAll('.dd-seat').length, 4, '应有 4 个座位');
  assert.equal(table.querySelectorAll('.dd-die').length, 12, '4 家 × 3 骰');
  assert.ok(table.textContent.includes('待掷'), '开局前应显示待掷');
  let btn = doc.getElementById('arcActions').querySelector('[data-arc="startdd"]');
  assert.ok(btn, '应有开局按钮');
  assert.ok(btn.textContent.includes('开局'));
  click(btn);
  const after = doc.getElementById('arcActions').querySelector('[data-arc="startdd"]');
  assert.ok(after && after.textContent.includes('再来一局'), '结束后应提示再来一局');
  assert.ok(doc.getElementById('arcTable').textContent.includes('点') || doc.getElementById('arcTable').textContent.includes('豹子'));
  assert.ok(doc.getElementById('arcMessage').textContent.length > 0, '应显示结果');
});

test('筹码只提供 30 的倍数，避免均分出现小数', () => {
  fresh();
  w.renderArcade();
  const chips = [...doc.querySelectorAll('[data-chip]')].map(b => Number(b.dataset.chip));
  assert.ok(chips.length > 0, '应有筹码可选');
  chips.forEach(v => assert.equal(v % 30, 0, v + ' 不是 30 的倍数'));
  assert.equal(doc.getElementById('arcBet').value, String(chips[0]));
});

test('保存失败后进入重试，重试成功后不重复发放', () => {
  fresh();
  const proto = Object.getPrototypeOf(w.localStorage);
  const old = proto.setItem;
  const boom = function () { throw new Error('QuotaExceededError'); };
  /* 开局本身也要把 pending 落盘，只让「结算」这一步的存储失败，才是真实的重试场景 */
  const origBegin = w.arcadeBegin;
  w.arcadeBegin = function (bet) {
    proto.setItem = old;
    const r = origBegin(bet);
    proto.setItem = boom;
    return r;
  };
  proto.setItem = boom;
  w.ddStart(30);
  w.arcadeBegin = origBegin;
  proto.setItem = old;
  const r = w.Arcade.round;
  assert.ok(r && r.retry, '应进入重试状态');
  const before = w.player.coins;
  assert.equal(w.arcadeSettle(r.retry.payout, r.retry.label), true);
  assert.equal(w.player.coins, before + r.payout, '重试应发放一次');
  assert.equal(w.arcadeSettle(r.payout, r.label), false, '重复结算应被拒绝');
  assert.equal(w.player.coins, before + r.payout);
});

test('未完局离开会被回收并记入历史', () => {
  fresh();
  w.G.active = false;
  /* ddStart 是「开局 + 结算」一体，这里让结算短路，模拟掷完还没结算就刷新 */
  const origSettle = w.arcadeSettle;
  w.arcadeSettle = function () { return true; };
  w.ddStart(30);
  w.arcadeSettle = origSettle;
  assert.ok(w.arcadeData().pending, '开局应写入 pending');
  // 模拟中途刷新：pending 存在但 round 丢失
  w.Arcade.round = null;
  w.arcadeRecover();
  assert.equal(w.arcadeData().pending, null, '恢复后应清空 pending');
  assert.ok(w.arcadeData().history[0].label.includes('未完局'), '应记入历史');
});

console.log('TOTAL ' + n);
dom.window.close();
