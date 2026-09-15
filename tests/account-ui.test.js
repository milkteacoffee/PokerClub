/**
 * 账号体系前端测试（注册/登录 UI + 游客态 + 表单校验 + 已登录展示）
 * 运行: node tests/account-ui.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) pass++; else { fail++; failures.push(m); } }
const tick = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {});
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://localhost/', virtualConsole: vc });
  try {
    await new Promise(r => dom.window.addEventListener('load', r, { once: true }));
    const w = dom.window, d = w.document;
    const $ = i => d.getElementById(i);

    /* ---- 结构与入口 ---- */
    ok(!!$('ovAccount'), '账号弹窗存在');
    ok(!!$('accUser') && !!$('accPwd') && !!$('accPwd2') && !!$('accSubmit') && !!$('accTip'), '账号表单控件齐全');
    ok(!!$('accTabs') && $('accTabs').querySelectorAll('[data-acctab]').length === 2, '登录/注册两个 tab');
    ok(!!$('accBox'), '资料面板有账号区块');
    ok($('ovAccount').textContent.indexOf('不收集手机号') > 0, '说明不收集手机号/不做实名');

    /* ---- 打开资料面板：游客态 ---- */
    $('lbAvatar').click();
    await tick(60);
    ok($('ovProfile').classList.contains('show'), '打开用户资料');
    const box = $('accBox');
    ok(box.textContent.indexOf('游客身份') >= 0, '游客态文案正确：' + box.textContent.slice(0, 20));
    ok(!!$('accLoginBtn') && !!$('accRegBtn'), '游客态给出「登录」「注册账号」入口');
    ok(box.textContent.indexOf('换设备') >= 0, '说明账号的价值（换设备找回进度）');

    /* ---- 注册态 ---- */
    $('accRegBtn').click();
    await tick(40);
    ok($('ovAccount').classList.contains('show'), '点「注册账号」打开弹窗');
    ok($('accTitle').textContent.indexOf('注册') >= 0, '标题切到注册');
    ok($('accPwd2').hidden === false, '注册态显示确认密码');
    ok($('accSubmit').textContent.indexOf('注册') >= 0, '按钮文案为注册');
    ok($('accTabs').querySelector('[data-acctab="register"]').classList.contains('selected'), '注册 tab 选中');

    /* ---- 切到登录态 ---- */
    $('accTabs').querySelector('[data-acctab="login"]').click();
    await tick(40);
    ok($('accPwd2').hidden === true, '登录态隐藏确认密码');
    ok($('accSubmit').textContent.trim() === '登录', '按钮文案为登录：' + $('accSubmit').textContent);
    ok($('accTitle').textContent.indexOf('登录') >= 0, '标题切回登录');

    /* ---- 表单校验（不发请求） ---- */
    $('accUser').value = 'ab';
    $('accPwd').value = 'secret123';
    $('accSubmit').click();
    await tick(30);
    ok(/3~16/.test($('accTip').textContent), '用户名过短被拦：' + $('accTip').textContent);
    $('accUser').value = 'valid_user';
    $('accPwd').value = '123';
    $('accSubmit').click();
    await tick(30);
    ok(/至少 6 位/.test($('accTip').textContent), '密码过短被拦：' + $('accTip').textContent);
    /* 注册态两次密码不一致 */
    $('accTabs').querySelector('[data-acctab="register"]').click();
    await tick(30);
    $('accUser').value = 'valid_user';
    $('accPwd').value = 'secret123';
    $('accPwd2').value = 'secret124';
    $('accSubmit').click();
    await tick(30);
    ok(/不一致/.test($('accTip').textContent), '两次密码不一致被拦：' + $('accTip').textContent);

    /* 合法输入在无服务器环境下应给出「无法连接」而不是崩 */
    $('accUser').value = 'valid_user';
    $('accPwd').value = 'secret123';
    $('accPwd2').value = 'secret123';
    $('accSubmit').click();
    await tick(120);
    ok(/无法连接服务器|网络错误|操作失败/.test($('accTip').textContent), '无服务器时给出友好提示：' + $('accTip').textContent);
    ok(!/undefined/.test($('accTip').textContent), '提示文案无 undefined');

    /* ---- 静态链路 ---- */
    ok(html.indexOf('/api/account/register') > 0 && html.indexOf('/api/account/login') > 0, '已接入注册/登录接口');
    ok(html.indexOf("'/api/account/me'") > 0, '已接入账号状态查询');
    ok(html.indexOf('poker_login_sync_v1') > 0, '登录后以云端存档为准的标记已接入');
    ok(/登录成功，正在载入你的进度/.test(html), '登录成功有明确反馈');
    ok(html.indexOf('退出登录') > 0, '提供退出登录');
    ok(/scrypt 加盐哈希/.test(html), '向用户说明密码保存方式');
  } catch (e) { fail++; failures.push('测试异常: ' + e.message); }
  try { dom.window.close(); } catch (e) {}

  console.log('账号体系前端测试: ' + pass + ' 项通过, ' + fail + ' 项失败');
  if (fail) { failures.slice(0, 12).forEach(f => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})();
