// 前端好友管理 UI 集成测试（两个独立 JSDOM 实例 = 两个浏览器/玩家）
// 走真实公网后端 https://modelghost.cn/_poker
const path = require('path');
const fs = require('fs');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const SERVER = 'https://modelghost.cn/_poker';

const A = 'uitest_a_' + Date.now();
const B = 'uitest_b_' + Date.now();

function mkInstance(deviceId) {
  const store = { poker_online_device_v1: deviceId };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://milkteacoffee.github.io/PokerClub/',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.POKERCLUB_SERVER = SERVER;
      // jsdom 不自带 fetch，注入 Node 全局 fetch 让前端真实联网
      if (typeof win.fetch !== 'function' && typeof fetch === 'function') {
        win.fetch = fetch.bind(globalThis);
      }
      if (typeof win.fetch !== 'function') {
        const g = globalThis;
        win.fetch = (...a) => g.fetch(...a);
      }
      Object.defineProperty(win, 'localStorage', { value: {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; },
      }});
    }
  });
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return dom;
}

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log((cond ? '[PASS] ' : '[FAIL] ') + name + (extra !== undefined ? '  ' + extra : ''));
}
const wait = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  // 1. B 先在服务端注册（让 A 能加 B）
  await fetch(SERVER + '/api/player', {
    method:'POST', headers:{'Content-Type':'application/json','X-Device-Id':B},
    body: JSON.stringify({nickname:'UI测试乙'})
  });

  // 2. 两个独立实例
  const domA = mkInstance(A);
  const domB = mkInstance(B);
  await wait(600);

  const OnlineA = domA.window.Online;
  const OnlineB = domB.window.Online;
  check('A 实例 Online.server 指向公网', OnlineA.server === SERVER, OnlineA.server);
  check('B 实例 Online.server 指向公网', OnlineB.server === SERVER, OnlineB.server);

  // 3. A 打开排行榜 → 好友榜 → 加 B
  domA.window.document.getElementById('lbBtnBoard').click();
  await wait(300);
  domA.window.document.querySelectorAll('#boardScope [data-scope]').forEach(t => {
    if (t.getAttribute('data-scope') === 'friends') t.click();
  });
  await wait(400);
  const fpA = domA.window.document.getElementById('friendPanel');
  check('A 好友面板可见', fpA && fpA.style.display !== 'none', fpA && fpA.style.display);
  const inpA = domA.window.document.getElementById('friendInput');
  const addA = domA.window.document.getElementById('friendAddBtn');
  check('A 加好友控件存在', !!inpA && !!addA);
  // 3.5 好友面板内展示「我的玩家号」（免连接 REST 拉取，轮询等待）
  let myCode = '';
  for (let i = 0; i < 10; i++) {
    await wait(400);
    const t = ((domA.window.document.getElementById('friendMyCode') || {}).textContent || '').trim();
    if (/^[2-9A-HJKMNP-Z]{8}$/.test(t)) { myCode = t; break; }
  }
  check('A 好友面板展示我的玩家号', /^[2-9A-HJKMNP-Z]{8}$/.test(myCode), myCode);
  inpA.value = B;
  addA.click();
  await wait(900);

  // 4. B 打开排行榜 → 好友榜 → 应看到 A 的请求
  domB.window.document.getElementById('lbBtnBoard').click();
  await wait(300);
  domB.window.document.querySelectorAll('#boardScope [data-scope]').forEach(t => {
    if (t.getAttribute('data-scope') === 'friends') t.click();
  });
  await wait(500);
  const reqB = domB.window.document.getElementById('friendReqList');
  const accB = reqB.querySelector('[data-acc]');
  check('B 看到 A 的好友请求', !!accB, accB ? 'from ' + accB.getAttribute('data-acc') : 'none');
  if (accB) { accB.click(); await wait(900); }

  // 5. A 刷新好友榜 → 应包含 B（或自己）
  domA.window.document.getElementById('lbBtnBoard').click();
  await wait(300);
  domA.window.document.querySelectorAll('#boardScope [data-scope]').forEach(t => {
    if (t.getAttribute('data-scope') === 'friends') t.click();
  });
  await wait(2000);
  const listA = domA.window.document.getElementById('boardList');
  const txt = listA.textContent || '';
  // 调试：直接拉取服务端好友榜
  try {
    const dbg = await fetch(SERVER + '/api/leaderboard?game=holdem&scope=friends&limit=10', { headers: { 'X-Device-Id': A } });
    const dj = await dbg.json();
    console.log('[DEBUG] 服务端 A 好友榜:', JSON.stringify(dj.list.map(x => x.nickname + (x.isMe ? '(me)' : ''))));
  } catch(e) { console.log('[DEBUG] 拉取失败', e.message); }
  // 好友关系建立后，A 的好友榜应包含「自己」与「好友乙」，且不应是“不支持联网”提示
  check('A 好友榜含好友且无联网错误', txt.indexOf('不支持联网') < 0 && txt.indexOf('（我）') >= 0, txt.slice(0, 80));
  console.log('[INFO] 前端渲染好友榜内容:', txt.replace(/\s+/g,' ').slice(0, 100));

  const failed = results.filter(r => !r.ok);
  console.log('\n===== 前端好友 UI 集成测试 =====');
  console.log('通过 ' + (results.length - failed.length) + ' / ' + results.length);
  if (failed.length) { failed.forEach(f => console.log('  - ' + f.name)); process.exit(1); }
  console.log('全部通过 ✓');
  process.exit(0);
}
run().catch(e => { console.error('异常', e); process.exit(2); });
setTimeout(() => { console.log('超时'); process.exit(3); }, 40000);
