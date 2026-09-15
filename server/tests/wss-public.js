// 公网 wss 联机验证（修正版）：严格单次触发，验证服务端权威与底牌掩码
const WebSocket = require('ws');
const wsUrl = 'wss://modelghost.cn/_poker/ws';

const A = 'devtest_a_' + Date.now();
const B = 'devtest_b_' + Date.now();

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log((cond ? '[PASS] ' : '[FAIL] ') + name + (extra !== undefined ? '  ' + extra : ''));
}

const wsA = new WebSocket(wsUrl + '?deviceId=' + A + '&nickname=' + encodeURIComponent('测试甲'));
const wsB = new WebSocket(wsUrl + '?deviceId=' + B + '&nickname=' + encodeURIComponent('测试乙'));

let roomCode = null;
let mySeatA = null, mySeatB = null;
let stA = null, stB = null;
let advanced = false;
const once = { create: false, join: false, ready: false, start: false, act: false, viewA: false, viewB: false };
const send = (ws, o) => ws.send(JSON.stringify(o));

wsA.on('error', (e) => console.log('[A] ERR ' + e.message));
wsB.on('error', (e) => console.log('[B] ERR ' + e.message));

wsA.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'error') { console.log('[A] 服务端错误: ' + m.msg); return; }

  if (m.type === 'hello' && !once.create) {
    once.create = true;
    check('A 的 wss 握手通过（收到 hello）', true);
    send(wsA, { type: 'create', game: 'holdem' });
  }
  if (m.type === 'room' && m.code && !roomCode) {
    roomCode = m.code;
    if (m.seat !== undefined) mySeatA = m.seat;
    check('A 建房成功（房号为数字）', /^[0-9]{4,6}$/.test(m.code), '房号 ' + m.code + ' 座位 ' + m.seat);
  }
  if (m.type === 'room' && m.seat !== undefined) mySeatA = m.seat;
  // 两人到齐 → 各准备一次 → 房主开局一次
  if (m.type === 'room' && m.room && m.room.seats && m.room.seats.length === 2 && !once.ready) {
    once.ready = true;
    check('房间内 2 个座位就位', true, m.room.seats.map(s => s.name).join(' / '));
    send(wsA, { type: 'ready', ready: true });
    send(wsB, { type: 'ready', ready: true });
    setTimeout(() => { if (!once.start) { once.start = true; send(wsA, { type: 'start' }); } }, 500);
  }

  if (m.type === 'state') {
    stA = m;
    if (!once.viewA) {
      once.viewA = true;
      const mySeat = mySeatA;
      const me = m.state.players.find(p => p.seat === mySeat);
      check('A 收到服务端权威对局状态', true, 'stage=' + m.state.stage + ' 我的座位=' + mySeat);
      check('A 能看到自己底牌（2 张）', !!(me && me.hole && me.hole.length === 2), JSON.stringify(me && me.hole));
      const others = m.state.players.filter(p => p.seat !== mySeat && p && p.hole);
      const masked = others.length > 0 && others.every(p => p.hole[0] === '??' && p.hole[1] === '??');
      check('A 看不到对手底牌（全部 ?? 掩码）', masked, JSON.stringify(others.map(p => p.hole)));
      setTimeout(() => { if (!once.act) { once.act = true; send(wsA, { type: 'act', payload: { action: 'call' } }); } }, 400);
    } else if (!advanced) {
      advanced = true;
      check('A 行动后对局状态推进', true, 'stage=' + m.state.stage + ' 公共牌=' + (m.state.board || []).length + ' 张');
    }
  }
});

wsB.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'error') { console.log('[B] 服务端错误: ' + m.msg); return; }
  if (m.type === 'room' && m.code && !once.join) {
    once.join = true;
    if (m.seat !== undefined) mySeatB = m.seat;
    check('B 加入房间成功', m.code === roomCode, '房号 ' + m.code + ' 座位 ' + m.seat);
  }
  if (m.type === 'room' && m.seat !== undefined) mySeatB = m.seat;
  if (m.type === 'state') {
    stB = m;
    if (!once.viewB) {
      once.viewB = true;
      const me = m.state.players.find(p => p.seat === mySeatB);
      const others = m.state.players.filter(p => p.seat !== mySeatB && p && p.hole);
      const masked = others.length > 0 && others.every(p => p.hole[0] === '??' && p.hole[1] === '??');
      check('B 收到服务端权威对局状态', true, 'stage=' + m.state.stage + ' 我的座位=' + mySeatB);
      check('B 能看到自己底牌（2 张）', !!(me && me.hole && me.hole.length === 2), JSON.stringify(me && me.hole));
      check('B 看不到对手底牌（全部 ?? 掩码）', masked, JSON.stringify(others.map(p => p.hole)));
    }
  }
});

// 兜底：若 B 没收到 room 广播，1.2s 后用已知房号主动加入
setTimeout(() => {
  if (roomCode && !once.join) { once.join = true; send(wsB, { type: 'join', code: roomCode }); }
}, 1200);

setTimeout(() => {
  check("A/B 座位号已获取", mySeatA !== null && mySeatB !== null, "A=" + mySeatA + " B=" + mySeatB);
  const failed = results.filter((r) => !r.ok);
  console.log('\n===== 公网 wss 联机（modelghost.cn/_poker/ws）=====');
  console.log('通过 ' + (results.length - failed.length) + ' / ' + results.length);
  if (failed.length) { console.log('失败:'); failed.forEach(f => console.log('  - ' + f.name)); process.exit(1); }
  console.log('全部通过 ✓');
  process.exit(0);
}, 7000);
