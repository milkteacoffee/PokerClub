'use strict';
/* 公网端到端校验：短玩家号（生成 / 回填 / 按码加好友 / WS hello 返回） */
const https = require('https');
const { WebSocket } = require('ws');
const REST = 'modelghost.cn';
const A = 'ucode_a_' + Date.now();
const B = 'ucode_b_' + Date.now();
const NICK_A = '码甲' + Date.now();
const NICK_B = '码乙' + Date.now();

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
function wsHello(deviceId, nickname) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://' + REST + '/_poker/ws?deviceId=' + encodeURIComponent(deviceId) + '&nickname=' + encodeURIComponent(nickname));
    ws.on('message', m => { const d = JSON.parse(m.toString()); if (d.type === 'hello') { ws.close(); resolve(d); } });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('超时')), 15000);
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  const pa = await rest('/api/player', A, { nickname: NICK_A });
  const pb = await rest('/api/player', B, { nickname: NICK_B });
  const codeA = pa.body.userCode, codeB = pb.body.userCode;
  console.log((codeA && /^[2-9A-HJKMNP-Z]{8}$/.test(codeA) ? '[PASS] ' : '[FAIL] ') + 'A 注册返回合法 userCode ' + codeA);
  console.log((codeB && codeB !== codeA ? '[PASS] ' : '[FAIL] ') + 'B userCode 与 A 不同 ' + codeB);

  // WS hello 应返回 userCode
  const hello = await wsHello(A, NICK_A);
  console.log((hello.userCode === codeA ? '[PASS] ' : '[FAIL] ') + 'WS hello 返回 userCode ' + hello.userCode);

  // B 用 A 的短码加好友
  const fr = await rest('/api/friends', B, { friendId: codeA });
  console.log((fr.body.ok ? '[PASS] ' : '[FAIL] ') + '用短码加好友成功 ' + JSON.stringify(fr.body));

  // A 视角应收到请求
  const fa = await rest('/api/friends', A);
  const got = (fa.body.requests || []).some(r => r.deviceId === B);
  console.log((got ? '[PASS] ' : '[FAIL] ') + 'A 收到 B 的好友请求 ' + JSON.stringify((fa.body.requests || []).map(r => r.deviceId)));

  await wait(150);
  process.exit((codeA && codeB !== codeA && hello.userCode === codeA && fr.body.ok && got) ? 0 : 1);
}
run().catch(e => { console.error('异常', e.message); process.exit(2); });
setTimeout(() => { console.log('超时'); process.exit(3); }, 30000);
