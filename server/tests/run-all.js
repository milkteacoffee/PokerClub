'use strict';
/** 服务端测试总入口：依次跑全部测试，任一失败则整体失败 */
const { spawnSync } = require('child_process');
const path = require('path');

const files = [
  ['掼蛋引擎', 'engine-guandan.test.js', ['500']],
  ['道具系统', 'items.test.js', []],
  ['端到端联机', 'e2e.test.js', []],
  ['双客户端联机冒烟', 'smoke-online.js', []],
];

let failed = 0;
for (const [name, file, args] of files) {
  console.log('\n==== ' + name + ' ====');
  const r = spawnSync(process.execPath, [path.join(__dirname, file), ...args], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) { failed++; console.log('  ✗ ' + name + ' 失败'); }
}

console.log('\n============================');
console.log(failed ? ('  服务端测试失败 ' + failed + ' 组') : '  服务端测试全部通过');
console.log('============================');
process.exit(failed ? 1 : 0);
