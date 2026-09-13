// 从 index.html 中抽取 <script> 内容
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('未找到 script 块'); process.exit(1); }
const js = m[1];
fs.writeFileSync(path.join(__dirname, 'game.extracted.js'), js, 'utf8');
console.log('提取 JS 行数:', js.split('\n').length);
