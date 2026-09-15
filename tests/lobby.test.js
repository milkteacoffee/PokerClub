'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/Not implemented/.test(e.message)) errors.push(e.message); });
let checks = 0;
function check(value, msg) { assert.ok(value, msg); checks++; }
(async () => {
  const dom = new JSDOM(html, { runScripts:'dangerously', pretendToBeVisual:true, url:'https://localhost/', virtualConsole:vc });
  try {
    await new Promise(r => dom.window.addEventListener('load', r, { once:true }));
    const w = dom.window, d = w.document, name = d.getElementById('lbName'), input = d.getElementById('lbNameInput');
    const key = (k, composing = false) => input.dispatchEvent(new w.KeyboardEvent('keydown', { key:k, bubbles:true, isComposing:composing }));
    const saved = () => JSON.parse(w.localStorage.getItem('texas_poker_device_saves_v2')).slots[1].player.name;
    check(!d.getElementById('lbNameEdit'), 'No explicit edit button');
    check(name.tagName === 'BUTTON' && input.hidden, 'Accessible name, editor initially hidden');
    name.click();
    check(name.hidden && !input.hidden && d.activeElement === input, 'Click enters inline editing');
    input.value = '自然牌手'; key('Enter', true);
    check(!input.hidden, 'IME Enter does not commit');
    key('Enter');
    check(input.hidden && name.textContent === '自然牌手' && saved() === '自然牌手', 'Enter saves name and storage');
    name.click(); input.value = '取消名称'; key('Escape');
    check(name.textContent === '自然牌手' && saved() === '自然牌手', 'Escape cancels');
    name.click(); input.value = '   '; key('Enter');
    check(saved() === '自然牌手', 'Empty name preserves previous name');
    name.click(); input.value = '轻舟'; input.blur();
    check(saved() === '轻舟' && name.textContent === '轻舟', 'Blur saves');
    name.click(); input.value = '<测试>123456789012345'; key('Enter');
    check(!saved().includes('<') && Array.from(saved()).length === 12, 'Sanitizes markup and limits length');
    check(d.getElementById('slotList').textContent.includes(saved()), 'Save slot display synced');
    check(d.querySelectorAll('.lobby-topbtns button').length === 10, 'Ten stable functions: 8 originals + online + leaderboard (storage entry removed in cloud era)');
    check(!d.querySelector('.lobby-quickbtns'), 'Duplicate bottom navigation removed');
    for (const id of ['lbQTasks', 'lbQAchieve', 'lbQShop', 'lbQStorage', 'lbQTaskBadge']) check(!d.getElementById(id), 'Removed duplicate: ' + id);
    for (const id of ['lbQCheckin', 'lbQStats', 'lbQHelp']) check(d.querySelector('.lobby-topbtns').contains(d.getElementById(id)), 'Moved to top: ' + id);
    for (const selector of ['.lobby-iconbtn', '.lobby-coins', '.lobby-name-row .rank-badge', '.panel', '.mode-card', '.diff-card']) {
      const actual = d.querySelector(selector);
      const el = actual || d.createElement('div');
      if (!actual) { el.className = selector.slice(1); d.body.appendChild(el); }
      const css = w.getComputedStyle(el);
      check(css.borderTopWidth === '0px', selector + ' has no border');
      if (!actual) el.remove();
    }
    check(errors.length === 0, 'No script errors: ' + errors.join(';'));
    const stored = w.localStorage.getItem('texas_poker_device_saves_v2');
    const reload = new JSDOM(html, { runScripts:'dangerously', pretendToBeVisual:true, url:'https://localhost/', virtualConsole:vc,
      beforeParse(win) { win.localStorage.setItem('texas_poker_device_saves_v2', stored); }
    });
    try {
      await new Promise(r => reload.window.addEventListener('load', r, { once:true }));
      check(reload.window.document.getElementById('lbName').textContent === saved(), 'Name survives reload');
    } finally { reload.window.close(); }
    console.log('Lobby interaction checks passed: ' + checks);
  } finally { dom.window.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
