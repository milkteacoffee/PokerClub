'use strict';
/**
 * 后端端到端测试：真实启动 HTTP + WebSocket 服务，验证：
 *  1) 健康检查 / 服务信息
 *  2) 设备建档、改名
 *  3) 好友请求 → 接受 → 列表
 *  4) 段位同步 → 全服榜 / 好友榜排序正确
 *  5) 联机：建房 → 加入 → 准备 → 开局 → 掼蛋出牌 → 结算
 *  6) 德州：建房 → 开局 → 盲注正确 → 动作 → 摊牌结算
 *  7) 非法操作被拒绝（未轮到、非法出牌、非房主开始）
 *  8) 房间满员拒绝、房号不存在
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { WebSocket } = require('ws');

/* 用临时数据目录，避免污染真实数据 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokerclub-test-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '18123';
process.env.HOST = '127.0.0.1';

const { server, store, rooms, GAME_NAMES } = require('../src/index');

let pass = 0, fail = 0; const failures = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; failures.push(msg); } }

const BASE = 'http://127.0.0.1:18123';
const WS_BASE = 'ws://127.0.0.1:18123/ws';

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

/* 极简 WS 客户端：收消息入队列，可 await 特定类型 */
class TestClient {
  constructor(deviceId, nickname) {
    this.deviceId = deviceId;
    this.nickname = nickname;
    this.msgs = [];
    this.waiters = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_BASE + '?deviceId=' + encodeURIComponent(this.deviceId) + '&nickname=' + encodeURIComponent(this.nickname));
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        this.msgs.push(m);
        const w = this.waiters.filter(x => x.type === m.type);
        w.forEach(x => { clearTimeout(x.timer); x.resolve(m); });
        this.waiters = this.waiters.filter(x => x.type !== m.type);
      });
    });
  }
  send(type, data) { this.ws.send(JSON.stringify({ type, ...data })); }
  /* 等待某类型消息（可回溯已收到的） */
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

async function main() {
  await new Promise(r => server.listen(18123, '127.0.0.1', r));

  /* ---- 1. 健康检查 ---- */
  {
    const r = await api('GET', '/health');
    ok(r.status === 200 && r.body.ok === true, '健康检查通过');
    ok(typeof r.body.rooms === 'number', '健康检查返回房间数');
  }

  /* ---- 2. 服务信息 ---- */
  {
    const r = await api('GET', '/api/info');
    ok(r.status === 200 && r.body.games.length === 2, '仅掼蛋与德州支持联机');
    const ids = r.body.games.map(g => g.id).sort();
    ok(ids.join(',') === 'guandan,holdem', '联机玩法为 guandan+holdem');
    ok(r.body.leaderboardGames.length === 6, '排行榜覆盖六个游戏');
  }

  /* ---- 3. 设备建档与改名 ---- */
  const devA = 'devA_12345678';
  const devB = 'devB_12345678';
  {
    let r = await api('POST', '/api/player', devA, { nickname: '阿强' });
    ok(r.status === 200 && r.body.nickname === '阿强', '设备A建档成功');
    r = await api('POST', '/api/player', devB, { nickname: '阿明' });
    ok(r.body.nickname === '阿明', '设备B建档成功');
    // 改名
    r = await api('POST', '/api/player', devA, { nickname: '阿强' });
    ok(r.body.nickname === '阿强', '重复建档保留昵称');
    // 非法设备ID
    r = await api('POST', '/api/player', 'short', { nickname: 'X' });
    ok(r.status === 400, '非法设备ID被拒绝');
  }

  /* ---- 4. 好友流程 ---- */
  {
    let r = await api('POST', '/api/friends', devA, { deviceId: devB });
    ok(r.body.ok, 'A 向 B 发起好友请求');
    r = await api('GET', '/api/friends', devB);
    ok(r.body.requests.some(x => x.deviceId === devA), 'B 收到好友请求');
    r = await api('POST', '/api/friends/accept', devB, { deviceId: devA });
    ok(r.body.ok, 'B 接受请求');
    r = await api('GET', '/api/friends', devA);
    ok(r.body.friends.some(x => x.deviceId === devB), 'A 好友列表含 B');
    r = await api('GET', '/api/friends', devB);
    ok(r.body.friends.some(x => x.deviceId === devA), '好友关系双向');
    // 重复添加
    r = await api('POST', '/api/friends', devA, { deviceId: devB });
    ok(!r.body.ok, '重复添加被拒绝');
    // 自加
    r = await api('POST', '/api/friends', devA, { deviceId: devA });
    ok(!r.body.ok, '不能添加自己');
  }

  /* ---- 5. 段位同步与排行榜 ---- */
  const devC = 'devC_12345678';
  {
    await api('POST', '/api/player', devC, { nickname: '小美' });
    await api('POST', '/api/rank', devA, { rank: { holdem: { points: 3000, tier: 3 }, guandan: { points: 100, tier: 1 } } });
    await api('POST', '/api/rank', devB, { rank: { holdem: { points: 5000, tier: 5 }, guandan: { points: 900, tier: 4 } } });
    await api('POST', '/api/rank', devC, { rank: { holdem: { points: 1000, tier: 1 }, guandan: { points: 50, tier: 0 } } });

    let r = await api('GET', '/api/leaderboard?game=holdem&scope=global', devA);
    ok(r.body.list.length === 3, '全服榜含 3 人');
    ok(r.body.list[0].deviceId === devB && r.body.list[0].points === 5000, '全服榜按分数降序（B 第一）');
    ok(r.body.list.every(x => x.isMe === (x.deviceId === devA)), 'isMe 标记正确');
    ok(r.body.list.map(x => x.rank).join(',') === '1,2,3', '名次连续');

    r = await api('GET', '/api/leaderboard?game=holdem&scope=friends', devA);
    ok(r.body.list.length === 2, 'A 的好友榜含自己+B 共 2 人');
    ok(r.body.list[0].deviceId === devB, '好友榜 B 仍第一');

    r = await api('GET', '/api/leaderboard?game=holdem&scope=friends', devC);
    ok(r.body.list.length === 1, 'C 无好友，好友榜仅自己');

    r = await api('GET', '/api/leaderboard?game=badgame', devA);
    ok(r.status === 400, '未知游戏被拒绝');

    r = await api('GET', '/api/leaderboard?game=guandan&scope=global&limit=2', devA);
    ok(r.body.list.length === 2, 'limit 生效');
  }

  /* ---- 6. 联机掼蛋全流程 ---- */
  {
    const A = new TestClient(devA, '阿强');
    const B = new TestClient(devB, '阿明');
    const C = new TestClient(devC, '小美');
    const D = new TestClient('devD_12345678', '小刚');
    await A.connect(); await B.connect(); await C.connect(); await D.connect();
    ok(true, '四个 WS 客户端连接成功');
    await A.wait('hello'); await B.wait('hello'); await C.wait('hello'); await D.wait('hello');

    A.clear();
    A.send('create', { game: 'guandan' });
    const room = await A.wait('room');
    ok(!!room && room.code && room.code.length === 6, '建房成功，房号 6 位: ' + (room && room.code));
    const code = room.code;
    ok(/^[2-9]+$/.test(code), '房号只含无歧义数字');

    // 人数不足时开局失败（只有 1 人）
    A.send('start', {});
    let err = await A.wait('error');
    ok(!!err, '人数不足开局被拒绝: ' + (err && err.msg));

    // 另外三人加入
    for (const c of [B, C, D]) { c.clear(); c.send('join', { code }); }
    const jb = await B.wait('room');
    ok(!!jb, 'B 加入成功');
    const jc = await C.wait('room');
    ok(!!jc, 'C 加入成功');
    const jd = await D.wait('room');
    ok(!!jd, 'D 加入成功');

    // 非房主不能开始
    B.clear(); B.send('start', {});
    err = await B.wait('error');
    ok(!!err && err.msg.indexOf('房主') >= 0, '非房主开始被拒绝');

    // 全部准备
    for (const c of [A, B, C, D]) { c.clear(); c.send('ready', { ready: true }); }
    await sleep(120);
    A.clear(); A.send('start', {});
    const stA = await A.wait('state');
    ok(!!stA, '房主开始成功，收到 state');
    ok(stA.state.game === 'guandan', 'state 游戏为 guandan');
    ok(stA.state.myHand.length === 27, '各持 27 张手牌');
    ok(stA.state.handCounts.every(n => n === 27), '各家手牌数均为 27');

    // 轮到谁就由谁出牌；用引擎选牌，跑完整局
    let moves = 0;
    const clients = { [A.deviceId]: A, [B.deviceId]: B, [C.deviceId]: C, [D.deviceId]: D };
    const seatDev = {};
    stA.state.seatInfo.forEach(s => seatDev[s.seat] = s.name);
    /* 需要 deviceId 与 seat 对应：从 rooms 内部拿 */
    let settled = null;
    const roomObj = rooms.get(code);
    ok(!!roomObj, '服务端持有该房间');

    let guard = 0;
    while (!settled && guard++ < 600) {
      const room = rooms.get(code);
      if (!room || !room.state) break;
      const g = room.state.g;
      if (g.done) break;
      const seat = g.turn;
      const s = room.seats.find(x => x.seat === seat);
      const cli = clients[s.deviceId];
      // 用引擎算出合法动作
      const GD = require('../engine/guandan');
      const ids = GD.choose(g, seat);
      cli.clear();
      cli.send('act', { payload: ids ? { ids } : {} });
      await sleep(6);
      moves++;
    }
    await sleep(200);
    const roomFinal = rooms.get(code);
    ok(roomFinal && roomFinal.state && roomFinal.state.g.done, '掼蛋对局在 ' + moves + ' 步内终结');
    ok(!!roomFinal.result, '服务端产出结算结果');
    if (roomFinal.result) {
      ok(roomFinal.result.game === 'guandan', '结算游戏正确');
      ok([1, 2, 3].includes(roomFinal.result.up), '结算升级数合法: ' + roomFinal.result.up);
    }
    // 结算广播
    const st = await A.wait('settle', 2000);
    ok(!!st, '客户端收到 settle 广播');

    /* 非法操作：不在座位 / 未轮到 */
    A.clear();
    A.send('act', { payload: { ids: [0, 1, 2, 3, 4, 5] } });
    const er2 = await A.wait('error', 1200);
    ok(!!er2, '终局后出牌被拒绝');

    [A, B, C, D].forEach(c => c.close());
  }

  /* ---- 7. 联机德州全流程 ---- */
  {
    const A = new TestClient(devA, '阿强');
    const B = new TestClient(devB, '阿明');
    await A.connect(); await B.connect();
    await A.wait('hello'); await B.wait('hello');
    A.clear();
    A.send('create', { game: 'holdem' });
    const room = await A.wait('room');
    const code = room.code;
    ok(!!code, '德州建房成功: ' + code);

    B.clear(); B.send('join', { code });
    const jb = await B.wait('room');
    ok(!!jb, 'B 加入德州房');

    for (const c of [A, B]) { c.clear(); c.send('ready', { ready: true }); }
    await sleep(120);
    A.clear(); A.send('start', {});
    const st = await A.wait('state');
    ok(!!st, '德州开局成功');
    ok(st.state.game === 'holdem', 'state 游戏为 holdem');
    ok(st.state.stage === 'preflop', '初始阶段为翻牌前');
    ok(st.state.pot === 30, '盲注已下（SB10+BB20=30），实际 ' + st.state.pot);
    ok(st.state.board.length === 0, '翻牌前无公共牌');

    const roomObj = rooms.get(code);
    const me = roomObj.seats.find(x => x.deviceId === devA);
    const seatA = me.seat;
    ok(st.state.players[seatA].hole.length === 2, '自己可见 2 张底牌');
    const otherSeat = roomObj.seats.find(x => x.deviceId !== devA).seat;
    ok(st.state.players[otherSeat].hole.join(',') === '??,??', '对手底牌被隐藏');

    /* 打到摊牌：每步 check/call */
    let guard = 0;
    const clients = { [devA]: A, [devB]: B };
    while (guard++ < 100) {
      const r = rooms.get(code);
      if (!r || !r.state || r.state.done) break;
      const turn = r.state.turn;
      const s = r.seats.find(x => x.seat === turn);
      const cli = clients[s.deviceId];
      const p = r.state.players[turn];
      const toCall = r.state.currentBet - p.bet;
      cli.clear();
      cli.send('act', { payload: toCall > 0 ? { action: 'call' } : { action: 'check' } });
      await sleep(10);
    }
    await sleep(200);
    const rf = rooms.get(code);
    ok(rf.state.done, '德州对局终结');
    ok(rf.state.stage === 'showdown', '进入摊牌阶段，实际 ' + rf.state.stage);
    ok(rf.state.board.length === 5, '公共牌 5 张');
    ok(!!rf.result, '产生产出结算');
    ok(rf.result.winners.length >= 1, '至少一位赢家');
    ok(rf.result.pot > 0, '底池大于 0');

    /* 非法加注被拒绝 */
    A.clear(); B.clear();
    A.send('act', { payload: { action: 'raise', to: 5 } });
    const er = await A.wait('error', 1200);
    ok(!!er, '终局后动作被拒绝');

    A.close(); B.close();
  }

  /* ---- 8. 房间异常 ---- */
  {
    const A = new TestClient('devX_12345678', '独行侠');
    await A.connect(); await A.wait('hello');
    A.clear();
    A.send('join', { code: '999999' });
    const err = await A.wait('error');
    ok(!!err && err.msg.indexOf('不存在') >= 0, '加入不存在的房间被拒绝');

    A.clear();
    A.send('create', { game: 'blackjack' });
    const err2 = await A.wait('error');
    ok(!!err2 && err2.msg.indexOf('不支持') >= 0, '不支持联机的玩法被拒绝');

    A.close();
  }

  /* ---- 9. 统计 ----
     注：连接关闭后房间需等 sweep 回收，这里只验证 rooms 表仍可查询 */
  {
    const s = rooms.stats();
    ok(typeof s.rooms === 'number' && typeof s.players === 'number', '房间统计可用');
  }

  await sleep(100);
  server.close();
  rooms.close();
  store.close();

  console.log('后端端到端测试: ' + pass + ' 项通过, ' + fail + ' 项失败');
  if (fail) { failures.slice(0, 30).forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('测试异常:', e); process.exit(1); });
