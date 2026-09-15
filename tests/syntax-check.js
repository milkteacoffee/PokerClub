'use strict';
/**
 * index.html 内联脚本语法体检
 *
 * 背景：index.html 是单文件（约 500KB、全部逻辑内联在一个 <script> 里）。
 * 只要拼接字符串时多/少一个括号，整个 IIFE 就解析失败 —— 浏览器里表现为
 * 「页面能出静态 DOM，但所有交互全哑火（window.Online 等都是 undefined）」，
 * 而 jsdom 测试只会报一堆看起来毫不相干的断言失败（例如 "Online 模块已暴露" 失败），
 * 极难定位。所以在跑任何 jsdom 测试之前，先用本脚本做一次语法体检。
 *
 * 用法：node tests/syntax-check.js
 * 退出码：0 = 语法正常；1 = 发现语法错误
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = process.argv[2] || path.join(__dirname, '../index.html');
const html = fs.readFileSync(file, 'utf8');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;

let m, i = 0, bad = 0;
while ((m = re.exec(html))) {
  i++;
  const code = m[1];
  if (code.trim().length < 200) continue;           // 忽略极小的内联片段
  const startLine = html.slice(0, m.index).split('\n').length;
  try {
    new vm.Script(code, { filename: 'block' + i + '.js' });
    console.log('OK   block ' + i + ' (html 第 ' + startLine + ' 行起, ' + code.length + ' 字符)');
  } catch (e) {
    bad++;
    /* vm 报的行号是「块内行号」，换算成 html 真实行号便于定位 */
    const mm = /block\d+\.js:(\d+)/.exec(e.stack || '');
    const realLine = mm ? (startLine + Number(mm[1]) - 1) : '?';
    console.log('FAIL block ' + i + ' (html 第 ' + startLine + ' 行起): ' + e.message);
    console.log('     → index.html 第 ' + realLine + ' 行附近');
    const lines = html.split('\n');
    if (typeof realLine === 'number') {
      for (let k = realLine - 3; k <= realLine + 1; k++) {
        if (lines[k - 1] !== undefined) console.log('     ' + k + '| ' + lines[k - 1]);
      }
    }
  }
}
if (!i) { console.log('未发现内联脚本块'); process.exit(1); }
console.log(bad ? '\n❌ 发现 ' + bad + ' 处语法错误' : '\n✅ 内联脚本语法正常');
process.exit(bad ? 1 : 0);
