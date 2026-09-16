/**
 * 合规与内容安全测试（真 jsdom 走 UI）
 * 覆盖：隐私政策与用户协议弹窗、意见反馈、条款/反馈互相切换、
 *       震动开关、昵称与签名违规词拦截（广告/代充/赌博类）。
 * 运行: node tests/compliance.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/Not implemented|clipboard/.test(e.message)) errors.push(e.message); });

let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) pass++; else { fail++; failures.push(m); } }
const tick = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://localhost/', virtualConsole: vc });
  try {
    await new Promise(r => dom.window.addEventListener('load', r, { once: true }));
    const w = dom.window, d = w.document;
    const $ = i => d.getElementById(i);
    const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

    /* ---- 隐私政策与用户协议 ---- */
    ok(!!$('ovLegal'), '隐私政策弹窗存在');
    ok(!!$('legalBody'), '条款正文容器存在');
    click($('btnSettings'));
    await tick(40);
    ok($('ovSettings').classList.contains('show'), '点击设置打开设置面板');
    ok(!!$('btnLegal') && !!$('btnFeedback') && !!$('setHapticToggle'), '设置里有合规入口与震动开关');

    click($('btnLegal'));
    await tick(40);
    ok($('ovLegal').classList.contains('show'), '点击打开隐私政策与用户协议');
    const legal = $('legalBody').textContent;
    ok($('ovLegal').querySelector('h2').textContent.indexOf('隐私政策与用户协议') >= 0, '标题正确');
    ok(/不含充值、内购、广告/.test(legal), '明确无充值内购广告');
    ok(/不具有货币价值，不可交易、不可转让、不可兑换/.test(legal), '明确虚拟物品无货币价值不可兑换');
    ok(/18 周岁及以上/.test(legal), '未成年人条款（18+）');
    ok(/不收集<\/b>手机号/.test($('legalBody').innerHTML) || legal.indexOf('手机号') > 0, '说明不收集手机号等信息');
    ok(/自建服务器/.test(legal) && /中国大陆境内/.test(legal), '说明数据存储位置');
    ok(/赌博活动/.test(legal), '含禁止赌博条款');

    /* ---- 意见反馈，并可切回条款 ---- */
    click($('btnFeedback'));
    await tick(40);
    const fb = $('legalBody').textContent;
    ok($('ovLegal').classList.contains('show'), '意见反馈复用同一条款弹窗');
    ok(/复制诊断信息/.test(fb), '反馈页提供复制诊断信息');
    ok(!!$('fbCopy'), '复制按钮存在（脚本绑定成功）');
    click($('btnLegal'));
    await tick(40);
    ok(/不具有货币价值/.test($('legalBody').textContent), '从反馈切回条款时内容能恢复（LEGAL_HTML 缓存生效）');

    /* ---- 震动开关 ---- */
    ok($('setHapticToggle').textContent.indexOf('开') > 0, '震动开关默认显示「开」');
    click($('setHapticToggle'));
    await tick(40);
    ok($('setHapticToggle').textContent.indexOf('关') > 0, '点击后显示「关」（设置已落地）: ' + $('setHapticToggle').textContent);
    click($('setHapticToggle'));
    await tick(40);
    ok($('setHapticToggle').textContent.indexOf('开') > 0, '再点回到「开」');

    /* ---- 昵称违规词拦截（走大厅改名流程）---- */
    const nameInput = $('lbNameInput');
    const before = $('lbName').textContent;
    click($('lbName'));
    await tick(20);
    ok(nameInput.hidden === false, '点击昵称进入编辑态');
    nameInput.value = '加微信代充金币';
    nameInput.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick(40);
    ok($('lbName').textContent.trim() === before.trim(), '含「加微信代充」的昵称被拒绝，原名保留');
    ok(/违规词/.test($('toast').textContent), '给出违规词提示: ' + $('toast').textContent.slice(0, 30));

    click($('lbName'));
    await tick(20);
    nameInput.value = '正常昵称哦';
    nameInput.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick(40);
    ok($('lbName').textContent.trim() === '正常昵称哦', '正常昵称可以保存');

    click($('lbName'));
    await tick(20);
    nameInput.value = '12345678';
    nameInput.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick(40);
    ok($('lbName').textContent.trim() === '正常昵称哦', '纯数字昵称被拒绝');

    /* ---- 品牌去赌博化（2026-09-15 改名：赌途 → 牌友小馆）---- */
    ok(d.title.indexOf('牌友小馆') >= 0, '页面标题为「牌友小馆」: ' + d.title);
    ok(d.querySelector('.lobby-logo').textContent.trim() === '牌友小馆', '大厅 logo 为「牌友小馆」');
    {
      const c2 = d.body.cloneNode(true);
      c2.querySelectorAll('script,style').forEach(n => n.remove());
      const t2 = c2.innerHTML;
      const bad = ['赌途', '赌神', '赌桌'].filter(k => t2.indexOf(k) >= 0);
      ok(bad.length === 0, '界面无赌博品牌语汇残留（命中: ' + bad.join('、') + '）');
      ok(t2.indexOf('严禁赌博') > 0, '合规声明仍在（严禁赌博）');
      ok(t2.indexOf('称号收集进度') >= 0, '大厅横幅已改为称号收集进度');
    }

    /* ---- 无致命错误 ---- */
    ok(errors.filter(e => !/Cannot set property|Not implemented/.test(e)).length === 0, '无致命脚本错误: ' + errors.slice(0, 2).join(' | '));
  } catch (e) {
    fail++; failures.push('测试异常: ' + e.message);
  }
  try { dom.window.close(); } catch (e) {}

  console.log('合规与内容安全测试: ' + pass + ' 项通过, ' + fail + ' 项失败');
  if (fail) { failures.slice(0, 12).forEach(f => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})();
