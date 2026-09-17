'use strict';
/**
 * 房间服务：内存态房间表 + 服务端权威牌局状态机。
 * 设计要点：
 *  - 房号 6 位数字，无歧义字符（去掉 0/O/1/I）
 *  - 服务端持有全部手牌与牌堆，客户端只收到「自己的手牌 + 公开信息」
 *  - 所有动作先服务端校验，通过后才广播
 *  - 断线保留座位，宽限期内重连可恢复
 */
const GD = require('../engine/guandan');
const config = require('./config');

/* 去掉易混字符的字母表（房号只用数字，但保留字母表给房间 token） */
const CODE_CHARS = '23456789';
const crypto = require('crypto');

function randCode(len) {
  let s = '';
  const buf = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) s += CODE_CHARS[buf[i] % CODE_CHARS.length];
  return s;
}

/* ---------- 各游戏适配器 ----------
 * 每个适配器暴露：
 *   init(seats, opts) -> state     开局
 *   act(state, seat, payload) -> {ok,msg}  服务端校验并推进
 *   publicView(state, seat) -> obj  该座位可见信息
 *   brief(state) -> obj  观战可见信息
 *   isDone(state) -> bool
 *   settlement(state) -> 结算结果
 */

/* ---- 掼蛋（4 人两队） ---- */
const guandanAdapter = {
  id: 'guandan', minPlayers: 4, maxPlayers: 4, seatsExact: 4,
  init(seats, opts) {
    const level = (opts && opts.level) || 2;
    const g = GD.create(level);
    return { game: 'guandan', level, g, startedAt: Date.now() };
  },
  act(state, seat, payload) {
    const g = state.g;
    if (g.done) return { ok: false, msg: '本局已结束' };
    if (seat !== g.turn) return { ok: false, msg: '还没轮到你' };
    const ids = payload && payload.ids;
    const clean = Array.isArray(ids) && ids.length ? ids.map(Number) : null;
    const okAct = GD.act(g, seat, clean);
    if (!okAct) return { ok: false, msg: '无效出牌' };
    return { ok: true };
  },
  autoAct(state, seat) {
    const ids = GD.choose(state.g, seat);
    return ids ? { ids } : { pass: true };
  },
  publicView(state, seat) {
    const g = state.g;
    return {
      game: 'guandan', level: state.level,
      turn: g.turn, done: g.done, moves: g.moves,
      handCounts: g.hands.map(h => h.length),
      myHand: seat >= 0 ? g.hands[seat] : [],
      last: g.last ? { t: g.last.t, v: g.last.v, n: g.last.n } : null,
      leader: g.leader, passed: g.passed.slice(),
      log: g.log.slice(-12),
      order: g.order.slice(), up: g.up, winner: g.winner,
    };
  },
  isDone(state) { return state.g.done; },
  settlement(state) {
    const g = state.g;
    return { game: 'guandan', winner: g.winner, up: g.up, order: g.order.slice() };
  },
};

/* ---- 德州扑克（2~6 人，简化可玩版：翻牌前/翻牌/转牌/河牌） ---- */
const holdemAdapter = (() => {
  const SUITS = ['s', 'h', 'd', 'c'];
  const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  function makeDeck() {
    const d = [];
    for (const s of SUITS) for (const r of RANKS) d.push({ r, s, id: r + s });
    return d;
  }
  function shuffle(d) {
    const a = d.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = crypto.randomBytes(4).readUInt32BE(0) % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  const RV = {}; RANKS.forEach((r, i) => RV[r] = i + 2);

  /* 7 选 5 取最强牌型，返回 [类别分, 若干比较值] */
  function eval5(cards) {
    const vs = cards.map(c => RV[c.r]).sort((a, b) => b - a);
    const suits = cards.map(c => c.s);
    const flush = suits.every(s => s === suits[0]);
    const uniq = [...new Set(vs)];
    const counts = {};
    vs.forEach(v => counts[v] = (counts[v] || 0) + 1);
    const groups = Object.keys(counts).map(Number).sort((a, b) => counts[b] - counts[a] || b - a);
    /* 顺子（含 A2345） */
    let straight = false, high = 0;
    if (uniq.length === 5) {
      if (uniq[0] - uniq[4] === 4) { straight = true; high = uniq[0]; }
      else if (uniq.join(',') === '14,5,4,3,2') { straight = true; high = 5; }
    }
    const cnt = groups.map(g => counts[g]).sort((a, b) => b - a);
    if (straight && flush) return [9, high];
    if (cnt[0] === 4) return [8, groups[0], groups[1]];
    if (cnt[0] === 3 && cnt[1] === 2) return [7, groups[0], groups[1]];
    if (flush) return [6, ...vs];
    if (straight) return [5, high];
    if (cnt[0] === 3) return [4, groups[0], ...vs.filter(v => v !== groups[0])];
    if (cnt[0] === 2 && cnt[1] === 2) {
      const ps = groups.filter(g => counts[g] === 2).sort((a, b) => b - a);
      return [3, ps[0], ps[1], ...vs.filter(v => !ps.includes(v))];
    }
    if (cnt[0] === 2) return [2, groups[0], ...vs.filter(v => v !== groups[0])];
    return [1, ...vs];
  }
  function best7(cards) {
    let best = null;
    for (let i = 0; i < cards.length; i++)
      for (let j = i + 1; j < cards.length; j++)
        for (let k = j + 1; k < cards.length; k++)
          for (let l = k + 1; l < cards.length; l++)
            for (let m = l + 1; m < cards.length; m++) {
              const v = eval5([cards[i], cards[j], cards[k], cards[l], cards[m]]);
              if (!best || cmp(v, best) > 0) best = v;
            }
    return best;
  }
  function cmp(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  }

  const STAGES = ['preflop', 'flop', 'turn', 'river', 'showdown'];

  return {
    id: 'holdem', minPlayers: 2, maxPlayers: 6, seatsExact: 0,
    init(seats, opts) {
      const sb = (opts && opts.sb) || 10, bb = (opts && opts.bb) || 20;
      const stack = (opts && opts.stack) || 1000;
      const d = shuffle(makeDeck());
      const n = seats.length;
      const players = seats.map((s, i) => ({
        seat: i, name: s.name, deviceId: s.deviceId,
        hole: [d.pop(), d.pop()], chips: stack, bet: 0, folded: false, allin: false,
      }));
      return {
        game: 'holdem', stage: 'preflop', deck: d, board: [], players,
        sb, bb, dealer: 0, turn: (0 + 1) % n, currentBet: bb, minRaise: bb,
        pot: 0, done: false, actedThisRound: [], history: [], startedAt: Date.now(),
        needToAct: new Set(players.filter(p => !p.folded).map(p => p.seat)),
      };
    },
    _postBlinds(st) {
      const n = st.players.length;
      const sbSeat = n === 2 ? st.dealer : (st.dealer + 1) % n;
      const bbSeat = n === 2 ? (st.dealer + 1) % n : (st.dealer + 2) % n;
      const sb = st.players[sbSeat], bb = st.players[bbSeat];
      const put = (p, amt) => { const a = Math.min(amt, p.chips); p.chips -= a; p.bet += a; st.pot += a; if (p.chips === 0) p.allin = true; return a; };
      put(sb, st.sb); put(bb, st.bb);
      st.currentBet = st.bb; st.turn = (bbSeat + 1) % n;
      st.blinds = { sb: sbSeat, bb: bbSeat };
    },
    act(st, seat, payload) {
      if (st.done) return { ok: false, msg: '本局已结束' };
      if (seat !== st.turn) return { ok: false, msg: '还没轮到你' };
      const p = st.players[seat];
      if (p.folded || p.allin) return { ok: false, msg: '你已无法行动' };
      const toCall = st.currentBet - p.bet;
      const action = payload && payload.action;
      if (action === 'fold') {
        p.folded = true;
      } else if (action === 'check') {
        if (toCall > 0) return { ok: false, msg: '有需跟注，不能过牌' };
      } else if (action === 'call') {
        if (toCall <= 0) return { ok: false, msg: '无需跟注' };
        const a = Math.min(toCall, p.chips); p.chips -= a; p.bet += a; st.pot += a;
        if (p.chips === 0) p.allin = true;
      } else if (action === 'raise') {
        const target = Number(payload.to);
        const minTarget = st.currentBet + st.minRaise;
        if (!Number.isSafeInteger(target) || target < minTarget) return { ok: false, msg: '加注不足最小加注额' };
        const need = target - p.bet;
        if (need > p.chips) return { ok: false, msg: '筹码不足' };
        p.chips -= need; p.bet += need; st.pot += need;
        st.minRaise = target - st.currentBet;
        st.currentBet = target;
        if (p.chips === 0) p.allin = true;
        /* 加注后其他人重新获得行动权 */
        st.needToAct = new Set(st.players.filter(q => !q.folded && !q.allin && q.seat !== seat).map(q => q.seat));
      } else if (action === 'allin') {
        const a = p.chips; p.chips = 0; p.bet += a; st.pot += a; p.allin = true;
        if (p.bet > st.currentBet) { st.minRaise = p.bet - st.currentBet; st.currentBet = p.bet; st.needToAct = new Set(st.players.filter(q => !q.folded && !q.allin && q.seat !== seat).map(q => q.seat)); }
      } else return { ok: false, msg: '未知动作' };
      st.needToAct.delete(seat);
      st.history.push({ seat, action: action || 'fold' });
      return { ok: true };
    },
    /* 推进：返回 true 表示阶段有变化 */
    advance(st) {
      if (st.done) return false;
      const live = st.players.filter(p => !p.folded);
      if (live.length <= 1) { st.done = true; st.winners = [live[0].seat]; return true; }
      if (st.needToAct.size === 0) {
        st.players.forEach(p => p.bet = 0);
        st.currentBet = 0; st.minRaise = st.bb;
        const idx = STAGES.indexOf(st.stage);
        if (st.stage === 'river') { st.stage = 'showdown'; st.done = true; return true; }
        st.stage = STAGES[idx + 1];
        if (st.stage === 'flop') st.board.push(st.deck.pop(), st.deck.pop(), st.deck.pop());
        else if (st.stage === 'turn' || st.stage === 'river') st.board.push(st.deck.pop());
        const n = st.players.length;
        let t = (st.dealer + 1) % n;
        while (st.players[t].folded || st.players[t].allin) t = (t + 1) % n;
        st.turn = t;
        st.needToAct = new Set(st.players.filter(p => !p.folded && !p.allin).map(p => p.seat));
        return true;
      }
      const n = st.players.length;
      let t = (st.turn + 1) % n, guard = 0;
      while ((st.players[t].folded || st.players[t].allin) && guard++ < n) t = (t + 1) % n;
      st.turn = t;
      return false;
    },
    showdown(st) {
      if (!st.done) return null;
      const live = st.players.filter(p => !p.folded);
      if (live.length === 1) return { winners: [live[0].seat], hands: {} };
      const scored = live.map(p => ({ seat: p.seat, cards: p.hole.concat(st.board), v: best7(p.hole.concat(st.board)) }));
      scored.sort((a, b) => cmp(b.v, a.v));
      const best = scored[0].v;
      const winners = scored.filter(s => cmp(s.v, best) === 0).map(s => s.seat);
      const hands = {};
      scored.forEach(s => hands[s.seat] = s.cards.map(c => c.id));
      return { winners, hands };
    },
    isDone(st) { return st.done; },
    /* 超时托管：能过牌就过牌，否则弃牌 */
    autoAct(st, seat) {
      const p = st.players[seat];
      if (!p || p.folded || p.allin) return null;
      const toCall = st.currentBet - p.bet;
      if (toCall <= 0) return { action: 'check' };
      /* 跟注额小于筹码 10% 时选择跟注，否则弃牌 */
      if (toCall <= p.chips * 0.1) return { action: 'call' };
      return { action: 'fold' };
    },
    settlement(st) {
      const res = this.showdown(st) || { winners: [] };
      return { game: 'holdem', winners: res.winners, pot: st.pot, board: st.board.map(c => c.id), hands: res.hands || {} };
    },
    publicView(st, seat) {
      return {
        game: 'holdem', stage: st.stage, turn: st.turn, done: st.done,
        board: st.board.map(c => c.id), pot: st.pot, currentBet: st.currentBet, minRaise: st.minRaise,
        dealer: st.dealer, blinds: st.blinds,
        players: st.players.map(p => ({
          seat: p.seat, name: p.name, chips: p.chips, bet: p.bet, folded: p.folded, allin: p.allin,
          hole: (seat === p.seat || (st.done && !p.folded)) ? p.hole.map(c => c.id) : (p.folded ? [] : ['??', '??']),
        })),
        mySeat: seat,
        history: st.history.slice(-12),
      };
    },
  };
})();

/* ---- 炸金花（2~6 人真人桌：闷牌/看牌/跟注/加注/比牌，服务端权威） ---- */
const goldAdapter = (() => {
  const SUITS = ['s', 'h', 'd', 'c'];
  function makeDeck() {
    const d = [];
    for (const s of SUITS) for (let r = 2; r <= 14; r++) {
      const rr = r === 14 ? 'A' : r === 13 ? 'K' : r === 12 ? 'Q' : r === 11 ? 'J' : String(r);
      d.push({ r, s, id: rr + s });
    }
    return d;
  }
  function shuffle(d) {
    const a = d.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = crypto.randomBytes(4).readUInt32BE(0) % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  /* 牌型与前端单机 goldValue 逐字对齐：豹子>顺金>金花>顺子>对子>单张，A23 为顺（high=3） */
  function goldValue(cards) {
    const v = cards.map(c => c.r).sort((a, b) => b - a);
    const flush = cards.every(c => c.s === cards[0].s);
    let straight = v[0] - v[1] === 1 && v[1] - v[2] === 1, high = v[0];
    if (v.join(',') === '14,3,2') { straight = true; high = 3; }
    if (v[0] === v[2]) return [5, v[0]];
    if (flush && straight) return [4, high];
    if (flush) return [3].concat(v);
    if (straight) return [2, high];
    if (v[0] === v[1]) return [1, v[0], v[2]];
    if (v[1] === v[2]) return [1, v[1], v[0]];
    return [0].concat(v);
  }
  function cmp(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  }
  return {
    id: 'gold', minPlayers: 2, maxPlayers: 6, seatsExact: 0,
    init(seats, opts) {
      const ante = (opts && opts.ante) || 50, stack = (opts && opts.stack) || 1000;
      const deck = shuffle(makeDeck());
      const players = seats.map((s) => ({
        seat: s.seat, name: s.name, deviceId: s.deviceId,
        hand: [deck.pop(), deck.pop(), deck.pop()],
        seen: false, folded: false, chips: stack - ante, paid: ante,
      }));
      return {
        game: 'gold', ante, base: ante, stack, unit: ante,
        pot: players.length * ante, turn: 0, round: 1, roundStart: 0, step: 0,
        deck, players, done: false, winners: null, showdown: false,
        log: [], startedAt: Date.now(),
      };
    },
    _finishIf(st) {
      const live = st.players.filter(p => !p.folded);
      if (live.length <= 1) { st.done = true; st.winners = live.map(p => p.seat); return true; }
      return false;
    },
    _showdown(st) {
      st.done = true; st.showdown = true;
      const live = st.players.filter(x => !x.folded);
      const sorted = live.slice().sort((a, b) => cmp(goldValue(b.hand), goldValue(a.hand)));
      const best = goldValue(sorted[0].hand);
      st.winners = sorted.filter(x => cmp(goldValue(x.hand), best) === 0).map(x => x.seat);
    },
    _nextTurn(st) {
      const n = st.players.length;
      let t = (st.turn + 1) % n, guard = 0;
      while (st.players[t].folded && guard++ < n) t = (t + 1) % n;
      st.turn = t;
      st.step++;
      if (st.turn === st.roundStart) { st.round++; st.roundStart = st.turn; }
      if (st.round > 10 || st.step > 60) this._showdown(st);
    },
    act(st, seat, payload) {
      if (st.done) return { ok: false, msg: '本局已结束' };
      if (seat !== st.turn) return { ok: false, msg: '还没轮到你' };
      const p = st.players.find(x => x.seat === seat);
      if (!p) return { ok: false, msg: '座位无效' };
      if (p.folded) return { ok: false, msg: '你已弃牌' };
      const action = payload && payload.action;
      const cost = st.unit * (p.seen ? 2 : 1);
      if (action === 'look') {
        if (p.seen) return { ok: false, msg: '你已看过牌' };
        p.seen = true;
        st.log.push({ seat, text: '看了牌' });
      } else if (action === 'call') {
        if (cost > p.chips) return { ok: false, msg: '筹码不足，只能弃牌' };
        p.chips -= cost; p.paid += cost; st.pot += cost;
        st.log.push({ seat, text: (p.seen ? '看牌跟注 ' : '闷牌跟注 ') + cost });
      } else if (action === 'raise') {
        const nu = st.unit + st.base;
        if (nu > st.base * 4) return { ok: false, msg: '已达加注上限' };
        const c = nu * (p.seen ? 2 : 1);
        if (c > p.chips) return { ok: false, msg: '筹码不足' };
        st.unit = nu; p.chips -= c; p.paid += c; st.pot += c;
        st.log.push({ seat, text: '加注，单注到 ' + nu });
      } else if (action === 'fold') {
        p.folded = true;
        st.log.push({ seat, text: '弃牌' });
        if (this._finishIf(st)) return { ok: true };
      } else if (action === 'compare') {
        if (st.round < 3) return { ok: false, msg: '第 3 轮起才能比牌' };
        const tSeat = Number(payload.target);
        const t = st.players.find(x => x.seat === tSeat);
        if (!t || tSeat === seat || t.folded) return { ok: false, msg: '比牌目标无效' };
        if (cost > p.chips) return { ok: false, msg: '筹码不足' };
        p.chips -= cost; p.paid += cost; st.pot += cost;
        const loser = cmp(goldValue(p.hand), goldValue(t.hand)) > 0 ? t : p;
        loser.folded = true;
        st.log.push({ seat, text: '与 ' + t.name + ' 比牌，' + loser.name + ' 落败' });
        if (this._finishIf(st)) return { ok: true };
      } else return { ok: false, msg: '未知动作' };
      this._nextTurn(st);
      return { ok: true };
    },
    autoAct(st, seat) {
      const p = st.players.find(x => x.seat === seat);
      if (!p || p.folded) return null;
      const cost = st.unit * (p.seen ? 2 : 1);
      if (cost <= p.chips) return { action: 'call' };
      return { action: 'fold' };
    },
    publicView(st, seat) {
      const me = st.players.find(x => x.seat === seat);
      return {
        game: 'gold', round: st.round, pot: st.pot, unit: st.unit, base: st.base,
        maxUnit: st.base * 4, turn: st.turn, done: st.done, winners: st.winners,
        showdown: st.showdown, mySeat: seat,
        cost: st.unit * (me && me.seen ? 2 : 1),
        players: st.players.map(p => ({
          seat: p.seat, name: p.name, seen: p.seen, folded: p.folded, paid: p.paid, chips: p.chips,
          hand: (seat === p.seat || (st.done && st.showdown && !p.folded)) ? p.hand.map(c => c.id) : ['??', '??', '??'],
        })),
        log: st.log.slice(-12),
      };
    },
    isDone(st) { return st.done; },
    settlement(st) {
      const winners = st.winners || [];
      const share = winners.length ? Math.floor(st.pot / winners.length) : 0;
      const payouts = {};
      st.players.forEach(p => { payouts[p.seat] = winners.includes(p.seat) ? share : 0; });
      const hands = {};
      st.players.forEach(p => { if (!p.folded) hands[p.seat] = p.hand.map(c => c.id); });
      return { game: 'gold', winners, pot: st.pot, payouts, hands };
    },
  };
})();

/* ---- 骰子比大小（2~6 人真人桌：轮流掷 3 骰，点数最大者通吃底注池，并列平分；豹子最大） ---- */
const diceDuelAdapter = {
  id: 'diceduel', minPlayers: 2, maxPlayers: 6, seatsExact: 0,
  init(seats, opts) {
    const ante = (opts && opts.ante) || 50;
    const players = seats.map(s => ({ seat: s.seat, name: s.name, deviceId: s.deviceId, dice: null, sum: 0, triple: false }));
    return {
      game: 'diceduel', ante, pot: players.length * ante, turn: 0,
      players, done: false, winners: null, log: [], startedAt: Date.now(),
    };
  },
  _rank(d) {
    const t = d[0] === d[1] && d[1] === d[2];
    const sum = d[0] + d[1] + d[2];
    return { t, sum, key: (t ? 1000 : 0) + sum };
  },
  act(st, seat, payload) {
    if (st.done) return { ok: false, msg: '本局已结束' };
    if (seat !== st.turn) return { ok: false, msg: '还没轮到你' };
    const p = st.players.find(x => x.seat === seat);
    if (!p) return { ok: false, msg: '座位无效' };
    if (p.dice) return { ok: false, msg: '你已经掷过了' };
    if (payload && payload.action && payload.action !== 'roll') return { ok: false, msg: '未知动作' };
    const buf = crypto.randomBytes(3);
    p.dice = [buf[0] % 6 + 1, buf[1] % 6 + 1, buf[2] % 6 + 1];
    const rk = this._rank(p.dice);
    p.sum = rk.sum; p.triple = rk.t;
    st.log.push({ seat, text: (rk.t ? '掷出豹子 ' : '掷出 ') + rk.sum + ' 点' });
    const next = st.players.find(x => !x.dice);
    if (!next) {
      const ranked = st.players.map(x => ({ seat: x.seat, key: this._rank(x.dice).key })).sort((a, b) => b.key - a.key);
      const best = ranked[0].key;
      st.winners = ranked.filter(x => x.key === best).map(x => x.seat);
      st.done = true;
      st.turn = -1;
    } else {
      st.turn = next.seat;
    }
    return { ok: true };
  },
  autoAct() { return { action: 'roll' }; },
  publicView(st, seat) {
    return {
      game: 'diceduel', pot: st.pot, ante: st.ante, turn: st.turn, done: st.done,
      winners: st.winners, mySeat: seat,
      players: st.players.map(p => ({ seat: p.seat, name: p.name, dice: p.dice, sum: p.sum, triple: p.triple })),
      log: st.log.slice(-12),
    };
  },
  isDone(st) { return st.done; },
  settlement(st) {
    const winners = st.winners || [];
    const share = winners.length ? Math.floor(st.pot / winners.length) : 0;
    const payouts = {};
    st.players.forEach(p => { payouts[p.seat] = winners.includes(p.seat) ? share : 0; });
    const dice = {};
    st.players.forEach(p => { dice[p.seat] = p.dice; });
    return { game: 'diceduel', winners, pot: st.pot, ante: st.ante, payouts, dice };
  },
};

/* ---- 通用小游戏适配器（21点 / 猜骰子为 1 人 vs 服务端 AI 不适用联机；
         炸金花与骰子比大小已有真人房实现） ---- */
const ADAPTERS = { guandan: guandanAdapter, holdem: holdemAdapter, gold: goldAdapter, diceduel: diceDuelAdapter };

let roomSeq = 0;

class Room {
  constructor(code, game, opts, store) {
    this.code = code;
    this.game = game;
    this.opts = opts || {};
    this.store = store;
    this.id = ++roomSeq;
    this.seats = [];          // { seat, deviceId, name, online, ws, ready, lastSeen }
    this.roundNo = 0;         // 本轮已完成的局数（好友房按「局数」参数结算轮次）
    this.roundEnded = false;  // 本轮局数已打满
    this.state = null;        // 服务端权威牌局状态
    this.started = false;
    this.hostDevice = null;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.tickTimer = null;
  }

  get adapter() { return ADAPTERS[this.game]; }

  /* 房主设定的人数上限（夹在玩法允许区间内） */
  maxPlayers() {
    const ad = this.adapter;
    const cap = Number(this.opts && this.opts.maxPlayers) || 0;
    if (!cap) return ad.maxPlayers;
    return Math.max(ad.minPlayers, Math.min(ad.maxPlayers, cap));
  }
  /* 房主设定的局数（0 = 不限） */
  roundTotal() { return Math.max(0, Number(this.opts && this.opts.rounds) || 0); }
  /* 房主设定的单步行动时长（毫秒；默认取全局配置，范围 10s~600s） */
  turnMs() {
    const v = Number(this.opts && this.opts.turnMs) || 0;
    if (!v) return config.room.actionTimeoutMs;
    return Math.max(10e3, Math.min(600e3, v));
  }
  /* 娱乐加倍：本房结算积分翻倍（不改玩法内部数值） */
  doubleFactor() { return (this.opts && this.opts.double) ? 2 : 1; }
  /* 明牌房：开局即公开所有人手牌 */
  isOpenHand() { return !!(this.opts && this.opts.open); }
  /* 房间规则摘要（下发前端展示） */
  ruleSummary() {
    const parts = [];
    parts.push(this.maxPlayers() + ' 人房');
    parts.push(this.roundTotal() ? this.roundTotal() + ' 局' : '不限局数');
    parts.push(Math.round(this.turnMs() / 1000) + ' 秒/步');
    if (this.opts && this.opts.double) parts.push('积分×2');
    if (this.isOpenHand()) parts.push('明牌');
    return parts.join(' · ');
  }
  /* 房主设定的单步行动时长（毫秒；默认取全局配置，范围 10s~600s） */
  turnMs() {
    const v = Number(this.opts && this.opts.turnMs) || 0;
    if (!v) return config.room.actionTimeoutMs;
    return Math.max(10e3, Math.min(600e3, v));
  }
  /* 娱乐加倍：本房结算积分翻倍（不改玩法内部数值） */
  doubleFactor() { return (this.opts && this.opts.double) ? 2 : 1; }
  /* 明牌房：开局即公开所有人手牌 */
  isOpenHand() { return !!(this.opts && this.opts.open); }
  /* 房间规则摘要（下发前端展示） */
  ruleSummary() {
    const parts = [];
    parts.push(this.maxPlayers() + ' 人房');
    parts.push(this.roundTotal() ? this.roundTotal() + ' 局' : '不限局数');
    parts.push(Math.round(this.turnMs() / 1000) + ' 秒/步');
    if (this.opts && this.opts.double) parts.push('积分×2');
    if (this.isOpenHand()) parts.push('明牌');
    return parts.join(' · ');
  }

  isEmpty() { return this.seats.every(s => !s.online); }

  seatOf(deviceId) { const s = this.seats.find(x => x.deviceId === deviceId); return s ? s.seat : -1; }

  join(deviceId, name, ws) {
    let s = this.seats.find(x => x.deviceId === deviceId);
    if (s) { s.online = true; s.ws = ws; s.lastSeen = Date.now(); return { ok: true, seat: s.seat, rejoin: true }; }
    const ad = this.adapter;
    if (this.started) return { ok: false, msg: '牌局已开始，无法加入' };
    const cap = this.maxPlayers();
    if (this.seats.length >= cap) return { ok: false, msg: '房间已满（' + cap + ' 人房）' };
    const used = new Set(this.seats.map(x => x.seat));
    let seat = 0; while (used.has(seat)) seat++;
    this.seats.push({ seat, deviceId, name: name || '牌友', online: true, ws, ready: false, lastSeen: Date.now() });
    if (!this.hostDevice) this.hostDevice = deviceId;
    this.lastActivity = Date.now();
    return { ok: true, seat };
  }

  leave(deviceId) {
    const i = this.seats.findIndex(x => x.deviceId === deviceId);
    if (i < 0) return;
    if (this.started && this.state && !this.adapter.isDone(this.state)) {
      /* 牌局进行中：标记离线，等待重连；不直接移除座位 */
      this.seats[i].online = false;
      this.seats[i].ws = null;
      this.seats[i].leftAt = Date.now();
      return;
    }
    this.seats.splice(i, 1);
    if (this.hostDevice === deviceId && this.seats.length) this.hostDevice = this.seats[0].deviceId;
  }

  canStart() {
    const ad = this.adapter;
    /* 已开始：仅当上一局尚未结束才算「进行中」；上一局结束后房间回到可开局（支持连续对局） */
    if (this.started && !(this.state && this.adapter.isDone(this.state))) return { ok: false, msg: '已开始' };
    if (ad.seatsExact && this.seats.length !== ad.seatsExact) return { ok: false, msg: this.game === 'guandan' ? '掼蛋需要正好 4 人' : '人数不符' };
    if (this.seats.length < ad.minPlayers) return { ok: false, msg: '至少 ' + ad.minPlayers + ' 人才能开始' };
    /* 快速匹配房由服务端凑满即开，不需要玩家点准备；好友房仍需全员准备 */
    if (!this.matched && !this.seats.every(s => s.ready)) return { ok: false, msg: '还有玩家未准备' };
    return { ok: true };
  }

  start() {
    const chk = this.canStart();
    if (!chk.ok) return chk;
    if (this.roundEnded) { this.roundNo = 0; this.roundEnded = false; }   /* 开新一轮 */
    const seats = this.seats.map(s => ({ seat: s.seat, name: s.name, deviceId: s.deviceId }));
    this.state = this.adapter.init(seats, this.opts);
    if (this.game === 'holdem' && this.adapter._postBlinds) this.adapter._postBlinds(this.state);
    this.started = true;
    this.settleSent = false;
    this.settledFlag = false;
    this.settledDelivered = false;
    this.result = null;
    this.lastActivity = Date.now();
    return { ok: true };
  }

  /* 一局结束 → 房间回到等待态，房主可立刻开下一局（或新一轮）
     修复：此前 started 从未复位，好友房打完一局后「开始牌局」永远返回「已开始」 */
  backToWaiting() {
    /* 只把房间从「进行中」放回「可开局」：state/result/settleSent 保留（结算留存、幂等守卫），
       下一局 start() 会统一重置。斗地主式：默认全员继续，房主一键开下一局。 */
    this.started = false;
    this.settledFlag = false;
    this.seats.forEach(s => { s.ready = true; });
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
  }

  act(deviceId, payload) {
    if (!this.started || !this.state) return { ok: false, msg: '牌局未开始' };
    const seat = this.seatOf(deviceId);
    if (seat < 0) return { ok: false, msg: '你不在座位上' };
    const r = this.adapter.act(this.state, seat, payload);
    if (r.ok) {
      this.lastActivity = Date.now();
      if (this.game === 'holdem') this._advanceHoldem();
      else this.stepAuto();
      this._checkSettle();
    }
    return r;
  }

  /* 统一结算收口：任何路径终结都走这里，保证 result 一定被设置且只落库一次 */
  _checkSettle() {
    if (!this.state || !this.adapter.isDone(this.state)) return;
    if (this.settledFlag) return;
    this.settledFlag = true;
    const res = this.adapter.settlement(this.state);
    this._settle(res);
  }

  _advanceHoldem() {
    const ad = this.adapter;
    let guard = 0;
    while (!this.state.done && guard++ < 100) {
      const changed = ad.advance(this.state);
      if (changed) continue;
      break;
    }
  }

  /* 掼蛋 AI 托管：在等待人类操作时也会驱动空位 AI */
  stepAuto() {
    const ad = this.adapter;
    if (!this.started || !this.state || ad.isDone(this.state)) return;
    if (this.game === 'holdem') {
      /* 德州没有 AI 托管（真人房），只检查是否需要收尾 */
      const live = this.state.players.filter(p => !p.folded);
      if (live.length <= 1) this.state.done = true;
      return;
    }
    if (this.game === 'guandan') {
      /* 掼蛋当前座位若离线则由服务端代打 */
      const seat = this.state.g.turn;
      const s = this.seats.find(x => x.seat === seat);
      if (!s || !s.online) {
        const payload = ad.autoAct(this.state, seat);
        if (payload && payload.ids) ad.act(this.state, seat, { ids: payload.ids });
        else if (payload && payload.pass) ad.act(this.state, seat, null);
      }
      return;
    }
    if (this.game === 'gold' || this.game === 'diceduel') {
      /* 炸金花/骰子比大小：当前行动座位离线则代操作（call-or-fold / roll） */
      const seat = this.state.turn;
      if (typeof seat === 'number' && seat >= 0) {
        const s = this.seats.find(x => x.seat === seat);
        if (!s || !s.online) {
          const payload = ad.autoAct(this.state, seat);
          if (payload) ad.act(this.state, seat, payload);
        }
      }
    }
  }

  /* 座位头像：从玩家档案实时查（预设头像 id，如 a01） */
  avatarOf(deviceId) {
    try { const p = this.store.getPlayer(deviceId); return (p && p.avatar) || 'a01'; } catch (e) { return 'a01'; }
  }

  /* 座位佩戴称号（称号 id，前端转成名称与图标） */
  titleOf(deviceId) {
    try { return this.store.titleOf(deviceId) || ''; } catch (e) { return ''; }
  }

  /* 座位签名：从玩家档案实时查（个人简介，可为空） */
  bioOf(deviceId) {
    try { const p = this.store.getPlayer(deviceId); return (p && p.bio) || ''; } catch (e) { return ''; }
  }

  viewFor(deviceId) {
    if (!this.started || !this.state) {
      return { game: this.game, waiting: true, seats: this.seats.map(s => ({ seat: s.seat, deviceId: s.deviceId, name: s.name, avatar: this.avatarOf(s.deviceId), bio: this.bioOf(s.deviceId), title: this.titleOf(s.deviceId), ready: s.ready, online: s.online })), host: this.hostDevice, maxPlayers: this.maxPlayers(), rounds: this.roundTotal(), roundNo: this.roundNo, roundEnded: !!this.roundEnded,
        rules: { open: this.isOpenHand(), double: this.doubleFactor() > 1, turnMs: this.turnMs(), summary: this.ruleSummary() } };
    }
    const seat = this.seatOf(deviceId);
    const v = this.adapter.publicView(this.state, seat);
    v.seatInfo = this.seats.map(s => ({ seat: s.seat, deviceId: s.deviceId, name: s.name, avatar: this.avatarOf(s.deviceId), bio: this.bioOf(s.deviceId), title: this.titleOf(s.deviceId), online: s.online, ready: s.ready }));
    v.host = this.hostDevice;
    v.rules = { open: this.isOpenHand(), double: this.doubleFactor() > 1, turnMs: this.turnMs(), summary: this.ruleSummary() };
    /* 明牌房：把所有人手牌换成真牌（德州用 players[].hole，金花用 players[].hand，均按座位下标对齐） */
    if (this.isOpenHand() && this.state && this.state.players && v.players) {
      for (let i = 0; i < v.players.length && i < this.state.players.length; i++) {
        const src = this.state.players[i];
        const dst = v.players[i];
        if (!src || !dst) continue;
        const ids = function (arr) { return (arr || []).map(function (c) { return (c && c.id) ? c.id : c; }); };
        if (src.hole) dst.hole = ids(src.hole);
        if (src.hand) dst.hand = ids(src.hand);
        if (dst.seat === undefined && src.seat !== undefined) dst.seat = src.seat;
      }
      v.openHand = true;
    }
    /* 注意：不能叫 round —— 炸金花/骰子用 state.round 表示「第几轮」，会冲突 */
    v.roundInfo = { no: (this.roundNo || 0) + 1, total: this.roundTotal() };
    /* 思考倒计时：与「行动超时自动代打」严格对齐。下发剩余毫秒（而非绝对时间戳），
       避免客户端时钟与服务器不一致导致倒计时错乱。 */
    try {
      const done = this.adapter.isDone(this.state);
      const turn = this.game === 'guandan' ? (this.state.g ? this.state.g.turn : -1) : this.state.turn;
      v.turnLeftMs = (!done && typeof turn === 'number' && turn >= 0)
        ? Math.max(0, this.lastActivity + this.turnMs() - Date.now()) : 0;
    } catch (e) { v.turnLeftMs = 0; }
    return v;
  }

  _settle(res) {
    this.result = res;
    this.settledAt = Date.now();
    this.roundNo = (this.roundNo || 0) + 1;
    const total = this.roundTotal();
    if (total > 0 && this.roundNo >= total) this.roundEnded = true;
    /* 记录对局 */
    try {
      this.store.recordMatch({ game: this.game, roomCode: this.code, mode: 'friend', result: res });
    } catch (e) { console.warn('[room] 记录对局失败', e.message); }
  }
}

class RoomManager {
  constructor(store) {
    this.rooms = new Map();     // code -> Room
    this.byDevice = new Map();  // deviceId -> code
    this.store = store;
    this._timer = setInterval(() => this._sweep(), 60e3);
    if (this._timer.unref) this._timer.unref();
  }

  create(game, deviceId, name, opts) {
    if (!ADAPTERS[game]) return { ok: false, msg: '该玩法暂不支持好友联机' };
    /* 一个设备同时只在一个房间 */
    this.leaveCurrent(deviceId);
    let code, guard = 0;
    do { code = randCode(config.room.codeLength); } while (this.rooms.has(code) && guard++ < 100);
    const room = new Room(code, game, opts, this.store);
    const r = room.join(deviceId, name, null);
    if (!r.ok) return r;
    this.rooms.set(code, room);
    this.byDevice.set(deviceId, code);
    return { ok: true, code, seat: r.seat, room };
  }

  get(code) { return this.rooms.get(code) || null; }

  join(code, deviceId, name, ws) {
    const room = this.get(code);
    if (!room) return { ok: false, msg: '房间不存在' };
    this.leaveCurrent(deviceId);
    const r = room.join(deviceId, name, ws);
    if (!r.ok) return r;
    this.byDevice.set(deviceId, code);
    return { ok: true, seat: r.seat, room, rejoin: !!r.rejoin };
  }

  leaveCurrent(deviceId) {
    const code = this.byDevice.get(deviceId);
    if (!code) return;
    const room = this.rooms.get(code);
    if (room) room.leave(deviceId);
    this.byDevice.delete(deviceId);
  }

  _sweep() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      /* 空房回收 */
      if (room.isEmpty() && now - room.lastActivity > config.room.idleTimeoutMs) {
        if (room.tickTimer) clearInterval(room.tickTimer);
        this.rooms.delete(code);
        for (const s of room.seats) this.byDevice.delete(s.deviceId);
        continue;
      }
      /* 未开局且长时间无活动 */
      if (!room.started && now - room.lastActivity > config.room.idleTimeoutMs) {
        this.rooms.delete(code);
        for (const s of room.seats) this.byDevice.delete(s.deviceId);
      }
    }
  }

  stats() {
    let players = 0, playing = 0;
    for (const room of this.rooms.values()) {
      players += room.seats.length;
      if (room.started && !(room.state && room.adapter.isDone(room.state))) playing++;
    }
    return { rooms: this.rooms.size, players, playing };
  }

  close() { clearInterval(this._timer); }
}

module.exports = { RoomManager, Room, ADAPTERS, randCode };
