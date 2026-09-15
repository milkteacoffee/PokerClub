'use strict';
/**
 * 掼蛋引擎（服务端权威版）
 * 逻辑与 index.html 内的 window.Guandan 保持逐字一致，
 * 唯一差异：随机源由浏览器 root.crypto 改为 Node crypto.randomBytes。
 */
const nodeCrypto = require('crypto');

const ranks = Array.from({ length: 13 }, (_, i) => i + 2);
const seq = [14, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

function power(r, l) { return r >= 15 ? r + 3 : r === l ? 17 : r; }
function wild(c, l) { return c.r === l && c.s === 1; }

function deck() {
  const d = [];
  for (let k = 0; k < 2; k++) {
    for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) d.push({ id: d.length, r, s });
    d.push({ id: d.length, r: 15, s: 4 });
    d.push({ id: d.length, r: 16, s: 4 });
  }
  return d;
}

/* 拒绝采样，保证均匀分布（与前端 crypto.getRandomValues 语义一致） */
function random(n) {
  const buf = nodeCrypto.randomBytes(4);
  const max = Math.floor(4294967296 / n) * n;
  let v;
  do { v = buf.readUInt32BE(0); } while (v >= max);
  return v % n;
}

function shuffled() {
  const a = deck();
  for (let i = a.length - 1; i > 0; i--) {
    const j = random(i + 1), t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function beats(a, b) {
  if (!b) return true;
  if (a.t === 'king') return b.t !== 'king';
  if (b.t === 'king') return false;
  const av = a.t === 'bomb' ? (a.n === 4 ? 1 : a.n === 5 ? 2 : a.n + 1) : a.t === 'flush' ? 3 : 0;
  const bv = b.t === 'bomb' ? (b.n === 4 ? 1 : b.n === 5 ? 2 : b.n + 1) : b.t === 'flush' ? 3 : 0;
  if (av !== bv) return av > bv;
  if (av) return a.v > b.v;
  return a.t === b.t && a.n === b.n && a.v > b.v;
}

function patterns(l) {
  const p = [];
  function add(t, v, req) { p.push({ t, v, n: req.length, req }); }
  const all = ranks.concat([15, 16]);
  all.forEach(r => {
    add('single', power(r, l), [[r, -1]]);
    add('pair', power(r, l), [[r, -1], [r, -1]]);
    if (r < 15) {
      add('triple', power(r, l), Array.from({ length: 3 }, () => [r, -1]));
      for (let n = 4; n <= 10; n++) add('bomb', power(r, l), Array.from({ length: n }, () => [r, -1]));
      ranks.filter(q => q !== r).forEach(q => add('full', power(r, l), [[r, -1], [r, -1], [r, -1], [q, -1], [q, -1]]));
    }
  });
  for (let start = 0; start <= 9; start++) {
    const rs = seq.slice(start, start + 5);
    add('straight', start, rs.map(r => [r, -1]));
    for (let s = 0; s < 4; s++) add('flush', start, rs.map(r => [r, s]));
  }
  for (const len of [2, 3]) {
    for (let st = 0; st <= 14 - len; st++) {
      const rr = seq.slice(st, st + len);
      if (rr.length !== len || new Set(rr).size !== len) continue;
      add(len === 2 ? 'plate' : 'pairs', st, rr.flatMap(r => Array.from({ length: len === 2 ? 3 : 2 }, () => [r, -1])));
    }
  }
  add('king', 100, [[15, -1], [15, -1], [16, -1], [16, -1]]);
  return p;
}

const pc = {};

function candidates(hand, l, against) {
  const pats = pc[l] || (pc[l] = patterns(l));
  const out = [], seen = new Set();
  for (const p of pats) {
    if (p.n > hand.length || !beats(p, against)) continue;
    const available = hand.slice(), used = [];
    let ok = true;
    for (const req of p.req) {
      let i = available.findIndex(c => !wild(c, l) && c.r === req[0] && (req[1] < 0 || c.s === req[1]));
      if (i < 0) i = available.findIndex(c => c.r === req[0] && (req[1] < 0 || c.s === req[1]));
      if (i < 0 && req[0] < 15) i = available.findIndex(c => wild(c, l));
      if (i < 0) { ok = false; break; }
      used.push(available.splice(i, 1)[0]);
    }
    if (ok) {
      if (p.t === 'single' && used[0].r !== p.req[0][0]) continue;
      const key = used.map(c => c.id).sort((a, b) => a - b).join(',') + p.t + p.v;
      if (!seen.has(key)) { seen.add(key); out.push({ t: p.t, v: p.v, n: p.n, cards: used }); }
    }
  }
  return out;
}

function classify(cards, l, against) {
  return candidates(cards, l, against).filter(x => x.n === cards.length).sort((a, b) => {
    const aa = a.t === 'king' ? 99 : a.t === 'bomb' ? a.n + 5 : a.t === 'flush' ? 10 : 0;
    const bb = b.t === 'king' ? 99 : b.t === 'bomb' ? b.n + 5 : b.t === 'flush' ? 10 : 0;
    return aa - bb || a.v - b.v;
  })[0] || null;
}

function create(l) {
  const d = shuffled();
  return {
    level: l || 2,
    hands: [d.slice(0, 27), d.slice(27, 54), d.slice(54, 81), d.slice(81)],
    turn: random(4), last: null, leader: -1, passed: [], order: [], done: false, log: [], moves: 0,
  };
}

function next(g, i) {
  for (let k = 1; k <= 4; k++) { const n = (i + k) % 4; if (g.hands[n].length) return n; }
  return -1;
}

function act(g, seat, ids) {
  if (g.done || seat !== g.turn) return false;
  const h = g.hands[seat], c = [];
  if (ids) {
    if (new Set(ids).size !== ids.length || !ids.length) return false;
    for (const id of ids) { const card = h.find(x => x.id === id); if (!card) return false; c.push(card); }
    const value = classify(c, g.level, g.last);
    if (!value) return false;
    g.last = value; g.leader = seat; g.passed = [];
    g.hands[seat] = h.filter(x => !ids.includes(x.id));
    g.log.push({ seat, text: labels[value.t], cards: c });
    if (!g.hands[seat].length) g.order.push(seat);
  } else {
    if (!g.last || seat === g.leader) return false;
    g.passed.push(seat);
    g.log.push({ seat, text: '不出', cards: [] });
  }
  g.moves++;
  if (g.order.length >= 3) {
    g.order.push(g.hands.findIndex(x => x.length));
    g.done = true;
    g.winner = g.order[0] % 2;
    const partner = g.order.indexOf((g.order[0] + 2) % 4);
    g.up = partner === 1 ? 3 : partner === 2 ? 2 : 1;
    return true;
  }
  const others = g.hands.map((x, i) => (x.length && i !== g.leader ? i : -1)).filter(x => x >= 0);
  if (g.last && others.every(i => g.passed.includes(i))) {
    const leader = g.leader;
    g.last = null; g.passed = [];
    g.turn = g.hands[leader].length ? leader : (g.hands[(leader + 2) % 4].length ? (leader + 2) % 4 : next(g, leader));
    g.leader = -1;
  } else g.turn = next(g, seat);
  return true;
}

function choose(g, seat) {
  const moves = candidates(g.hands[seat], g.level, g.last);
  if (!moves.length) return null;
  const finish = moves.find(x => x.n === g.hands[seat].length);
  if (finish) return finish.cards.map(c => c.id);
  if (g.last && g.leader % 2 === seat % 2) return null;
  moves.sort((a, b) => {
    const ca = a.t === 'bomb' || a.t === 'flush' || a.t === 'king';
    const cb = b.t === 'bomb' || b.t === 'flush' || b.t === 'king';
    return Number(ca) - Number(cb) || (g.last ? a.v - b.v : b.n - a.n) || a.v - b.v;
  });
  return moves[0].cards.map(c => c.id);
}

const labels = { single: '单张', pair: '对子', triple: '三张', full: '三带二', straight: '顺子', pairs: '三连对', plate: '钢板', bomb: '炸弹', flush: '同花顺', king: '四王炸' };

module.exports = { deck, shuffled, create, act, choose, candidates, classify, beats, power, labels, patterns };
