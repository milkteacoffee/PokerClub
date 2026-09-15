'use strict';
/**
 * 服务端掼蛋引擎自检：
 * 1) 牌数守恒 108 张，无复用无丢失
 * 2) N 局全自动对局必须终结，出完顺序合法、升级数合法
 * 3) 非法动作必须被拒绝
 * 4) 与前端引擎同源：用固定种子对比牌型判定一致性（无法固定随机，改判定纯函数一致性）
 */
const G = require('../engine/guandan');

let pass = 0, fail = 0;
const failures = [];
function check(cond, msg) { if (cond) { pass++; } else { fail++; failures.push(msg); } }

const RUNS = Number(process.argv[2] || 500);

for (let run = 0; run < RUNS; run++) {
  const level = 2 + (run % 3);
  const g = G.create(level);
  const used = new Set();
  let guard = 0;
  while (!g.done && g.moves < 2000 && guard++ < 2000) {
    const s = g.turn;
    const ids = G.choose(g, s);
    if (ids) ids.forEach(id => {
      check(!used.has(id), 'run=' + run + ' 牌被复用 id=' + id);
      used.add(id);
      check(Number.isInteger(id) && id >= 0 && id < 108, 'run=' + run + ' 牌 id 越界 ' + id);
    });
    check(G.act(g, s, ids) === true, 'run=' + run + ' AI 动作被拒 seat=' + s);
    check(used.size + g.hands.reduce((a, h) => a + h.length, 0) === 108,
      'run=' + run + ' 牌数不守恒: ' + used.size + '+' + g.hands.reduce((a, h) => a + h.length, 0));
  }
  check(g.done, 'run=' + run + ' 未终结 moves=' + g.moves);
  check(new Set(g.order).size === 4, 'run=' + run + ' 出完顺序不足 4 家');
  check([1, 2, 3].includes(g.up), 'run=' + run + ' 升级数非法 ' + g.up);
}

/* 非法动作拒绝 */
{
  const g = G.create(2);
  check(G.act(g, (g.turn + 1) % 4, null) === false, '非当前座位应被拒绝');
  check(G.act(g, g.turn, []) === false, '空出牌应被拒绝');
  check(G.act(g, g.turn, [0, 0]) === false, '重复 id 应被拒绝');
  check(G.act(g, g.turn, [999999]) === false, '不存在的手牌应被拒绝');
  // 首手不能过牌
  const g2 = G.create(2);
  check(G.act(g2, g2.turn, null) === false, '首出不允许不出');
}

/* 牌型判定纯函数一致性（与前端同逻辑，抽几个固定样例） */
{
  const L = 2;
  const mk = (r, s, id) => ({ id: id || 0, r, s });
  check(G.classify([mk(5, 0), mk(5, 1)], L, null).t === 'pair', '对子判定');
  check(G.classify([mk(5, 0)], L, null).t === 'single', '单张判定');
  const bomb = G.classify([mk(9, 0), mk(9, 1), mk(9, 2), mk(9, 3)], L, null);
  check(bomb && bomb.t === 'bomb' && bomb.n === 4, '四张炸弹判定');
  const king = G.classify([mk(15, 4), mk(15, 4), mk(16, 4), mk(16, 4)], L, null);
  check(king && king.t === 'king', '四王炸判定');
  // 炸弹不可压四王炸
  check(G.beats(bomb, king) === false, '四王炸应压过炸弹');
  check(G.beats(king, bomb) === true, '四王炸应压过炸弹(反向)');
}

console.log('服务端掼蛋引擎测试: ' + pass + ' 项通过, ' + fail + ' 项失败 (' + RUNS + ' 局)');
if (fail) { failures.slice(0, 20).forEach(f => console.log('  - ' + f)); process.exit(1); }
