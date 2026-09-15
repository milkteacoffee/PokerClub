/**
 * 局内社交（快捷语）、匹配过场、结算动效、加载态 测试
 * 关键：前端 SAY_TEXTS 与服务端白名单必须一字不差（否则发言会被服务端拒）。
 * 运行: node tests/polish-social.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const serverIdx = fs.readFileSync(path.join(__dirname, '../server/src/index.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) pass++; else { fail++; failures.push(m); } }
const tick = ms => new Promise(r => setTimeout(r, ms));

/* 从源码里抽出字符串数组（对比前后端白名单） */
function grabArray(src, name) {
  const i = src.indexOf(name);
  if (i < 0) return null;
  const j = src.indexOf('[', i), k = src.indexOf(']', j);
  return src.slice(j + 1, k).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

(async () => {
  /* ---- 前后端白名单一致性（最容易出的错） ---- */
  const feSay = grabArray(html, 'var SAY_TEXTS = [');
  const beSay = grabArray(serverIdx, 'const SAY_TEXTS = [');
  ok(!!feSay && feSay.length === 16, '前端有 16 条快捷语（实际 ' + (feSay && feSay.length) + '）');
  ok(!!beSay && beSay.length === 16, '服务端有 16 条白名单（实际 ' + (beSay && beSay.length) + '）');
  ok(JSON.stringify(feSay) === JSON.stringify(beSay), '前后端快捷语一字不差（顺序与文案都要一致）');
  ok(feSay && feSay.every(t => t.length >= 2 && t.length <= 12), '短语长度合理（2~12 字）');
  ok(feSay && new Set(feSay).size === feSay.length, '短语无重复');

  /* ---- 真 jsdom：面板 / 气泡 / 过场 ---- */
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://localhost/', virtualConsole: new (require('jsdom').VirtualConsole)() });
  try {
    await new Promise(r => dom.window.addEventListener('load', r, { once: true }));
    const w = dom.window, d = w.document;
    const $ = i => d.getElementById(i);

    ok(!!$('ovSay') && !!$('sayGrid'), '快捷语面板存在');
    ok(!!$('odSayBtn') && $('odSayBtn').hidden === true, '快捷语按钮默认隐藏（不在对局中）');
    ok(!!$('odIntro') && $('odIntro').hidden === true, '匹配过场元素默认隐藏');

    /* 打开面板并渲染 16 条 */
    $('odSayBtn').click();
    await tick(40);
    ok($('ovSay').classList.contains('show'), '点击按钮打开快捷语面板');
    const items = $('sayGrid').querySelectorAll('.say-item');
    ok(items.length === 16, '面板渲染 16 条短语（实际 ' + items.length + '）');
    ok(items[0].textContent.trim().length > 0, '短语文案已填充');

    /* 静态链路 */
    ok(html.indexOf("m.type === 'say'") > 0, '收到 say 消息时弹气泡');
    ok(html.indexOf('function sayBubble') > 0, '气泡函数存在');
    ok(html.indexOf('.ost-bubble') > 0, '气泡样式存在');
    ok(html.indexOf('introMatched') > 0, '匹配过场已接入');
    ok(/\.od-result \.big\{animation:bigPop/.test(html), '结算大字有入场动效');
    ok(/@keyframes ioDeal/.test(html), '过场发牌动效存在');
    ok(html.indexOf('加载中…') > 0, '排行榜有加载态');
    ok(html.indexOf("'ovSay'") > 0 && /OV_CLOSE_ON_BACKDROP[\s\S]{0,200}ovSay/.test(html), '快捷语面板可点遮罩关闭');
  } catch (e) { fail++; failures.push('jsdom 段异常: ' + e.message); }
  try { dom.window.close(); } catch (e) {}

  /* ---- vm 去壳：气泡与过场行为 ---- */
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace(/\(function \(\) \{\s*'use strict';/, '')
    .replace(/\}\)\(\);\s*$/, '')
    .replace(/  init\(\);/, '');
  const dom2 = new JSDOM(html.replace(/<script>[\s\S]*?<\/script>/, ''), { url: 'https://polish.test', runScripts: 'outside-only' });
  const w2 = dom2.window;
  /* 可控定时器队列：不自动执行，测试里手动触发，便于断言中间状态 */
  const timers = [];
  w2.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const fireTimers = (ms) => { timers.filter(t => t.ms === ms).forEach(t => { try { t.fn(); } catch (e) {} }); };
  w2.requestAnimationFrame = () => 0;
  w2.eval(code);
  w2.loadAllSaves();
  const d2 = w2.document;

  try {
    /* 造一个座位节点，验证气泡挂载与文本截断 */
    const box = d2.getElementById('odSeats');
    box.innerHTML = '<div class="ost" data-oseat="1"></div><div class="ost" data-oseat="2"></div>';
    w2.sayBubble(1, '打得不错');
    const b1 = box.querySelector('.ost[data-oseat="1"] .ost-bubble');
    ok(!!b1 && b1.textContent === '打得不错', '气泡挂到对应座位并显示文案');
    ok(!box.querySelector('.ost[data-oseat="2"] .ost-bubble'), '只挂到发言者座位');
    w2.sayBubble(1, 'x'.repeat(50));
    const b2 = box.querySelector('.ost[data-oseat="1"] .ost-bubble');
    ok(b2 && b2.textContent.length <= 24, '超长文本被截断（内容安全）');
    w2.sayBubble(1, '再来');
    const seats = box.querySelectorAll('.ost[data-oseat="1"] .ost-bubble');
    ok(seats.length === 1, '同一座位只保留一条气泡（不叠加）');
    ok(seats[0].textContent === '再来', '新气泡替换旧气泡');
    w2.sayBubble(99, '越界座位');
    ok(true, '不存在的座位不抛错');
    fireTimers(3000);
    ok(!box.querySelector('.ost-bubble'), '3 秒后气泡自动消失');

    /* 过场：显示后自动隐藏 */
    const intro = d2.getElementById('odIntro');
    let called = false;
    w2.introMatched(function () { called = true; });
    ok(intro.hidden === false, '过场开始时显示（匹配成功仪式感）');
    ok(called === false, '过场期间尚未进入牌桌');
    fireTimers(820);
    ok(intro.hidden === true, '约 0.8 秒后过场自动隐藏');
    ok(called === true, '过场结束后才进牌桌（回调触发）');
  } catch (e) { fail++; failures.push('vm 段异常: ' + e.message); }
  try { dom2.window.close(); } catch (e) {}

  console.log('局内社交与仪式感测试: ' + pass + ' 项通过, ' + fail + ' 项失败');
  if (fail) { failures.slice(0, 12).forEach(f => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})();
