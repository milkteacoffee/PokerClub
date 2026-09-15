/**
 * 邀请链接端到端测试（jsdom）
 *  1) ?room=6位房号(&game=) → 自动打开好友开房面板、预填房号与游戏、自动发起连接
 *  2) 连接失败（本地无服务器）→ 提示可手动重试，且无未捕获错误
 *  3) 无参数进入 → 不自动弹联机面板（回归）
 * 运行: node tests/room-share.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) pass++; else { fail++; failures.push(m); console.log('  ✗ ' + m); } }
function tick(ms) { return new Promise(r => setTimeout(r, ms || 0)); }

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const SEED = JSON.stringify({ activeSlot: 1, slots: { 1: { player: { name: '玩家', coins: 500, version: 13, initialGrantResolved: true }, createdAt: Date.now(), lastPlayed: Date.now() }, 2: null, 3: null } });

function makeDom(url) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    const msg = String(e && e.message || e);
    if (/Could not parse CSS|Not implemented|Error: Not implemented/.test(msg)) return;
    errors.push('jsdomError: ' + msg);
  });
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url,
    virtualConsole: vc,
    beforeParse(w) { w.localStorage.setItem('texas_poker_device_saves_v2', SEED); },
  });
  return { dom, errors };
}

(async function run() {
  console.log('【带 ?room= 的邀请链接】');
  {
    const { dom, errors } = makeDom('https://localhost/?room=646685&game=holdem');
    const doc = dom.window.document;
    const $ = id => doc.getElementById(id);
    await tick(80);
    ok($('ovOnline') && $('ovOnline').classList.contains('show'), '自动打开好友开房面板');
    ok($('onlineCode') && $('onlineCode').value === '646685', '房号输入框已预填 646685（实际 ' + ($('onlineCode') && $('onlineCode').value) + '）');
    const sel = $('onlineGames') && $('onlineGames').querySelector('[data-ogame].selected');
    ok(sel && sel.getAttribute('data-ogame') === 'holdem', '游戏预选 holdem（实际 ' + (sel ? sel.getAttribute('data-ogame') : '无') + '）');
    ok(($('onlineTip').textContent || '').indexOf('646685') >= 0, '提示正在加入房间');
    /* WS 连本地 127.0.0.1:8123 必然失败 → 最终提示可手动重试 */
    let tip = '';
    for (let i = 0; i < 25; i++) {
      await tick(100);
      tip = $('onlineTip').textContent || '';
      if (/无法连接服务器|手动重试/.test(tip)) break;
    }
    ok(/无法连接服务器|手动重试/.test(tip), '连接失败后提示可手动重试（实际: ' + tip + '）');
    ok(errors.length === 0, '全程无未捕获错误' + (errors.length ? '：' + errors.slice(0, 3).join(' | ') : ''));
    dom.window.close();
  }

  console.log('【无参数进入（回归）】');
  {
    const { dom, errors } = makeDom('https://localhost/');
    const doc = dom.window.document;
    const $ = id => doc.getElementById(id);
    await tick(80);
    ok(!$('ovOnline').classList.contains('show'), '无参数时不自动弹联机面板');
    ok(errors.length === 0, '无参数加载无未捕获错误' + (errors.length ? '：' + errors.slice(0, 3).join(' | ') : ''));
    dom.window.close();
  }

  console.log('\n============================');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  console.log('============================');
  if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
  console.log('✅ 邀请链接测试全部通过');
  process.exit(0);
})().catch(e => {
  console.error('✗ 测试过程抛出未捕获异常:', e);
  process.exit(1);
});
