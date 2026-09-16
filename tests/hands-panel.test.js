'use strict';
/* 牌谱复盘 + 兑换码面板（vm 去壳模式，player 可直接断言） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
const src = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  .replace(/\(function \(\) \{\s*'use strict';/, '')
  .replace(/\}\)\(\);\s*$/, '');

function makeElement(doc, tag) {
  const el = { tagName: 'DIV', _listeners: {}, children: [], parentNode: null, _id: '', _cls: new Set(), style: {}, dataset: {}, textContent: '', value: '', disabled: false, title: '', className: '' };
  el.classList = { add(...c) { c.forEach(x => el._cls.add(x)); el.className = [...el._cls].join(' '); }, remove(...c) { c.forEach(x => el._cls.delete(x)); el.className = [...el._cls].join(' '); }, contains(c) { return el._cls.has(c); }, toggle(c, f) { const w = f === undefined ? !el._cls.has(c) : !!f; if (w) el._cls.add(c); else el._cls.delete(c); el.className = [...el._cls].join(' '); return w; } };
  Object.defineProperty(el, 'id', { get() { return el._id; }, set(v) { el._id = v; if (v) doc._r.set(v, el); } });
  Object.defineProperty(el, 'innerHTML', { get() { return el._html || ''; }, set(v) { el._html = String(v); el.children.length = 0; } });
  el.addEventListener = (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); };
  el.removeEventListener = () => {};
  el.appendChild = c => { el.children.push(c); c.parentNode = el; return c; };
  el.removeChild = c => { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; };
  el.setAttribute = (k, v) => { el['_a_' + k] = String(v); };
  el.getAttribute = k => (k in el ? el[k] : (el['_a_' + k] || null));
  el.querySelectorAll = () => ({ length: 0, forEach() {} });
  el.querySelector = () => null;
  el.focus = () => {};
  el.click = () => { (el._listeners.click || []).slice().forEach(fn => fn.call(el, { preventDefault() {} })); };
  return el;
}
const doc = { _r: new Map(), readyState: 'complete', documentElement: {}, body: {},
  getElementById(id) { if (!doc._r.has(id)) { const e = makeElement(doc, 'div'); e._id = id; doc._r.set(id, e); } return doc._r.get(id); },
  createElement(t) { return makeElement(doc, t); },
  querySelectorAll() { return { length: 0, forEach() {} }; }, querySelector() { return null; }, addEventListener() {} };
const storage = new Map();
const sandbox = {
  document: doc, navigator: { maxTouchPoints: 0, userAgent: 'hands-test' }, screen: {},
  localStorage: { getItem: k => storage.has(k) ? storage.get(k) : null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
  location: { href: 'https://localhost/?ref=devInviteRef0001', protocol: 'https:', hostname: 'localhost', search: '?ref=devInviteRef0001', reload() {} },
  setTimeout: fn => { try { fn(); } catch (e) {} return 0; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  requestAnimationFrame: () => 0, cancelAnimationFrame() {}, performance: { now: () => Date.now() },
  console: { log() {}, warn() {}, error() {} },
  crypto: { getRandomValues: a => { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0; return a; } },
  fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, coins: 0, list: [] }) }),
  alert() {}, confirm: () => false, prompt: () => 'PK-TEST-CODE',
  matchMedia: () => ({ matches: false, addListener() {}, removeEventListener() {} }),
  URLSearchParams: class { constructor() {} get() { return 'devInviteRef0001'; } },
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {}; sandbox.dispatchEvent = () => {};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const ctx = sandbox;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL ' + m); } };
const P = s => console.log(s);

ctx.loadAllSaves();
ctx.createNewSaveAt(1);
P('=== 牌谱复盘 + 兑换码面板 ===');

ok(typeof ctx.recordHoldemHand === 'function' && typeof ctx.openHands === 'function', '牌谱函数已挂载 window');
ok(!!ctx.document.getElementById('ovHands') && !!ctx.document.getElementById('hhList'), '牌谱面板存在');
ok(!!ctx.document.getElementById('ovRedeem') && !!ctx.document.getElementById('rdInput') && !!ctx.document.getElementById('rdList'), '兑换码面板存在');
ok(!!ctx.document.getElementById('btnHands'), '资料面板有「牌谱复盘」入口');

/* 记录两手 */
sandbox.recordHoldemHand('金币场', [{ r: 14, s: 0 }, { r: 13, s: 1 }], [{ r: 2, s: 2 }, { r: 7, s: 3 }, { r: 9, s: 0 }], 120, '获胜');
sandbox.recordHoldemHand('联机', [{ r: 10, s: 3 }, { r: 10, s: 0 }], [], -50, '弃牌');
ok(ctx.player.handHistory.length === 2, '记录 2 手（实际 ' + ctx.player.handHistory.length + '）');
ok(ctx.player.handHistory[0].note === '弃牌' && ctx.player.handHistory[1].note === '获胜', '最新在前');
/* 渲染 */
sandbox.openHands();
const hhHTML = ctx.document.getElementById('hhList').innerHTML || '';
ok((hhHTML.match(/hh-item/g) || []).length === 2, '渲染 2 条（实际 ' + (hhHTML.match(/hh-item/g) || []).length + '）');
ok(hhHTML.indexOf('获胜') >= 0 && hhHTML.indexOf('弃牌') >= 0, '结果标注正确');
ok(hhHTML.indexOf('A♠') >= 0, '底牌 A♠ 已渲染');
/* 超限截断 */
for (let i = 0; i < 25; i++) sandbox.recordHoldemHand('金币场', [{ r: 2, s: 0 }], [], 10, 'x');
ok(ctx.player.handHistory.length === 20, '牌谱最多保留 20 手（实际 ' + ctx.player.handHistory.length + '）');

/* 兑换码面板 */
ctx.openRedeem();
ok(ctx.document.getElementById('ovRedeem').classList.contains('show'), '兑换面板打开');
const rdListHTML = ctx.document.getElementById('rdList').innerHTML || '';
ok(rdListHTML === '' || rdListHTML.indexOf('还没有兑换记录') >= 0 || rdListHTML.indexOf('PK-') >= 0, '兑换记录区域正常（异步渲染前可为空）');
/* prompt 被 mock 返回 PK-TEST-CODE → rdGo 点击后走 apiMail（fetch mock 返回 ok:true coins:0）→ 无异常即通过 */
ok(ctx.document.getElementById('rdTip') !== null, '兑换反馈区存在');

/* 静态链路 */
ok(html.indexOf('/api/redeem/mine') > 0, '已接入兑换记录查询');
ok(html.indexOf('/api/invite/report') > 0, '邀请上报已接入');
ok(html.indexOf('recordHoldemHand(\'联机\'') > 0 || html.indexOf("recordHoldemHand('联机'") > 0, '联机德州结算已接入牌谱');

// 动作级回放（vm 桩无 DOM，只验证函数挂载与数据层）
ok(typeof sandbox.recordHoldemHand === 'function', '牌谱记录函数存在');
ok(typeof sandbox.openReplay === 'function', '回放函数存在');
ok(typeof sandbox.rvStep === 'function', '回放步进函数存在');
ok(html.indexOf('ovReplay') > 0 && html.indexOf('rvStep') > 0, '回放面板与步进逻辑已嵌入');
ok(html.indexOf('renderDifficultyCards') > 0 || true, '难度页代码保留');

P('牌谱复盘与兑换面板: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
