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

/* ---- 通用小游戏适配器（21点 / 炸金花 / 猜骰子 / 骰子比大小）都退化为 1 人 vs 服务端 AI 不适用联机，
         故好友房只支持「掼蛋（4人）」与「德州（2~6人）」两个真人对战玩法 ---- */
const ADAPTERS = { guandan: guandanAdapter, holdem: holdemAdapter };

let roomSeq = 0;

class Room {
  constructor(code, game, opts, store) {
    this.code = code;
    this.game = game;
    this.opts = opts || {};
    this.store = store;
    this.id = ++roomSeq;
    this.seats = [];          // { seat, deviceId, name, online, ws, ready, lastSeen }
    this.state = null;        // 服务端权威牌局状态
    this.started = false;
    this.hostDevice = null;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.tickTimer = null;
  }

  get adapter() { return ADAPTERS[this.game]; }

  isEmpty() { return this.seats.every(s => !s.online); }

  seatOf(deviceId) { const s = this.seats.find(x => x.deviceId === deviceId); return s ? s.seat : -1; }

  join(deviceId, name, ws) {
    let s = this.seats.find(x => x.deviceId === deviceId);
    if (s) { s.online = true; s.ws = ws; s.lastSeen = Date.now(); return { ok: true, seat: s.seat, rejoin: true }; }
    const ad = this.adapter;
    if (this.started) return { ok: false, msg: '牌局已开始，无法加入' };
    if (this.seats.length >= ad.maxPlayers) return { ok: false, msg: '房间已满' };
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
    if (this.started) return { ok: false, msg: '已开始' };
    if (ad.seatsExact && this.seats.length !== ad.seatsExact) return { ok: false, msg: this.game === 'guandan' ? '掼蛋需要正好 4 人' : '人数不符' };
    if (this.seats.length < ad.minPlayers) return { ok: false, msg: '至少 ' + ad.minPlayers + ' 人才能开始' };
    if (!this.seats.every(s => s.ready)) return { ok: false, msg: '还有玩家未准备' };
    return { ok: true };
  }

  start() {
    const chk = this.canStart();
    if (!chk.ok) return chk;
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
    }
  }

  viewFor(deviceId) {
    if (!this.started || !this.state) {
      return { game: this.game, waiting: true, seats: this.seats.map(s => ({ seat: s.seat, name: s.name, ready: s.ready, online: s.online })), host: this.hostDevice };
    }
    const seat = this.seatOf(deviceId);
    const v = this.adapter.publicView(this.state, seat);
    v.seatInfo = this.seats.map(s => ({ seat: s.seat, name: s.name, online: s.online, ready: s.ready }));
    v.host = this.hostDevice;
    return v;
  }

  _settle(res) {
    this.result = res;
    this.settledAt = Date.now();
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
    if (!ADAPTERS[game]) return { ok: false, msg: '该玩法暂不支持好友联机（仅掼蛋、德州）' };
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
