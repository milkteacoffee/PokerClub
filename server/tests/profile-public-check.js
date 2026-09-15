'use strict';
/* 公网端到端校验：头像/资料 + 云存档 + 跨设备接管（部署后手跑） */
const https = require('https');
const REST = 'modelghost.cn';
const A = 'prof_a_' + Date.now();
const B = 'prof_b_' + Date.now();

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
function put(path, deviceId, body) {
  return new Promise((resolve) => {
    const r = https.request({ host: REST, port: 443, path: '/_poker' + path, method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b || '{}') }); } catch (e) { resolve({ status: res.statusCode, body: {} }); } });
    });
    r.on('error', e => resolve({ status: 0, body: { err: e.message } }));
    r.write(JSON.stringify(body));
    r.end();
  });
}
let pass = 0, fail = 0;
function ok(c, m) { console.log((c ? '[PASS] ' : '[FAIL] ') + m); c ? pass++ : fail++; }

async function run() {
  // 1. 注册带头像与签名
  const p = await rest('/api/player', A, { nickname: '甲', avatar: 'a05', bio: '热爱牌桌' });
  ok(p.status === 200 && p.body.avatar === 'a05' && p.body.bio === '热爱牌桌', '注册回显 avatar/bio: ' + JSON.stringify({ a: p.body.avatar, b: p.body.bio }));
  ok(/^[2-9A-HJKMNP-Z]{16}$/.test(p.body.recoveryCode || ''), '返回 16 位恢复码');
  const code = p.body.userCode, rc = p.body.recoveryCode;

  // 2. 云存档写读
  const pu = await put('/api/state', A, { state: { slots: { 1: { coins: 888 } }, mark: 'pub-v1' } });
  ok(pu.status === 200 && pu.body.updatedAt > 0, 'PUT /api/state 成功 updatedAt=' + pu.body.updatedAt);
  const g = await rest('/api/state', A);
  ok(g.body.state && g.body.state.mark === 'pub-v1', 'GET /api/state 读回一致');

  // 3. 接管：新设备 B 凭 玩家号+恢复码 拿到 A 的 deviceId
  const cl = await rest('/api/player/claim', null, { userCode: code, recoveryCode: rc });
  ok(cl.status === 200 && cl.body.deviceId === A, 'claim 返回原 deviceId（' + cl.status + ' ' + JSON.stringify(cl.body).slice(0, 80) + '）');
  ok(cl.body.avatar === 'a05', 'claim 返回头像 a05');

  // 4. 旧设备身份下云存档仍在；错误恢复码 401
  const g2 = await rest('/api/state', A);
  ok(g2.body.state && g2.body.state.mark === 'pub-v1', '接管后原身份云存档未受影响');
  const clBad = await rest('/api/player/claim', null, { userCode: code, recoveryCode: 'AAAAAAAABBBBBBBB' });
  ok(clBad.status === 401, '错误恢复码 claim 401');

  // 5. 轮换恢复码
  const rot = await rest('/api/player/recovery/rotate', A, {});
  ok(rot.status === 200 && rot.body.recoveryCode && rot.body.recoveryCode !== rc, 'rotate 新码与旧码不同');
  const clOld = await rest('/api/player/claim', null, { userCode: code, recoveryCode: rc });
  ok(clOld.status === 401, '旧码 claim 已作废 401');

  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
}
run().catch(e => { console.error('异常', e.message); process.exit(2); });
setTimeout(() => { console.log('超时'); process.exit(3); }, 30000);
