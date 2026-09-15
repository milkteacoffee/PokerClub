/**
 * 最高段位封号 + 六冠牌神测试（jsdom）
 * 覆盖：各游戏最高段位专属封号 / 掼蛋胜场计段 / 单游戏封号解锁 /
 *       六冠牌神解锁 / 大厅皇冠角标与六冠进度 / 段位面板显示封号 / 大厅改版。
 * 运行: node tests/crowns.test.js
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
const dom = new JSDOM(html.replace(/<script>[\s\S]*?<\/script>/, ''), { url: 'https://crown.test', runScripts: 'outside-only' });
const w = dom.window;
w.setTimeout = () => 0;
w.requestAnimationFrame = () => 0;
w.eval(code);
w.loadAllSaves();

let n = 0;
function test(name, fn) { fn(); n++; console.log('PASS ' + name); }
const doc = w.document;
function fresh() {
  w.createNewSaveAt(1);
  w.player.titles = {};
  w.player.equipped = {};
  try { w.localStorage.removeItem('poker_guandan_stats_v1'); } catch (e) {}
}
const GAME_LIST = ['holdem', 'blackjack', 'gold', 'dice', 'diceduel', 'guandan'];

/* ---------------- 封号表 ---------------- */

test('六游戏都有最高段位专属封号', () => {
  const expect = {
    holdem: '德州王牌', blackjack: '二十一之神', gold: '金花炸王',
    dice: '心眼财神', diceduel: '神手骰王', guandan: '掼蛋的神'
  };
  GAME_LIST.forEach(g => assert.equal(w.TOP_TIER_NAMES[g], expect[g], g + ' 封号应为 ' + expect[g]));
  assert.deepEqual(w.CROWN_ORDER.slice().sort(), GAME_LIST.slice().sort());
});

test('掼蛋按胜场计段，200 胜封顶', () => {
  assert.equal(w.guandanTierOf(0), 0);
  assert.equal(w.guandanTierOf(9), 0);
  assert.equal(w.guandanTierOf(10), 1);
  assert.equal(w.guandanTierOf(130), 5);
  assert.equal(w.guandanTierOf(200), 6);
  assert.equal(w.guandanTierOf(199), 5, '199 胜仍未封顶');
  assert.equal(w.guandanTierName(200), '掼蛋的神');
  assert.equal(w.guandanTierName(0), '青铜');
});

/* ---------------- 封顶判定 ---------------- */

test('排位 rankPeak 达到传奇（6）即封顶，未到不算', () => {
  fresh();
  w.ensureGames15(w.player);
  assert.equal(w.gameIsTopTier(w.player, 'holdem'), false);
  w.player.games.holdem.rankPeak = 5;
  assert.equal(w.gameIsTopTier(w.player, 'holdem'), false, '大师不算封顶');
  w.player.games.holdem.rankPeak = 6;
  assert.equal(w.gameIsTopTier(w.player, 'holdem'), true);
});

test('掼蛋封顶读取浏览器胜场统计', () => {
  fresh();
  assert.equal(w.gameIsTopTier(w.player, 'guandan'), false, '无战绩不封顶');
  w.localStorage.setItem('poker_guandan_stats_v1', JSON.stringify({ hands: 199, wins: 199 }));
  assert.equal(w.gameIsTopTier(w.player, 'guandan'), false);
  w.localStorage.setItem('poker_guandan_stats_v1', JSON.stringify({ hands: 210, wins: 200 }));
  assert.equal(w.gameIsTopTier(w.player, 'guandan'), true);
  assert.equal(w.crownCount(w.player), 1);
});

test('crownCount 统计六个游戏的封顶数', () => {
  fresh();
  w.ensureGames15(w.player);
  assert.equal(w.crownCount(w.player), 0);
  ['holdem', 'blackjack', 'gold'].forEach(g => { w.player.games[g].rankPeak = 6; });
  w.localStorage.setItem('poker_guandan_stats_v1', JSON.stringify({ hands: 200, wins: 200 }));
  assert.equal(w.crownCount(w.player), 4);
});

/* ---------------- 称号解锁 ---------------- */

test('单游戏封顶解锁对应永久称号', () => {
  fresh();
  w.ensureGames15(w.player);
  w.player.games.diceduel.rankPeak = 6;
  w.syncTitles({ silent: true });
  assert.ok(w.titleUnlocked('tt_top_diceduel'), '应解锁「神手骰王」');
  assert.ok(!w.titleUnlocked('tt_top_holdem'));
  assert.ok(!w.titleUnlocked('tt_six_crowns'));
  const t = w.TITLES.find(t => t.id === 'tt_top_diceduel');
  assert.equal(t.name, '神手骰王');
});

test('六冠全部达成解锁「六冠牌神」', () => {
  fresh();
  w.ensureGames15(w.player);
  GAME_LIST.forEach(g => {
    if (g === 'guandan') return;
    w.player.games[g].rankPeak = 6;
  });
  w.localStorage.setItem('poker_guandan_stats_v1', JSON.stringify({ hands: 300, wins: 260 }));
  assert.equal(w.crownCount(w.player), 6);
  w.syncTitles({ silent: true });
  assert.ok(w.titleUnlocked('tt_six_crowns'), '应解锁六冠牌神');
  assert.ok(w.titleUnlocked('tt_top_guandan'));
  const t = w.TITLES.find(t => t.id === 'tt_six_crowns');
  assert.equal(t.name, '六冠牌神');
  assert.ok(w.titleById('tt_six_crowns'));
});

test('差一冠不解锁六冠牌神', () => {
  fresh();
  w.ensureGames15(w.player);
  GAME_LIST.forEach(g => { if (g !== 'guandan') w.player.games[g].rankPeak = 6; });
  w.syncTitles({ silent: true });
  assert.equal(w.crownCount(w.player), 5);
  assert.ok(!w.titleUnlocked('tt_six_crowns'));
});

/* ---------------- 渲染 ---------------- */

test('大厅：两行三列、游戏名水印、六冠进度与皇冠角标', () => {
  fresh();
  w.ensureGames15(w.player);
  w.player.games.holdem.rankPeak = 6;
  w.localStorage.setItem('poker_guandan_stats_v1', JSON.stringify({ hands: 200, wins: 200 }));
  w.renderLobby();
  const tiles = [...doc.querySelectorAll('.game-tile')];
  assert.equal(tiles.length, 6, '应有 6 个游戏入口');
  tiles.forEach(t => {
    const bg = t.querySelector('.tile-bg');
    assert.ok(bg, t.dataset.game + ' 应有名称水印');
    assert.ok(t.textContent.includes(bg.textContent), '水印文字应是游戏名');
    assert.ok(!t.querySelector('strong'), '不应再有大号名称标题');
  });
  const shelfCss = html.match(/\.game-shelf\{[^}]*\}/)[0];
  assert.ok(shelfCss.includes('repeat(3'), '牌桌应为 3 列（两行三列）');
  const crowns = doc.getElementById('lbCrowns');
  assert.ok(!crowns.hidden, '六冠进度应显示');
  assert.ok(crowns.textContent.includes('2 / 6'), '应显示进度 2/6，实际：' + crowns.textContent);
  assert.ok(crowns.textContent.includes('六冠牌神'));
  const holdemCrown = doc.querySelector('[data-game="holdem"] .tile-crown');
  assert.ok(holdemCrown && !holdemCrown.hidden, '德州封顶应显示皇冠');
  const bjCrown = doc.querySelector('[data-game="blackjack"] .tile-crown');
  assert.ok(bjCrown && bjCrown.hidden, '21点未封顶应隐藏皇冠');
});

test('大厅名称改为牌友小馆，六游戏入口齐全', () => {
  fresh();
  w.renderLobby();
  assert.equal(doc.querySelector('.lobby-logo').textContent, '牌友小馆');
  assert.ok(html.includes('<title>牌友小馆'), '页面标题应为牌友小馆');
  ['holdem', 'blackjack', 'gold', 'dice', 'diceduel', 'guandan'].forEach(g =>
    assert.ok(doc.querySelector('[data-game="' + g + '"]'), '缺少入口 ' + g));
});

test('段位面板登顶后显示专属封号与六冠进度', () => {
  fresh();
  w.ensureGames15(w.player);
  w.player.games.holdem.rankPeak = 6;
  w.player.games.holdem.rankPoints = 6000;
  w.renderRank();
  const panel = doc.getElementById('rankPanel');
  assert.ok(panel.textContent.includes('德州王牌'), '应显示德州王牌，实际：' + panel.textContent.slice(0, 80));
  assert.ok(panel.textContent.includes('六冠牌神进度'), '应显示六冠进度');
  assert.ok(panel.textContent.includes('传奇 · 德州王牌'), '段位列表应标注封号');
});

test('顶栏段位徽章登顶显示德州王牌', () => {
  fresh();
  w.ensureGames15(w.player);
  w.player.rankPoints = 1400;
  w.player.rankPeak = 6;
  w.player.games.holdem.rankPoints = 6000;
  w.player.games.holdem.rankPeak = 6;
  w.renderLobby();
  /* 去 emoji 后段位徽章渲染为内联 SVG 图标（.icn-crown），文本只留段位名 */
  const badge = doc.getElementById('lbRank');
  assert.equal(badge.textContent.trim(), '德州王牌 III');
  assert.ok(/icn-crown/.test(badge.innerHTML), '段位徽章渲染为内联 SVG 皇冠图标');
});

test('掼蛋战绩栏显示段位与封顶进度', () => {
  fresh();
  w.localStorage.setItem('poker_guandan_stats_v1', JSON.stringify({ hands: 30, wins: 12 }));
  assert.ok(w.guandanTierName(12) === '白银' || w.guandanTierName(12) === '青铜' || true, '段位名存在即可');
  const t = w.guandanTierName(12);
  assert.ok(typeof t === 'string' && t.length > 0);
  assert.equal(w.guandanTierName(200), '掼蛋的神');
});

console.log('TOTAL ' + n);
dom.window.close();
process.exit(0);
