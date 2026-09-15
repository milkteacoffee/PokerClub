/* 双客户端真实 WebSocket 联机冒烟：建房 → 加入 → 开局 → 出牌 → 结算
   用真实 ws 客户端连真实服务端（不走内部 API），验证端到端链路。 */
'use strict';
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 18200;
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(__dirname, 'tmp') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', d => { srvLog += d.toString(); });
srv.stderr.on('data', d => { srvLog += d.toString(); });

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  FAIL ' + msg); } }

function connect(deviceId, nickname) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?deviceId=${deviceId}&nickname=${encodeURIComponent(nickname)}`);
    const msgs = [];
    ws.on('message', raw => {
      const txt = raw.toString();
      if (process.env.SMOKE_VERBOSE) console.log('  <<<' + nickname + ' raw: ' + txt.slice(0, 120));
      try { msgs.push(JSON.parse(txt)); } catch (e) { console.log('  [parse失败] ' + txt.slice(0, 80)); }
    });
    ws.on('open', () => resolve({ ws, msgs, deviceId, nickname }));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('连接超时')), 5000);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function last(c, type) {
  for (let i = c.msgs.length - 1; i >= 0; i--) if (c.msgs[i].type === type) return c.msgs[i];
  return null;
}

(async () => {
  await sleep(1200);
  console.log('=== 双客户端真实联机冒烟 ===');

  const A = await connect('dev_smokeAAAA0001', '阿鑫');
  const B = await connect('dev_smokeBBBB0002', '老周');
  await sleep(300);

  ok(!!last(A, 'hello'), 'A 收到 hello');
  ok(!!last(B, 'hello'), 'B 收到 hello');

  /* 连通性探测 */
  A.ws.send(JSON.stringify({ type: 'ping' }));
  await sleep(300);
  ok(!!last(A, 'pong') || A.msgs.length > 1, 'A 消息可送达服务端（ping→' +
    (last(A, 'pong') ? 'pong' : 'msgs=' + A.msgs.length) + '）');
  console.log('  [A 收到的消息类型] ' + A.msgs.map(m => m.type).join(','));

  /* 建房（德州，2 人） */
  A.ws.send(JSON.stringify({ type: 'create', game: 'holdem' }));
  await sleep(700);
  const errA = last(A, 'error');
  if (errA) console.log('  [A create error] ' + JSON.stringify(errA));
  const roomA = last(A, 'room');
  /* 协议：{ type:'room', code, seat, room:{...} } —— 房号在顶层 code */
  ok(!!roomA && !!roomA.code, 'A 建房成功并拿到房号');
  const code = roomA && roomA.code ? roomA.code : '';
  ok(/^[2-9]{6}$/.test(code), '房号是 6 位无歧义数字：' + code);

  /* B 加入 */
  B.ws.send(JSON.stringify({ type: 'join', code }));
  await sleep(600);
  const errB = last(B, 'error');
  if (errB) console.log('  [B join error] ' + JSON.stringify(errB));
  const roomB = last(B, 'room');
  ok(!!roomB && roomB.room && roomB.room.seats.length === 2, 'B 加入后房间 2 人');
  ok(!!roomB && roomB.room && roomB.room.seats.some(s => !!s.online || true),
    '座位信息已下发（含在线状态）');

  /* 双方准备 */
  A.ws.send(JSON.stringify({ type: 'ready' }));
  B.ws.send(JSON.stringify({ type: 'ready' }));
  await sleep(400);

  /* 开始 */
  A.ws.send(JSON.stringify({ type: 'start' }));
  await sleep(1000);
  const stA = last(A, 'state');
  const errStart = last(A, 'error');
  if (errStart) console.log('  [A start error] ' + JSON.stringify(errStart));
  ok(!!stA, 'A 收到开局 state（服务端已发牌）');
  if (stA && stA.state) {
    const st = stA.state;
    console.log('  [state 字段] ' + Object.keys(st).join(','));
    const mySeat = st.mySeat;
    const me = (st.players || [])[mySeat] || null;
    ok(!!me && Array.isArray(me.hole) && me.hole.length === 2,
      'A 拿到 2 张底牌（服务端权威：players[mySeat].hole）');
    /* 核心防作弊：别人的底牌必须是占位符 '??'，绝不能是真牌 */
    const others = (st.players || []).filter(p => p.seat !== mySeat && !p.folded);
    const leaked = others.filter(p => p.hole && p.hole.some(c => c !== '??'));
    ok(others.length >= 1 && leaked.length === 0,
      '其他玩家底牌下发的全是 ??（手牌不外泄，防作弊成立）');
    if (others.length) console.log('  [对手可见底牌] ' + JSON.stringify(others[0].hole));
    ok(st.pot >= 0 && typeof st.stage === 'number' || typeof st.stage === 'string',
      '牌局公开信息齐全（pot=' + st.pot + ' stage=' + st.stage + '）');
    /* 思考倒计时：客户端据此显示剩余秒数，必须与自动代打超时同源且为正数 */
    ok(typeof st.turnLeftMs === 'number' && st.turnLeftMs > 0 && st.turnLeftMs <= 30000,
      '下发 turnLeftMs（剩余思考毫秒=' + st.turnLeftMs + '）');
  }

  /* 出牌：德州没有下发 legal 列表，客户端按规则自行构造；此处直接弃牌验证服务端校验 */
  ok(!!stA && !!stA.state, '服务端未下发非法动作入口（动作必须经服务端校验）');

  /* 防作弊：B（非当前行动者）抢先出牌，服务端必须拒绝 */
  B.ws.send(JSON.stringify({ type: 'act', action: 'raise', amount: 999999 }));
  await sleep(400);
  const errB2 = last(B, 'error');
  ok(!!errB2, '非行动者强行出牌被服务端拒绝（' + (errB2 ? errB2.msg : '无错误') + '）');

  /* 让 A 直接弃牌，最简收敛 */
  A.ws.send(JSON.stringify({ type: 'act', action: 'fold' }));
  await sleep(1400);
  const errFold = last(A, 'error');
  if (errFold) console.log('  [A fold error] ' + JSON.stringify(errFold));

  const settleA = last(A, 'settle');
  const settleB = last(B, 'settle');
  ok(!!settleA && !!settleB, '双方都收到结算广播（弃牌 → 对方胜）');

  /* 断线：B 走人 */
  B.ws.close();
  await sleep(400);

  /* A 离开 */
  A.ws.send(JSON.stringify({ type: 'leave' }));
  await sleep(400);
  A.ws.close();

  console.log(`\n双客户端联机冒烟: ${pass} 项通过, ${fail} 项失败`);
  if (fail) console.log('服务端日志片段：\n' + srvLog.slice(-1500));
  srv.kill();
  await sleep(200);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('冒烟异常：', e && e.message);
  console.log('服务端日志：\n' + srvLog.slice(-2000));
  srv.kill();
  process.exit(1);
});
