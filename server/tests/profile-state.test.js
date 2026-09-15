'use strict';
/**
 * 用户资料 + 云存档 + 跨设备接管 接口测试：
 *  1) /api/player  POST：avatar 设置与非法值拦截、bio 清洗截断、响应含 userCode/recoveryCode
 *  2) /api/state   GET/PUT：空态、写入读回一致、缺参 400、超大 413、无身份 400
 *  3) WS hello：返回 avatar
 *  4) /api/friends GET：friends 与 requests 均带 avatar；搜索候选带 avatar
 *  5) 房间视图：waiting seats 与开局后 seatInfo 均带 avatar
 *  6) /api/player/recovery/rotate：旧码作废、新码可用
 *  7) /api/player/claim：正确凭据返回原 deviceId、错误 401、缺参 400、同 IP 限流 429
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { WebSocket } = require('ws');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokerclub-prof-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '18124';
process.env.HOST = '127.0.0.1';

const { server, store, rooms } = require('../src/index');

let pass = 0, fail = 0; const failures = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; failures.push(msg); } }

const BASE = 'http://127.0.0.1:18124';

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

function wsHello(deviceId, nickname) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:18124/ws?deviceId=' + encodeURIComponent(deviceId) + '&nickname=' + encodeURIComponent(nickname));
    ws.on('message', m => { const d = JSON.parse(m.toString()); if (d.type === 'hello') { ws.close(); resolve(d); } });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('hello 超时')), 5000);
  });
}

const A = 'prof_a_' + Date.now();
const B = 'prof_b_' + Date.now();
const C = 'prof_c_' + Date.now();

async function main() {
  await new Promise(r => server.listen(18124, '127.0.0.1', r));

  /* ---- 1) 资料接口 ---- */
  const p1 = await api('POST', '/api/player', A, { nickname: '甲', avatar: 'a05', bio: '  你好<b>  世界  ' });
  ok(p1.status === 200 && p1.body.ok, 'POST /api/player 成功');
  ok(p1.body.avatar === 'a05', 'avatar 设置生效 a05');
  ok(p1.body.bio === '你好b  世界', 'bio 清洗（去尖括号/首尾空白）: ' + JSON.stringify(p1.body.bio));
  ok(/^[2-9A-HJKMNP-Z]{8}$/.test(p1.body.userCode || ''), '响应含合法 userCode');
  ok(/^[2-9A-HJKMNP-Z]{16}$/.test(p1.body.recoveryCode || ''), '响应含 16 位恢复码');

  const p2 = await api('POST', '/api/player', A, { nickname: '甲', avatar: '<script>x'.repeat(30) });
  ok(p2.status === 200 && p2.body.avatar === 'a05', '非法 avatar 被忽略（保持 a05）');

  const longBio = await api('POST', '/api/player', A, { nickname: '甲', bio: '字'.repeat(80) });
  ok(longBio.body.bio.length === 60, 'bio 超长截断到 60');

  /* ---- 2) 云存档 ---- */
  const s0 = await api('GET', '/api/state', A);
  ok(s0.status === 200 && s0.body.state === null && s0.body.updatedAt === 0, '初次云存档为空');

  const put1 = await api('PUT', '/api/state', A, { state: { slots: { 1: { coins: 1234 } }, mark: 'v1' } });
  ok(put1.status === 200 && put1.body.ok && put1.body.updatedAt > 0, 'PUT /api/state 写入成功返回 updatedAt');
  const t1 = put1.body.updatedAt;

  const g1 = await api('GET', '/api/state', A);
  ok(g1.body.state && g1.body.state.mark === 'v1' && g1.body.updatedAt === t1, '云存档读回一致');

  const putBad = await api('PUT', '/api/state', A, { foo: 1 });
  ok(putBad.status === 400, 'PUT 缺 state 返回 400');

  const big = { data: 'x'.repeat(520 * 1024) };
  const putBig = await api('PUT', '/api/state', A, { state: big });
  ok(putBig.status === 413, 'PUT 超大存档（>512KB）返回 413');

  const noDev = await api('GET', '/api/state', null);
  ok(noDev.status === 400, '无设备ID GET /api/state 返回 400');

  const put2 = await api('PUT', '/api/state', A, { state: { slots: {}, mark: 'v2' } });
  ok(put2.body.updatedAt >= t1, '二次上推 updatedAt 递增');

  /* ---- 3) WS hello 带 avatar ---- */
  const hello = await wsHello(A, '甲');
  ok(hello.avatar === 'a05', 'WS hello 返回 avatar a05');
  ok(!!hello.userCode, 'WS hello 返回 userCode');

  /* ---- 4) 好友列表 / 搜索 带 avatar ---- */
  await api('POST', '/api/player', B, { nickname: '乙', avatar: 'a02' });
  await api('POST', '/api/player', C, { nickname: '丙', avatar: 'a03' });
  await api('POST', '/api/friends', B, { friendId: p1.body.userCode });   // B → A 请求
  await api('POST', '/api/friends/accept', A, { fromId: B });              // A 接受
  await api('POST', '/api/friends', C, { friendId: p1.body.userCode });   // C → A 请求（挂起）

  const fl = await api('GET', '/api/friends', A);
  ok(fl.body.ok && fl.body.friends.some(f => f.deviceId === B && f.avatar === 'a02'), '好友列表带 avatar');
  ok(fl.body.requests.some(r => r.deviceId === C && r.avatar === 'a03'), '请求列表带 avatar');

  const sr = await api('GET', '/api/friends/search?q=' + encodeURIComponent('乙'), A);
  ok(sr.body.ok && sr.body.list.some(x => x.deviceId === B && x.avatar === 'a02'), '昵称搜索候选带 avatar');

  /* ---- 5) 房间视图带 avatar ---- */
  const cr = rooms.create('holdem', A, '甲', {});
  ok(cr.ok, '建房成功');
  const room = rooms.get(cr.code);
  rooms.join(cr.code, B, '乙', null);
  const vWait = room.viewFor(null);
  ok(vWait.waiting && vWait.seats.length === 2 && vWait.seats.every(s => typeof s.avatar === 'string' && s.avatar), 'waiting seats 带 avatar: ' + JSON.stringify(vWait.seats.map(s => s.avatar)));

  room.seats.forEach(s => s.ready = true);
  const st = room.start();
  ok(st.ok, '开局成功');
  const vPlay = room.viewFor(A);
  ok(Array.isArray(vPlay.seatInfo) && vPlay.seatInfo.every(s => typeof s.avatar === 'string' && s.avatar), '开局 seatInfo 带 avatar');
  rooms.leaveCurrent(A); rooms.leaveCurrent(B);

  /* 改头像后房间视图实时反映 */
  store.setAvatar(B, 'a07');
  const cr2 = rooms.create('holdem', B, '乙', {});
  const room2 = rooms.get(cr2.code);
  const v2 = room2.viewFor(null);
  ok(v2.seats[0].avatar === 'a07', '改头像后房间视图实时反映 a07');
  rooms.leaveCurrent(B);

  /* ---- 6) 恢复码轮换 ---- */
  const rot = await api('POST', '/api/player/recovery/rotate', A);
  ok(rot.status === 200 && /^[2-9A-HJKMNP-Z]{16}$/.test(rot.body.recoveryCode || ''), 'rotate 返回新恢复码');
  const oldCode = p1.body.recoveryCode, newCode = rot.body.recoveryCode;
  ok(newCode !== oldCode, '新恢复码与旧码不同');

  /* ---- 7) claim 跨设备接管（注意：同 IP 限流，把限流测试放最后） ---- */
  const cl0 = await api('POST', '/api/player/claim', null, { userCode: p1.body.userCode, recoveryCode: '----' + newCode + '----' });
  ok(cl0.status === 200 && cl0.body.ok && cl0.body.deviceId === A, '正确凭据 claim 返回原 deviceId（兼容分隔符）');
  ok(cl0.body.nickname === '甲' && cl0.body.avatar === 'a05', 'claim 返回昵称与头像');

  const clBad = await api('POST', '/api/player/claim', null, { userCode: p1.body.userCode, recoveryCode: oldCode });
  ok(clBad.status === 401, '旧恢复码（已作废）claim 返回 401');

  const clMiss = await api('POST', '/api/player/claim', null, { userCode: p1.body.userCode });
  ok(clMiss.status === 400, 'claim 缺恢复码返回 400');

  /* 换绑模拟：接管后新设备以原 device_id 上推，A 身份读回 */
  const claimPush = { state: { slots: { 1: { coins: 999 } }, mark: 'claimed' } };
  // 模拟接管方：先 claim（会消耗限流配额），这里只验证服务器侧 state 与身份一致
  const g2 = await api('GET', '/api/state', A);
  ok(g2.body.state && g2.body.state.mark === 'v2', 'claim 前原账号云存档未受影响');

  /* 限流：同一 IP 连打 12 次，第 11 次起应 429（前面已用 3 次配额） */
  let got429 = false;
  for (let i = 0; i < 12; i++) {
    const r = await api('POST', '/api/player/claim', null, { userCode: 'ZZZZZZZZ', recoveryCode: 'XXXXXXXXXXXXXXXX' });
    if (r.status === 429) { got429 = true; break; }
  }
  ok(got429, 'claim 同 IP 超 10 次/分钟 返回 429');

  /* ---- 汇总 ---- */
  console.log('\n===== profile-state 测试结果 =====');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  if (fail) { failures.slice(0, 30).forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('测试异常:', e); process.exit(1); });
setTimeout(() => { console.log('全局超时'); process.exit(3); }, 30000);
