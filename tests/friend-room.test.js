'use strict';
/**
 * 好友房壳检查：
 *  - 不依赖任何第三方云 SDK（联机为自建 Node 后端）
 *  - 不使用旧的 lbBtnFriends 入口（现为 lbBtnOnline + ovOnline）
 *  - 六馆入口齐全、纯单机定位保留
 *  - 联机入口与弹窗结构存在
 */
const fs = require('fs');
const assert = require('assert');
const html = fs.readFileSync('D:/Projects/dezhou/index.html', 'utf8');

/* 1) 无第三方云依赖 */
assert(!html.includes('workbuddy-cloud-sdk'), '不引入第三方云 SDK');
assert(!html.includes('supabase'), '不引入 supabase');

/* 2) 旧入口已废弃，新入口存在 */
assert(!html.includes('id="lbBtnFriends"'), '旧好友入口已移除');
assert(html.includes('id="lbBtnOnline"'), '联机入口存在');
assert(html.includes('id="ovOnline"'), '联机弹窗存在');
assert(html.includes('id="lbBtnBoard"'), '排行榜入口存在');
assert(html.includes('id="ovBoard"'), '排行榜弹窗存在');
assert(html.includes('id="onlineScreen"'), '联机牌桌屏存在');

/* 3) 联机仅支持掼蛋与德州（服务端权威） */
assert(html.includes("ADAPTERS") === false, '前端不内嵌服务端适配器');
assert(html.includes("data-ogame=\"guandan\"") && html.includes("data-ogame=\"holdem\""), '联机玩法为掼蛋与德州');

/* 4) 六馆入口齐全 */
['holdem', 'blackjack', 'gold', 'dice', 'diceduel', 'guandan'].forEach(g => {
  assert(html.includes('data-game="' + g + '"'), '六馆入口存在: ' + g);
});

/* 5) 单机+联机两相宜定位保留 */
assert(html.includes('纯单机'), '保留纯单机说明');
assert(html.includes('一张牌桌，六种乐趣 · 单机联机两相宜'), '大厅副标题保留');

/* 6) 排行榜覆盖六游戏 */
assert(html.includes('renderBoardGames'), '排行榜渲染存在');
assert(html.includes('friendBoard') === false, '前端不直连数据库');
assert(html.includes('/api/leaderboard'), '排行榜走 HTTP 接口');

/* 7) 道具限购前端存在 */
assert(html.includes('rank_guard') && html.includes('rank_double'), '排位道具已定义');
assert(html.includes('buyLimitReason'), '限购逻辑存在');

console.log('friend-room shell checks passed');
