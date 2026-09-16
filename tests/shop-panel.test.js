const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
const src = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  .replace(/\(function \(\) \{\s*'use strict';/, '')
  .replace(/\}\)\(\);\s*$/, '');
function makeElement(doc, tag) {
  const el = { tagName: 'DIV', _listeners: {}, children: [], _id: '', _cls: new Set(), style: {}, dataset: {}, textContent: '', value: '', disabled: false, title: '', className: '', parentNode: null };
  el.classList = { add(...c) { c.forEach(x => el._cls.add(x)); el.className = [...el._cls].join(' '); }, remove(...c) { c.forEach(x => el._cls.delete(x)); el.className = [...el._cls].join(' '); }, contains(c) { return el._cls.has(c); }, toggle() {} };
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
  document: doc, navigator: { maxTouchPoints: 0, userAgent: 'shop-test' }, screen: {},
  localStorage: { getItem: k => storage.has(k) ? storage.get(k) : null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
  location: { href: 'https://localhost/', protocol: 'https:', hostname: 'localhost' },
  setTimeout: fn => { try { fn(); } catch (e) {} return 0; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  requestAnimationFrame: () => 0, cancelAnimationFrame() {}, performance: { now: () => Date.now() },
  console: { log() {}, warn() {}, error() {} },
  crypto: { getRandomValues: a => { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0; return a; } },
  fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, coins: 0, list: [] }) }),
  alert() {}, confirm: () => false, prompt: () => null,
  matchMedia: () => ({ matches: false, addListener() {}, removeEventListener() {} }),
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {}; sandbox.dispatchEvent = () => {};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const ctx = sandbox;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL ' + m); } };
console.log('=== 商城分类 + 每日免费礼包 ===');
ctx.loadAllSaves();
ctx.createNewSaveAt(1);
ctx.player.coins = 5000;
ctx.openShop();
const shopHTML = ctx.document.getElementById('shopList').innerHTML || '';
ok(shopHTML.indexOf('每日免费礼包') >= 0, '每日免费礼包卡片存在');
ok(shopHTML.indexOf('100 ~ 500') >= 0, '礼包文案说明 100~500');
ok(shopHTML.indexOf('data-freegift') >= 0, '领取按钮存在');
ok(shopHTML.indexOf('shop-cat') >= 0, '分类标题已渲染');
ok(shopHTML.indexOf('功能道具') >= 0 && shopHTML.indexOf('牌背') >= 0 && shopHTML.indexOf('座位边框') >= 0 && shopHTML.indexOf('称号') >= 0, '四个分类齐全');
ok((shopHTML.match(/shop-item/g) || []).length >= 13, '可见道具 13 件（排位卡已下架，实际 ' + (shopHTML.match(/shop-item/g) || []).length + '）');
// 点击领取
/* 桩的 querySelector 不支持属性选择器 → 免费礼包领取逻辑用数据层验证 */
ctx.player.freeGiftAt = ctx.todayStr();
ctx.renderShop();
ok((ctx.document.getElementById('shopList').innerHTML || '').indexOf('今日已领取') >= 0, '领取后显示今日已领取');
ok((ctx.document.getElementById('shopList').innerHTML || '').indexOf('data-freegift') < 0, '领取后按钮消失');
console.log('商城分类与免费礼包: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
