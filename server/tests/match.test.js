/* 快速匹配端到端：两个真实 WS 客户端入队 → 服务端凑满即建房并直接开局（无需准备）
   同时验证：匹配中状态广播、匹配房自动进入对局、称号随档案同步到座位。 */
'use strict';
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 18210;
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(__dirname, 'tmp-match') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', d => { srvLog += d.toString(); });
srv.stderr.on('data', d => { srvLog += d.toString(); });

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('  FAIL ' + msg); } }

function connect(deviceId, nickname) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?deviceId=${deviceId}&nickname=${encodeURIComponent(nickname)}`);
    const msgs = [];
    ws.on('message', raw => { try { msgs.push(JSON.parse(raw.toString())); } catch (e) {} });
    ws.on('open', () => resolve({ ws, msgs, deviceId, nickname }));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('连接超时')), 5000);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function last(c, type) { for (let i = c.msgs.length - 1; i >= 0; i--) if (c.msgs[i].type === type) return c.msgs[i]; return null; }
function count(c, type) { return c.msgs.filter(m => m.type === type).length; }
const http = require('http');
function post(pathname, deviceId, body) {
  return new Promise(resolve => {
    const data = JSON.stringify(body || {});
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId, 'Content-Length': Buffer.byteLength(data) } },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({}); } }); });
    req.on('error', () => resolve({}));
    req.write(data); req.end();
  });
}

(async () => {
  await sleep(1200);
  console.log('=== 快速匹配端到端 ===');

  const A = await connect('dev_matchAAAA00001', '阿鑫');
  const B = await connect('dev_matchBBBB00002', '老周');
  await sleep(300);
  ok(!!last(A, 'hello') && !!last(B, 'hello'), '两端连接成功');

  /* 称号随档案同步：A 佩戴「德州王牌」 */
  const pr = await post('/api/player', 'dev_matchAAAA00001', { nickname: '阿鑫', avatar: 'a05', title: 'tt_top_holdem' });
  ok(pr.ok && pr.title === 'tt_top_holdem', '称号写入档案并可回读（title=' + pr.title + '）');
  const bad = await post('/api/player', 'dev_matchAAAA00001', { title: 'bad title!!' });
  ok(bad.ok && bad.title === 'tt_top_holdem', '非法称号被忽略（保持原值）');
  const clear = await post('/api/player', 'dev_matchAAAA00001', { title: '' });
  ok(clear.ok && clear.title === '', '称号可清除');
  await post('/api/player', 'dev_matchAAAA00001', { title: 'tt_top_holdem' });

  /* A 单独入队：应收到 matching，且不会开局 */
  A.ws.send(JSON.stringify({ type: 'match', game: 'holdem' }));
  await sleep(500);
  const m1 = last(A, 'matching');
  ok(!!m1, 'A 入队收到 matching 状态');
  ok(m1 && m1.waiting === 1 && m1.need === 2, '等待人数 1 / 需要 2（实际 ' + (m1 && m1.waiting + '/' + m1.need) + '）');
  ok(!last(A, 'state'), '人数不足时不会开局');

  /* B 入队 → 凑满 2 人 → 自动建房并开局 */
  B.ws.send(JSON.stringify({ type: 'match', game: 'holdem' }));
  await sleep(900);
  ok(!!last(A, 'room') && !!last(B, 'room'), '双方都收到 room（匹配成功建房）');
  const ra = last(A, 'room'), rb = last(B, 'room');
  ok(ra && ra.code && ra.code === rb.code, '同一房间号：' + (ra && ra.code));
  ok(ra && ra.matched === true, 'room 带 matched 标记');
  ok(!!last(A, 'state') && !!last(B, 'state'), '匹配房直接开局（收到 state，无需准备）');
  const st = last(A, 'state').state;
  console.log('  [state 字段] ' + Object.keys(st).join(',') + ' | seatInfo=' + (st.seatInfo ? st.seatInfo.length : 'none') + ' | players=' + (st.players ? st.players.length : 'none'));
  ok(st && st.game === 'holdem', '对局玩法为德州');
  ok(st && st.players && st.players.length === 2, '座位 2 人');
  ok(typeof st.turnLeftMs === 'number', '对局带思考倒计时字段');
  const seatA = (st.seatInfo || []).find(s => s.deviceId === 'dev_matchAAAA00001');
  ok(!!seatA && seatA.title === 'tt_top_holdem', '座位下发佩戴称号（title=' + (seatA && seatA.title) + '）');
  const seatB = (st.seatInfo || []).find(s => s.deviceId === 'dev_matchBBBB00002');
  ok(!!seatB && seatB.title === '', '未佩戴称号的玩家 title 为空串');

  /* 对局可继续操作（服务端认可匹配房的玩家） */
  const me = st.players.find(p => p.seat === st.turn) || st.players[0];
  const mySeat = (st.seatInfo || []).findIndex(s => s.deviceId === (me.seat === 0 ? 'dev_matchAAAA00001' : 'dev_matchBBBB00002'));
  ok(mySeat >= 0, '能定位当前行动玩家');

  /* 取消匹配：C 入队后取消，队列清空 */
  const C = await connect('dev_matchCCCC00003', '小陈');
  await sleep(200);
  C.ws.send(JSON.stringify({ type: 'match', game: 'gold' }));
  await sleep(400);
  ok(!!last(C, 'matching') && last(C, 'matching').waiting === 1, 'C 入队（炸金花）');
  C.ws.send(JSON.stringify({ type: 'matchCancel' }));
  await sleep(400);
  ok(!!last(C, 'left'), '取消匹配收到 left');
  ok(count(C, 'state') === 0, '取消后未进入对局');
  C.ws.close();

  /* 重复入队不叠加 */
  const D = await connect('dev_matchDDDD00004', '小赵');
  await sleep(200);
  D.ws.send(JSON.stringify({ type: 'match', game: 'diceduel' }));
  await sleep(200);
  D.ws.send(JSON.stringify({ type: 'match', game: 'diceduel' }));
  await sleep(400);
  const md = last(D, 'matching');
  ok(md && md.waiting === 1, '重复入队不叠加（waiting=' + (md && md.waiting) + '）');
  D.ws.close();

  A.ws.close(); B.ws.close();
  await sleep(200);

  console.log('快速匹配测试: ' + pass + ' 项通过, ' + fail + ' 项失败');
  srv.kill();
  if (fail) { console.log('--- 服务端日志 ---\n' + srvLog.slice(-1200)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.log('测试异常: ' + e.message); console.log('--- 服务端日志 ---\n' + srvLog.slice(-1500)); srv.kill(); process.exit(1); });
setTimeout(() => { console.log('全局超时'); srv.kill(); process.exit(3); }, 40000);
