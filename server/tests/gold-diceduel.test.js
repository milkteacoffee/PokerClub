'use strict';
/**
 * 炸金花 / 骰子比大小 联机测试：
 * A. adapter 单测（直接调 rooms.js 导出的 ADAPTERS）
 *   1) gold: 发牌/底注/牌型大小（豹子>顺金>金花>顺子>对子>单张，A23 特殊顺）
 *   2) gold: 看牌/闷牌跟注费用、加注上限、第3轮起比牌、弃牌终结、摊牌并列
 *   3) gold: publicView 只给本人真牌、settlement 结算
 *   4) diceduel: 轮流掷骰、豹子压一切、并列平分、结算
 * B. 端到端（真实 HTTP+WS 服务，端口 18124）
 *   5) /api/info 返回 4 个联机玩法
 *   6) 非联机玩法建房被拒绝
 *   7) 炸金花：建房→加入→准备→开局→弃牌→结算广播
 *   8) 骰子比大小：建房→开局→轮流掷骰→结算（dice/payouts 完整）
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { WebSocket } = require('ws');

/* ---------------- A. adapter 单测 ---------------- */
const { ADAPTERS, RoomManager } = require('../src/rooms');

let pass = 0, fail = 0; const failures = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; failures.push(msg); } }
function eq(a, b, msg) { try { assert.deepStrictEqual(a, b); pass++; } catch (e) { fail++; failures.push(msg + ' :: ' + e.message); } }

function testGoldAdapter() {
  const ad = ADAPTERS.gold;
  ok(!!ad, 'gold adapter 存在');
  ok(ad.minPlayers === 2 && ad.maxPlayers === 6, 'gold 2~6 人');

  /* 1. 发牌与底注 */
  const seats = [{ seat: 0, name: '甲', deviceId: 'd0' }, { seat: 1, name: '乙', deviceId: 'd1' }];
  const st = ad.init(seats, {});
  ok(st.players.length === 2, 'gold 两个座位');
  ok(st.players.every(p => p.hand.length === 3), '每人 3 张底牌');
  ok(st.players.every(p => p.chips === 950 && p.paid === 50), '筹码 950 / 已付底注 50');
  ok(st.pot === 100 && st.unit === 50 && st.base === 50 && st.round === 1 && st.turn === 0, '底池 100，单注 50，第 1 轮，座位 0 先行');
  ok(st.players[0].hand.every(c => c && c.r >= 2 && c.r <= 14), '手牌为合法牌');

  /* 2. 牌型大小（通过 _showdown 构造对局验证） */
  const mk = (cards) => cards;
  const pair = [
    { seat: 0, name: '豹子', deviceId: 'd0', hand: mk([{ r: 9, s: 's' }, { r: 9, s: 'h' }, { r: 9, s: 'd' }]), seen: false, folded: false, chips: 900, paid: 100 },
    { seat: 1, name: '顺金', deviceId: 'd1', hand: mk([{ r: 5, s: 's' }, { r: 4, s: 's' }, { r: 3, s: 's' }]), seen: false, folded: false, chips: 900, paid: 100 },
  ];
  const st1 = { game: 'gold', pot: 200, players: pair, done: false, winners: null, showdown: false, log: [] };
  ad._showdown(st1);
  eq(st1.winners, [0], '豹子压过顺金');

  const st2 = { game: 'gold', pot: 200, players: [
    { seat: 0, name: 'A23', deviceId: 'd0', hand: mk([{ r: 14, s: 's' }, { r: 3, s: 'h' }, { r: 2, s: 'd' }]), seen: false, folded: false, chips: 900, paid: 100 },
    { seat: 1, name: '234', deviceId: 'd1', hand: mk([{ r: 2, s: 's' }, { r: 3, s: 'h' }, { r: 4, s: 'd' }]), seen: false, folded: false, chips: 900, paid: 100 },
  ], done: false, winners: null, showdown: false, log: [] };
  ad._showdown(st2);
  eq(st2.winners, [1], 'A23 是最小顺（high=3），输给 234');

  const st3 = { game: 'gold', pot: 200, players: [
    { seat: 0, name: '金花', deviceId: 'd0', hand: mk([{ r: 5, s: 's' }, { r: 4, s: 's' }, { r: 3, s: 's' }]), seen: false, folded: false, chips: 900, paid: 100 },
    { seat: 1, name: '对A', deviceId: 'd1', hand: mk([{ r: 14, s: 's' }, { r: 14, s: 'h' }, { r: 2, s: 'd' }]), seen: false, folded: false, chips: 900, paid: 100 },
  ], done: false, winners: null, showdown: false, log: [] };
  ad._showdown(st3);
  eq(st3.winners, [0], '顺金（同花 345）压过对 A');

  const st4 = { game: 'gold', pot: 200, players: [
    { seat: 0, name: '高单', deviceId: 'd0', hand: mk([{ r: 14, s: 's' }, { r: 5, s: 'h' }, { r: 3, s: 'd' }]), seen: false, folded: false, chips: 900, paid: 100 },
    { seat: 1, name: '低单', deviceId: 'd1', hand: mk([{ r: 13, s: 's' }, { r: 12, s: 'h' }, { r: 3, s: 'd' }]), seen: false, folded: false, chips: 900, paid: 100 },
  ], done: false, winners: null, showdown: false, log: [] };
  ad._showdown(st4);
  eq(st4.winners, [0], '单张比最大牌');

  /* 3. 动作校验（注意 look/call 均移交行动权，2 人桌轮转） */
  const st5 = ad.init(seats, {});
  let r = ad.act(st5, 1, { action: 'call' });
  ok(!r.ok, '未轮到操作被拒绝: ' + r.msg);
  r = ad.act(st5, 0, { action: 'unknown' });
  ok(!r.ok, '未知动作被拒绝');
  r = ad.act(st5, 0, { action: 'look' });
  ok(r.ok && st5.players[0].seen === true, '看牌置 seen');
  r = ad.act(st5, 0, { action: 'look' });
  ok(!r.ok, '非本回合操作被拒绝');
  r = ad.act(st5, 1, { action: 'call' });
  ok(r.ok && st5.players[1].chips === 900 && st5.pot === 150, '闷牌跟注 50，底池 150');
  r = ad.act(st5, 0, { action: 'call' });
  ok(r.ok && st5.players[0].chips === 850, '看牌跟注费用 ×2（100）');
  ok(st5.pot === 250, '跟注入池');
  /* 加注链：50→100→150→200（封顶 base*4），看牌者费用 ×2 */
  r = ad.act(st5, 1, { action: 'raise' });
  ok(r.ok && st5.unit === 100, '加注后单注 100');
  r = ad.act(st5, 0, { action: 'raise' });
  ok(r.ok && st5.unit === 150 && st5.players[0].chips === 550, '看牌再加注付 300，单注 150');
  r = ad.act(st5, 1, { action: 'raise' });
  ok(r.ok && st5.unit === 200, '加注到 200');
  r = ad.act(st5, 0, { action: 'raise' });
  ok(!r.ok, '达到上限（base*4=200）后加注被拒绝: ' + r.msg);

  /* 第 3 轮前不得比牌（新局，1 轮内） */
  const stC = ad.init(seats, {});
  ad.act(stC, 0, { action: 'call' });
  r = ad.act(stC, 1, { action: 'compare', target: 0 });
  ok(!r.ok, '第 3 轮前比牌被拒绝: ' + r.msg);

  /* 弃牌终结（新局） */
  const stF = ad.init(seats, {});
  r = ad.act(stF, 0, { action: 'fold' });
  ok(r.ok && stF.done === true && stF.winners.length === 1 && stF.winners[0] === 1, '弃牌后仅剩一人直接终结');

  /* 比牌流程（手动造 round=3 状态） */
  const st6 = ad.init(seats, {});
  st6.round = 3;
  r = ad.act(st6, 0, { action: 'compare', target: 9 });
  ok(!r.ok, '比牌目标无效被拒绝');
  /* 强造手牌：座位0 豹子、座位1 单张 → 座位1 落败 */
  st6.players[0].hand = [{ r: 8, s: 's' }, { r: 8, s: 'h' }, { r: 8, s: 'd' }];
  st6.players[1].hand = [{ r: 14, s: 's' }, { r: 5, s: 'h' }, { r: 3, s: 'd' }];
  const potBefore = st6.pot;
  r = ad.act(st6, 0, { action: 'compare', target: 1 });
  ok(r.ok, '第 3 轮比牌成功');
  ok(st6.players[1].folded === true && st6.players[0].folded === false, '牌小者被比死');
  ok(st6.done === true && st6.winners[0] === 0, '比牌后仅剩一人，座位 0 胜');
  ok(st6.pot === potBefore + 50, '比牌费用入池');

  /* autoAct：够钱跟注、不够弃牌 */
  const st7 = ad.init(seats, {});
  eq(ad.autoAct(st7, 0), { action: 'call' }, '有筹码时托管跟注');
  st7.players[0].chips = 10;
  eq(ad.autoAct(st7, 0), { action: 'fold' }, '筹码不足时托管弃牌');

  /* publicView：本人真牌、他人 ??、摊牌亮牌 */
  const st8 = ad.init(seats, {});
  const v0 = ad.publicView(st8, 0);
  ok(v0.players.find(p => p.seat === 0).hand.every(x => x !== '??'), '自己看得到真牌');
  ok(v0.players.find(p => p.seat === 1).hand.join(',') === '??,??,??', '他人为 ??');
  ok(v0.cost === 50, '闷牌费用 50');
  st8.players[0].seen = true;
  const v0b = ad.publicView(st8, 0);
  ok(v0b.cost === 100, '看牌后费用 100');
  const v1 = ad.publicView(st8, 1);
  ok(v1.cost === 50, '对手视角费用不受我看牌影响');

  /* settlement */
  const st9 = ad.init(seats, {});
  st9.players[0].folded = true;
  st9.done = true; st9.winners = [1];
  const sm = ad.settlement(st9);
  ok(sm.game === 'gold' && sm.winners.join(',') === '1', 'settlement 游戏与胜者');
  ok(sm.payouts[1] === 100 && sm.payouts[0] === 0, '胜者拿走底池');
  ok(sm.hands['1'] && sm.hands['1'].length === 3 && !sm.hands['0'], '结算只亮未弃牌手牌');
}

function testDiceDuelAdapter() {
  const ad = ADAPTERS.diceduel;
  ok(!!ad, 'diceduel adapter 存在');
  ok(ad.minPlayers === 2 && ad.maxPlayers === 6, 'diceduel 2~6 人');

  const seats = [{ seat: 0, name: '甲', deviceId: 'd0' }, { seat: 1, name: '乙', deviceId: 'd1' }, { seat: 2, name: '丙', deviceId: 'd2' }];
  const st = ad.init(seats, {});
  ok(st.pot === 150 && st.turn === 0 && st.players.every(p => p.dice === null), '底池 150，座位 0 先掷');

  let r = ad.act(st, 1, { action: 'roll' });
  ok(!r.ok, '未轮到掷骰被拒绝');
  r = ad.act(st, 0, { action: 'fly' });
  ok(!r.ok, '未知动作被拒绝');
  r = ad.act(st, 0, { action: 'roll' });
  ok(r.ok, '座位 0 掷骰成功');
  const d0 = st.players[0].dice;
  ok(Array.isArray(d0) && d0.length === 3 && d0.every(x => x >= 1 && x <= 6), '骰值为 1~6');
  ok(st.players[0].sum === d0[0] + d0[1] + d0[2], '点数和正确');
  ok(st.turn === 1, '轮转至座位 1');
  r = ad.act(st, 0, { action: 'roll' });
  ok(!r.ok, '重复掷骰被拒绝');

  /* 依序掷完 → 结算 */
  ad.act(st, 1, { action: 'roll' });
  ad.act(st, 2, { action: 'roll' });
  ok(st.done === true && st.turn === -1, '全员掷完即终结');
  const keys = st.players.map(p => p.dice.join(',') + ':' + (p.triple ? 1000 : 0) + p.sum);
  ok(st.winners.length >= 1, '有胜者: ' + keys.join(' | '));
  const bestKey = Math.max(...st.players.map(p => (p.triple ? 1000 : 0) + p.sum));
  eq(st.winners, st.players.filter(p => (p.triple ? 1000 : 0) + p.sum === bestKey).map(p => p.seat), '胜者为最高 key（豹子+1000 优先）');

  const sm = ad.settlement(st);
  ok(sm.game === 'diceduel', 'settlement 游戏正确');
  const payoutSum = Object.values(sm.payouts).reduce((a, b) => a + b, 0);
  ok(payoutSum <= st.pot && payoutSum > 0, '派彩不超过底池且大于 0');
  ok(Object.keys(sm.dice).length === 3 && sm.dice[0].length === 3, '结算含各座位骰值');

  eq(ad.autoAct(st, 0), { action: 'roll' }, 'diceduel 托管=掷骰');
}

/* ---------------- B. 端到端 ---------------- */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokerclub-gdtest-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '18124';
process.env.HOST = '127.0.0.1';

const { server, rooms } = require('../src/index');

const BASE = 'http://127.0.0.1:18124';
const WS_BASE = 'ws://127.0.0.1:18124/ws';

function api(method, pathname, deviceId, body) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + pathname, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(deviceId ? { 'X-Device-Id': deviceId } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); } catch { resolve({ status: res.statusCode, body: buf }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

class TestClient {
  constructor(deviceId, nickname) {
    this.deviceId = deviceId; this.nickname = nickname;
    this.msgs = []; this.waiters = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_BASE + '?deviceId=' + encodeURIComponent(this.deviceId) + '&nickname=' + encodeURIComponent(this.nickname));
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (process.env.GD_DBG) console.log('  [' + this.nickname + '] <- ' + m.type + (m.type === 'state' ? ' done=' + m.state.done + ' pot=' + m.state.pot : ''));
        this.msgs.push(m);
        const w = this.waiters.filter(x => x.type === m.type);
        w.forEach(x => { clearTimeout(x.timer); x.resolve(m); });
        this.waiters = this.waiters.filter(x => x.type !== m.type);
      });
    });
  }
  send(type, data) { this.ws.send(JSON.stringify({ type, ...data })); }
  wait(type, ms = 3000) {
    const found = this.msgs.find(m => m.type === type);
    if (found) { this.msgs = this.msgs.filter(m => m !== found); return Promise.resolve(found); }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      this.waiters.push({ type, resolve, timer });
    });
  }
  clear() { this.msgs = []; }
  close() { try { this.ws.close(); } catch {} }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function e2e() {
  await new Promise(r => server.listen(18124, '127.0.0.1', r));

  /* 服务信息：4 个联机玩法 */
  {
    const r = await api('GET', '/api/info');
    ok(r.status === 200 && r.body.games.length === 4, '/api/info 返回 4 个联机玩法');
    const ids = r.body.games.map(g => g.id).sort();
    ok(ids.join(',') === 'diceduel,gold,guandan,holdem', '联机玩法含 gold 与 diceduel');
    const gold = r.body.games.find(g => g.id === 'gold');
    const dd = r.body.games.find(g => g.id === 'diceduel');
    ok(gold && gold.name === '炸金花' && gold.min === 2 && gold.max === 6, 'gold 名称与人数范围');
    ok(dd && dd.name === '骰子比大小' && dd.min === 2 && dd.max === 6, 'diceduel 名称与人数范围');
  }

  const devA = 'gdA_12345678', devB = 'gdB_12345678';
  await api('POST', '/api/player', devA, { nickname: '金花侠' });
  await api('POST', '/api/player', devB, { nickname: '骰王' });

  const A = new TestClient(devA, '金花侠');
  const B = new TestClient(devB, '骰王');
  await A.connect(); await B.connect();
  await A.wait('hello'); await B.wait('hello');

  /* 非联机玩法建房被拒绝 */
  {
    A.clear();
    A.send('create', { game: 'blackjack' });
    const err = await A.wait('error', 1500);
    ok(!!err && err.msg.indexOf('不支持') >= 0, '21点建房被拒绝: ' + (err && err.msg));
  }

  /* 炸金花全流程：开局 → 弃牌 → 结算 */
  {
    A.clear();
    A.send('create', { game: 'gold' });
    const room = await A.wait('room');
    ok(!!room && room.code && room.code.length === 6, '炸金花建房成功');
    const code = room.code;
    ok(room.room && room.room.game === 'gold' && room.room.waiting === true, '等待视图含 game=gold');

    B.clear(); B.send('join', { code });
    ok(!!(await B.wait('room')), 'B 加入炸金花房');
    A.clear(); B.clear();
    A.send('ready', { ready: true }); B.send('ready', { ready: true });
    await sleep(120);
    A.send('start', {});
    const stA = await A.wait('state');
    ok(!!stA && stA.state.game === 'gold', '开局收到 gold state');
    ok(stA.state.players.length === 2, '两个座位');
    const meA = stA.state.players.find(p => p.seat === stA.state.mySeat);
    ok(meA && meA.hand.length === 3 && meA.hand.every(x => x !== '??'), '自己 3 张真牌');
    ok(stA.state.pot === 100 && stA.state.round === 1 && stA.state.turn === 0, '底池 100，座位 0 先行');
    await sleep(200); /* 排空在途帧，避免 B 的开局 state 与后续 clear/wait 竞态 */

    /* 座位 0（A）弃牌 → 直接终结 */
    A.clear(); B.clear();
    A.send('act', { payload: { action: 'fold' } });
    const stB = await B.wait('state', 2000);
    ok(!!stB && stB.state.done === true, 'B 收到终局 state');
    const stA2 = await A.wait('state', 2000);
    ok(!!stA2 && stA2.state.done === true, 'A 收到终局 state');
    const settleA = await A.wait('settle', 2000);
    ok(!!settleA && settleA.result && settleA.result.game === 'gold', 'A 收到炸金花结算广播');
    if (settleA && settleA.result) {
      ok(settleA.result.winners.length === 1 && settleA.result.payouts[settleA.result.winners[0]] === 100, '胜者独得底池 100');
      ok(settleA.result.hands && Object.keys(settleA.result.hands).length === 1, '结算只含未弃牌手牌');
    }
    const roomObj = rooms.get(code);
    ok(!!roomObj.result, '服务端产出 gold 结算结果');
  }

  /* 骰子比大小全流程：轮流掷骰 → 结算 */
  {
    A.clear();
    A.send('create', { game: 'diceduel' });
    const room = await A.wait('room');
    ok(!!room && room.code, '骰子房创建成功');
    const code = room.code;
    B.clear(); B.send('join', { code });
    ok(!!(await B.wait('room')), 'B 加入骰子房');
    A.clear(); B.clear();
    A.send('ready', { ready: true }); B.send('ready', { ready: true });
    await sleep(120);
    A.send('start', {});
    const stA = await A.wait('state');
    ok(!!stA && stA.state.game === 'diceduel', '开局收到 diceduel state');
    ok(stA.state.pot === 100 && stA.state.turn === 0, '底池 100，座位 0 先掷');

    A.clear();
    A.send('act', { payload: { action: 'roll' } });
    const stA1 = await A.wait('state', 2000);
    ok(!!stA1 && stA1.state.players.find(p => p.seat === 0).dice, 'A 掷出骰子');
    ok(stA1.state.turn === 1, '轮到 B');
    await sleep(200); /* 排空在途帧 */

    A.clear(); B.clear();
    B.send('act', { payload: { action: 'roll' } });
    const stB = await B.wait('state', 2000);
    ok(!!stB && stB.state.done === true, '全员掷完收到终局 state');
    const settleB = await B.wait('settle', 2000);
    ok(!!settleB && settleB.result && settleB.result.game === 'diceduel', 'B 收到骰子结算广播');
    if (settleB && settleB.result) {
      ok(settleB.result.dice && settleB.result.dice[0] && settleB.result.dice[1], '结算含双方骰值');
      const w = settleB.result.winners;
      ok(w.length >= 1 && settleB.result.payouts[w[0]] > 0, '胜者获得派彩');
      const k = (s) => (settleB.result.dice[s][0] === settleB.result.dice[s][1] && settleB.result.dice[s][1] === settleB.result.dice[s][2] ? 1000 : 0)
        + settleB.result.dice[s][0] + settleB.result.dice[s][1] + settleB.result.dice[s][2];
      ok(w.every(s => k(s) === Math.max(k(0), k(1))), '胜者确为点数（豹子优先）最大者');
    }
  }

  A.close(); B.close();
}

(async () => {
  try {
    testGoldAdapter();
    testDiceDuelAdapter();
    await e2e();
  } catch (e) {
    fail++; failures.push('未捕获异常: ' + (e && e.stack || e));
  }
  console.log('通过 ' + pass + ' 项' + (fail ? ('，失败 ' + fail + ' 项') : ''));
  if (fail) {
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exitCode = 1;
  }
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
})();
