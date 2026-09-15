'use strict';
/* 公网端到端校验：昵称搜索 + 房间号查成员（走 https://modelghost.cn/_poker 反代） */
const https = require('https');
const { WebSocket } = require('ws');
const SERVER = 'https://modelghost.cn/_poker';
const REST = 'modelghost.cn';
const A = 'pubchk_a_' + Date.now();
const B = 'pubchk_b_' + Date.now();
const NICK_A = '公网甲' + Date.now();
const NICK_B = '公网乙' + Date.now();

function rest(path, deviceId, body) {
  return new Promise((resolve) => {
    const r = https.request({ host: REST, port: 443, path: '/_poker' + path, method: body ? 'POST' : 'GET',
      headers: Object.assign({ 'Content-Type': 'application/json' }, deviceId ? { 'X-Device-Id': deviceId } : {}) }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b || '{}') }); } catch (e) { resolve({ status: res.statusCode, body: {} }); } });
    });
    r.on('error', e => resolve({ status: 0, body: { err: e.message } }));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
function wsCreate(game, deviceId, nickname) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://' + REST + '/_poker/ws?deviceId=' + encodeURIComponent(deviceId) + '&nickname=' + encodeURIComponent(nickname));
    let done = false;
    ws.on('open', () => ws.send(JSON.stringify({ type: 'create', game })));
    ws.on('message', m => {
      const d = JSON.parse(m.toString());
      if (d.type === 'room' && d.code && !done) { done = true; resolve({ ws, code: d.code }); }
    });
    ws.on('error', reject);
    setTimeout(() => { if (!done) reject(new Error('ws 建房超时')); }, 15000);
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  await rest('/api/player', A, { nickname: NICK_A });
  await rest('/api/player', B, { nickname: NICK_B });
  const { ws, code } = await wsCreate('holdem', A, NICK_A);
  console.log('[建房] 房号', code);

  const mem = await rest('/api/room/members?code=' + code, A);
  const inMem = (mem.body.members || []).some(x => x.deviceId === A);
  console.log((inMem ? '[PASS] ' : '[FAIL] ') + '房间成员含建房者A  ' + JSON.stringify((mem.body.members || []).map(x => x.nickname)));

  const s = await rest('/api/friends/search?q=' + encodeURIComponent('公网乙'), A);
  const inList = (s.body.list || []).some(x => x.deviceId === B);
  const noSelf = !(s.body.list || []).some(x => x.deviceId === A);
  console.log((inList && noSelf ? '[PASS] ' : '[FAIL] ') + '昵称搜索命中B且排除自己  ' + JSON.stringify((s.body.list || []).map(x => x.deviceId)));

  ws.close();
  await wait(200);
  process.exit((inMem && inList && noSelf) ? 0 : 1);
}
run().catch(e => { console.error('异常', e.message); process.exit(2); });
setTimeout(() => { console.log('超时'); process.exit(3); }, 30000);
