/**
 * 各游戏专属段位名测试（vm 去壳，可访问内部常量与函数）
 * 覆盖：六游戏各 7 档 / 命名不重复 / 末档与封号衔接 / 未知道具回落 /
 *       小段位拼接 / 掼蛋胜场段位 / 阶梯文案 / 展示入口一致性。
 * 运行: node tests/rank-names.test.js
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
const dom = new JSDOM(html.replace(/<script>[\s\S]*?<\/script>/, ''), { url: 'https://rank.test', runScripts: 'outside-only' });
const w = dom.window;
w.setTimeout = () => 0;
w.requestAnimationFrame = () => 0;
w.eval(code);
w.loadAllSaves();

let n = 0;
function test(name, fn) { fn(); n++; console.log('PASS ' + name); }

const GAMES = ['holdem', 'blackjack', 'gold', 'dice', 'diceduel', 'guandan'];

test('六个游戏都有 7 档专属段位名，且与 RANKS 档数一致', () => {
  assert.ok(Array.isArray(w.RANKS) && w.RANKS.length === 7, 'RANKS 应为 7 档');
  GAMES.forEach(g => {
    const arr = w.RANK_NAMES[g];
    assert.ok(Array.isArray(arr) && arr.length === 7, g + ' 应有 7 档，实际 ' + (arr && arr.length));
    arr.forEach((nm, i) => assert.ok(typeof nm === 'string' && nm.length >= 2 && nm.length <= 6, g + ' 第' + (i + 1) + '档名长度合理: ' + nm));
  });
});

test('每个游戏自己的 7 档名不重复', () => {
  GAMES.forEach(g => {
    const set = new Set(w.RANK_NAMES[g]);
    assert.equal(set.size, 7, g + ' 段位名有重复: ' + w.RANK_NAMES[g].join('/'));
  });
});

test('每游戏最高档 === 该游戏封号（与称号体系衔接）', () => {
  GAMES.forEach(g => {
    assert.equal(w.RANK_NAMES[g][6], w.TOP_TIER_NAMES[g], g + ' 末档应为封号 ' + w.TOP_TIER_NAMES[g]);
    assert.equal(w.crownNameOf(g), w.RANK_NAMES[g][6], g + ' crownNameOf 与末档一致');
  });
});

test('六个游戏的段位名互不相同（各有各的气势）', () => {
  const seen = {};
  GAMES.forEach(g => w.RANK_NAMES[g].forEach(nm => { seen[nm] = (seen[nm] || 0) + 1; }));
  const dup = Object.keys(seen).filter(k => seen[k] > 1);
  assert.equal(dup.length, 0, '跨游戏出现重名: ' + dup.join('、'));
});

test('rankNameOf 返回对应游戏专属名，未知游戏回落通用名', () => {
  assert.equal(w.rankNameOf('holdem', 0), '牌桌新人');
  assert.equal(w.rankNameOf('holdem', 6), '德州王牌');
  assert.equal(w.rankNameOf('gold', 2), '胆识家');
  assert.equal(w.rankNameOf('diceduel', 5), '天选之骰');
  assert.equal(w.rankNameOf('guandan', 6), '掼蛋的神');
  /* 未知游戏 / 未知档位：回落通用阶梯名，不崩 */
  assert.equal(w.rankNameOf('nonexistent', 3), w.RANKS[3].name);
  assert.equal(w.rankNameOf('holdem', 99), '?');
});

test('小段位拼接：rankFullName 按游戏出专属名', () => {
  assert.equal(w.rankFullName('holdem', 0), '牌桌新人 III');
  assert.equal(w.rankFullName('holdem', 2600), '老练牌手 II');
  assert.equal(w.rankFullName('holdem', 6000), '德州王牌 III');
  assert.equal(w.rankFullName('blackjack', 0), '点数学徒 III');
  assert.equal(w.rankFullName('gold', 3000), '闷牌将军 III');
  assert.equal(w.rankFullName('dice', 5000), '押注宗师 III');
  assert.equal(w.rankFullName('diceduel', 4000), '骰坛霸主 III');
});

test('掼蛋按胜场走自己的段位名', () => {
  assert.equal(w.guandanTierName(0), '掼蛋新手');
  assert.equal(w.guandanTierName(10), '默契搭档');
  assert.equal(w.guandanTierName(50), '配合大师');
  assert.equal(w.guandanTierName(130), '掼蛋宗师');
  assert.equal(w.guandanTierName(200), '掼蛋的神');
  assert.equal(w.guandanTierName(999), '掼蛋的神');
});

test('段位阶梯与文案：7 档名字按顺序、含分数门槛', () => {
  const ladder = w.rankLadder('holdem');
  assert.equal(ladder.length, 7);
  assert.deepEqual(ladder.map(r => r.name), w.RANK_NAMES.holdem);
  assert.equal(ladder[0].min, 0);
  assert.equal(ladder[6].min, 6000);
  const txt = w.rankLadderText('gold');
  assert.ok(txt.indexOf('闷牌新手 → 看牌客 → 胆识家') >= 0, '阶梯文案顺序正确: ' + txt);
});

test('档位奖励与积分保持原样（改名不影响经济数值）', () => {
  const expect = [[0, 0], [500, 5], [1200, 12], [2500, 25], [5000, 50], [10000, 100], [20000, 200]];
  w.RANKS.forEach((r, i) => {
    assert.equal(r.reward, expect[i][0], '第' + (i + 1) + '档金币奖励不变');
    assert.equal(r.points, expect[i][1], '第' + (i + 1) + '档积分不变');
  });
});

test('页面渲染：大厅徽章与段位面板显示专属段位名', () => {
  w.createNewSaveAt(1);
  w.ensureGames15(w.player);
  w.hubGame = 'gold';
  w.profile15('gold').rankPoints = 3200;   /* 第 4 档 = 闷牌将军 */
  try { w.renderLobby(); } catch (e) {}
  try { w.renderRank(); } catch (e) {}
  const badge = w.document.getElementById('lbRank').textContent;
  assert.ok(badge.indexOf('闷牌将军') >= 0, '大厅徽章应显示金花专属段位名，实际：' + badge);
  const panel = w.document.getElementById('rankPanel').textContent;
  assert.ok(panel.indexOf('闷牌将军') >= 0, '段位面板应显示专属段位名，实际：' + panel.slice(0, 60));
  assert.ok(panel.indexOf('金花炸王') >= 0, '段位阶梯末档应显示封号');
});

console.log('\n段位体系测试: ' + n + ' 项通过, 0 项失败');
process.exit(0);
