'use strict';
const fs=require('fs'),assert=require('assert'),{JSDOM}=require('jsdom');
const html=fs.readFileSync(require('path').join(__dirname,'../index.html'),'utf8');
const code=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\(function \(\) \{\s*'use strict';/,'').replace(/\}\)\(\);\s*$/,'').replace(/  init\(\);/,'');
const dom=new JSDOM(html.replace(/<script>[\s\S]*?<\/script>/,''),{url:'https://v15.test',runScripts:'outside-only'}),w=dom.window;
w.setTimeout=()=>0;w.requestAnimationFrame=()=>0;w.eval(code);w.loadAllSaves();w.bindEvents();
let passed=0;
function fresh(game='holdem',mode='coins',difficulty='easy') {w.G.active=false;w.G.players=[];w.G.quickRetry=null;w.G.rankRetry=null;w.Arcade.round=null;w.player.rankedPending=null;w.player.arcade.pending=null;w.createNewSaveAt(1);w.hubGame=game;w.App.mode=mode==='ranked'?'ranked':'quick';w.App.difficulty=difficulty;w.Arcade.mode=mode;w.Arcade.difficulty=difficulty;w.Arcade.diceCount=3;if(game!=='holdem')assert(w.openArcade(game));}
function quota(){const fn=w.Storage.prototype.setItem;w.Storage.prototype.setItem=()=>{throw Error('quota');};return ()=>w.Storage.prototype.setItem=fn;}
function test(name,fn){fresh();fn();passed++;console.log('PASS '+name);}
const card=(r,s=0)=>({r,s});
function rig(cards){const f=w.shuffle;w.shuffle=()=>cards.slice().reverse();return ()=>w.shuffle=f;}
test('积分只能排位获得：金币买不到，积分可单向换金币且四馆隔离',()=>{for(const g of w.GAME_IDS){assert.equal(w.profile15(g).redeemPoints,0);assert.equal(w.profile15(g).rankPoints,0);}
  for(const n of [-1,0,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER,1,3])assert.equal(w.exchangePoints('dice','buy',n),false,'金币买积分必须被拒绝');
  assert.equal(w.player.coins,500,'金币不应减少');assert.equal(w.profile15('dice').redeemPoints,0,'积分不应增加');
  var s=w.profile15('dice');s.redeemPoints=3;                       /* 模拟排位赢来的积分 */
  assert(w.exchangePoints('dice','sell',2));assert.equal(w.player.coins,700,'2 积分 = 200 金币');
  assert.equal(s.redeemPoints,1);assert.equal(w.profile15('holdem').redeemPoints,0,'四馆积分隔离');
  assert.equal(w.profile15('dice').rankPoints,0,'兑换不影响段位分');
  assert.equal(w.exchangePoints('dice','sell',2),false,'积分不足应失败');
  for(const n of [-1,0,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER])assert.equal(w.exchangePoints('dice','sell',n),false);});
test('真实存储失败兑换完整回滚，可重试且持久',()=>{var s=w.profile15('gold');s.redeemPoints=2;
  const stop=quota();assert.equal(w.exchangePoints('gold','sell',2),false);
  assert.equal(w.player.coins,500);assert.equal(w.profile15('gold').redeemPoints,2,'回滚后积分不变');stop();
  assert(w.exchangePoints('gold','sell',2));w.loadAllSaves();
  assert.equal(w.player.coins,700);assert.equal(w.profile15('gold').redeemPoints,0);});
test('段位晋升同时奖励金币与积分，且只发未领过的新段位',()=>{var s=w.profile15('holdem');
  s.rankPoints=0;s.tierReward=0;s.redeemPoints=0;const c0=w.player.coins;
  s.rankPoints=100;assert.deepEqual(w.grantTierReward15(s),{tier:1,coins:500,points:5});
  assert.equal(w.player.coins,c0+500);assert.equal(s.redeemPoints,5);
  w.grantTierReward15(s);assert.equal(w.player.coins,c0+500),assert.equal(s.redeemPoints,5,'同段位不重复发');
  s.rankPoints=0;w.grantTierReward15(s);s.rankPoints=100;assert.equal(w.player.coins,c0+500,'掉段回升到已领段位不补发');
  s.rankPoints=700;var p=w.grantTierReward15(s);assert.equal(p.tier,4);
  assert.equal(p.coins,1200+2500+5000,'黄金+铂金+钻石一次补齐');assert.equal(p.points,12+25+50);});
test('排位只有一种模式：对手强度随段位变化',()=>{var s=w.profile15('holdem');
  s.rankPoints=0;assert.equal(w.rankedDifficultyFor('holdem'),'easy');
  s.rankPoints=100;assert.equal(w.rankedDifficultyFor('holdem'),'easy');
  s.rankPoints=250;assert.equal(w.rankedDifficultyFor('holdem'),'normal');
  s.rankPoints=450;assert.equal(w.rankedDifficultyFor('holdem'),'hard');
  s.rankPoints=700;assert.equal(w.rankedDifficultyFor('holdem'),'champion');
  s.rankPoints=1400;assert.equal(w.rankedDifficultyFor('holdem'),'champion');});
test('界面不再提供金币购买积分的入口',()=>{assert(!/id="buyPoints15"/.test(html),'不应再有金币换积分按钮');
  assert(!/购买排位积分/.test(html),'不应再有购买排位积分按钮');
  assert.equal(w.buyRankedPoints(1),false,'购买入口已关闭');});
test('四馆四档排位胜负平、下限和金币隔离',()=>{w.GAME_IDS.forEach(g=>w.GAME_LEVELS.forEach((key,i)=>{const s=w.profile15(g);s.redeemPoints=10;s.rankPoints=100;s.tierReward=w.rankTierFor(s.rankPoints);/* 视为已领过该段位奖励，便于只校验基础增减 */w.applyRankResult15(g,key,1);assert.equal(s.redeemPoints,11+i);assert.equal(s.rankPoints,100+[12,16,20,26][i]);w.applyRankResult15(g,key,-1);assert.equal(s.redeemPoints,10);assert.equal(s.rankPoints,100+[12,16,20,26][i]-[5,7,9,12][i]);const before=JSON.stringify([s.redeemPoints,s.rankPoints]);w.applyRankResult15(g,key,0);assert.equal(JSON.stringify([s.redeemPoints,s.rankPoints]),before);s.redeemPoints=s.rankPoints=0;w.applyRankResult15(g,key,-1);assert.equal(s.rankPoints,0);assert.equal(s.redeemPoints,0);}));assert.equal(w.player.coins,500);});
test('真实21点排位天然胜、平局、加倍与重试幂等',()=>{fresh('blackjack','ranked');let done=rig([card(14),card(13),card(9),card(8)]);w.blackjackStart(20);done();assert.equal(w.player.coins,500);assert.equal(w.profile15('blackjack').redeemPoints,1);assert.equal(w.arcadeBalance(),530);assert.equal(w.profile15('blackjack').metrics.natural,1);done=rig([card(14),card(13),card(14),card(12)]);w.blackjackStart(20);done();assert.equal(w.profile15('blackjack').redeemPoints,1);done=rig([card(5),card(6),card(10),card(7),card(10)]);w.blackjackStart(20);done();const stop=quota();w.blackjackHit(true);assert.equal(w.Arcade.round.stake,20);assert.equal(w.arcadeBalance(),480);stop();w.blackjackHit(true);assert.equal(w.profile15('blackjack').redeemPoints,2);assert.equal(w.player.coins,500);assert.equal(w.profile15('blackjack').metrics.doublewin,1);assert.equal(w.arcadeSettle(80,'duplicate'),false);});
test('排位结算失败保留待结算、重试仅加一次',()=>{fresh('blackjack','ranked');const done=rig([card(10),card(8),card(10),card(7)]);w.blackjackStart(20);done();const stop=quota();w.blackjackStand();assert(w.Arcade.round.retry);assert(w.player.arcade.pending);assert.equal(w.profile15('blackjack').redeemPoints,0);assert.equal(w.profile15('blackjack').metrics.hands||0,0);stop();w.arcadeDispatch('retry');assert.equal(w.profile15('blackjack').redeemPoints,1);assert.equal(w.profile15('blackjack').metrics.hands,1);assert.equal(w.player.arcade.pending,null);assert.equal(w.player.coins,500);});
test('跨游戏拒绝不会重置当前排位比赛筹码',()=>{fresh('blackjack','ranked');const done=rig([card(10),card(8),card(10),card(7)]);w.blackjackStart(20);done();assert.equal(w.arcadeBalance(),480);assert.equal(w.openArcade('dice'),false);assert.equal(w.arcadeBalance(),480);assert.equal(w.Arcade.game,'blackjack');});
test('刷新排位未完局只扣一次，不授予完成任务',()=>{fresh('blackjack','ranked');w.profile15('blackjack').redeemPoints=3;w.profile15('blackjack').rankPoints=20;const done=rig([card(10),card(8),card(10),card(7)]);w.blackjackStart(20);done();w.Arcade.round=null;w.arcadeRecover();w.arcadeRecover();assert.equal(w.player.coins,500);assert.equal(w.profile15('blackjack').redeemPoints,2);assert.equal(w.profile15('blackjack').rankPoints,15);assert.equal(w.profile15('blackjack').metrics.hands||0,0);assert.equal(w.profile15('blackjack').rankedHands,1);});
test('旧档迁移保留资产已领奖与旧门票，不增可兑换资产',()=>{const p=w.oldCreatePlayer15('legacy');delete p.games;delete p.growthVersion;p.version=14;p.coins=1234;p.rankedPoints=99;p.rankPoints=150;p.rankPeak=1;p.totalHands=50;p.achievementClaims[w.V14_ACH[0].id]=true;p.dailyTasks={date:w.todayStr(),ids:['old1','old2']};p.dailyClaimed={old1:true,old2:true};p.dailyProgress={};p.weekly={week:w.weekKeyOf(w.todayStr()),progress:{},claimed:{}};p.weekly.claimed[w.WEEKLY_TASKS[0].id]=true;w.migratePlayer(p);assert.equal(p.version,15);assert.equal(p.coins,1234);assert.equal(p.legacyEntryCredits,99);assert.equal(p.games.holdem.rankPoints,150);assert(w.GAME_IDS.every(g=>p.games[g].redeemPoints===0));assert.equal(Object.keys(p.dailyClaimed).length,2);assert(p.weekly.claimed[w.WEEKLY_TASKS[0].id]);assert(p.achievementClaims[w.V14_ACH[0].id]);const once=JSON.stringify(p);w.migratePlayer(p);assert.equal(JSON.stringify(p),once);});
test('日常240、周常1242、月度4000、1000成就各250且预算不增加',()=>{assert.equal(w.TASK_POOL.reduce((n,t)=>n+t.reward,0),240);assert.equal(w.WEEKLY_TASKS.reduce((n,t)=>n+t.reward,0),1242);assert.equal(w.MONTHLY_TASKS.reduce((n,t)=>n+t.reward,0),4000);assert.equal(w.MONTHLY_TASKS.length,10);assert.equal(w.ACHIEVEMENTS.reduce((n,t)=>n+t.reward,0),w.ACH_REWARD_BUDGET);w.GAME_IDS.forEach(g=>assert.equal(w.ACHIEVEMENTS.filter(a=>a.game===g).length,200));assert.equal(new Set(w.ACHIEVEMENTS.map(a=>a.id)).size,1000);w.recordGrowth15('dice',{hands:3,wins:2,five:3,multi:3},'hard');assert.equal(w.player.dailyProgress.d15_dice,3);assert.equal(w.player.dailyProgress.d15_any,2);assert.equal(w.player.dailyProgress.d15_holdem||0,0);assert.equal(w.profile15('dice').levels.hard,1);assert.equal(w.profile15('holdem').metrics.hands||0,0);});
test('领取失败回滚标志及金币，任务刷新和成就筛选实际生效',()=>{w.recordGrowth15('dice',{hands:20},'easy');const stop=quota();assert.equal(w.claimDaily('d15_dice'),false);assert.equal(w.player.coins,500);assert(!w.player.dailyClaimed.d15_dice);stop();assert(w.claimDaily('d15_dice'));assert.equal(w.player.coins,500+w.TASK_POOL[0].reward);w.achGame15='dice';w.achFilter='all';w.renderAchList();assert([...w.document.querySelectorAll('.ach-item')].every(e=>e.textContent.includes('猜骰子')));w.achGame15='all';});
test('枚举3骰216及5骰7776种分布和豹子，赔率不超概率上限',()=>{for(const count of [3,5]){const d=w.diceDistribution(count);assert.equal(d.total,6**count);assert.equal(d.hits.any,6);assert.equal(d.hits.small,count===3?105:3885);assert.equal(d.hits.big,d.hits.small);assert.equal(Object.entries(d.hits).filter(([k])=>k.startsWith('sum')).reduce((n,[k,v])=>n+v,0),d.total);for(const [choice,hits] of Object.entries(d.hits)){const m=w.diceMultiplier(count,choice);assert(m>=1);assert(m*hits<=d.total);if(!['small','big'].includes(choice))assert(m*hits/d.total<=0.95);}}assert.equal(w.diceResult([1,1,1,2,3],'any').win,false);assert.equal(w.diceResult([2,2,2,2,2],'triple2').win,true);assert.equal(w.diceResult([6,6,6,6,6],'big').win,false);});
test('五骰多项叠加返还、重复下注合并、总投入限制',()=>{fresh('dice');w.Arcade.diceCount=5;assert(w.diceAddBet('any',10));assert(w.diceAddBet('sum10',10));assert(w.diceAddBet('triple2',10));assert(w.diceAddBet('small',10));assert(w.diceAddBet('small',10));assert.equal(w.Arcade.basket.length,4);assert.equal(w.diceAddBet('big',60),false);const random=w.randomInt;w.randomInt=n=>n===6?1:123;assert(w.diceRollBasket());w.randomInt=random;const payout=10*(w.diceMultiplier(5,'any')+w.diceMultiplier(5,'sum10')+w.diceMultiplier(5,'triple2'));assert.equal(w.player.coins,500-50+payout);assert.equal(w.Arcade.round.bets.find(b=>b.choice==='small').payout,0);assert.equal(w.profile15('dice').metrics.exactwin,1);assert.equal(w.arcadeSettle(payout,'duplicate'),false);});
test('排位为单一模式不再出现难度页，自由场仍保留四档',()=>{const start=w.startGame;w.startGame=()=>{w.G.active=true;};for(const g of w.GAME_IDS){
  w.G.active=false;w.Arcade.round=null;w.player.rankedPending=null;w.player.arcade.pending=null;
  w.document.querySelector('[data-game="'+g+'"]').click();w.document.getElementById('lbStartBtn').click();assert.equal(w.App.screen,'mode');
  /* 自由场：仍然进入四档难度页 */
  w.document.querySelector('.mode-card.quick').click();assert.equal(w.App.screen,'difficulty');
  assert.equal(w.document.querySelectorAll('#diffBody .diff-card').length,4);
  w.document.querySelector('#diffBody .diff-card').click();
  /* 排位：只有一种模式，由段位决定对手强度，直接开局 */
  w.G.active=false;w.Arcade.round=null;w.player.rankedPending=null;w.player.arcade.pending=null;
  w.document.querySelector('[data-game="'+g+'"]').click();w.document.getElementById('lbStartBtn').click();
  w.document.querySelector('.mode-card.ranked').click();
  assert.notEqual(w.App.screen,'difficulty','排位不应再要求选择难度');
  if(g!=='holdem'){assert.equal(w.App.screen,'arcade');assert.equal(w.Arcade.mode,'ranked');assert.equal(w.Arcade.game,g);}
  else assert.equal(w.App.difficulty,w.rankedDifficultyFor(g),'排位难度由段位决定');
 }w.startGame=start;});
test('段位面板展示当前游戏，不再宣称旧门票或升段金币',()=>{w.hubGame='dice';w.profile15('dice').rankPoints=99;w.profile15('dice').redeemPoints=7;w.renderRank();const text=w.document.getElementById('rankPanel').textContent;assert(text.includes('猜骰子'));assert(text.includes('99'));assert(text.includes('不收门票'));assert(!text.includes('首次晋升奖励'));});
async function holdFinish(mode,fail){fresh('holdem',mode);w.App.mode=mode==='ranked'?'ranked':'quick';w.initPlayers();w.G.active=true;w.G.handSettled=false;w.G.handOver=false;w.G.settling=false;w.G.stage=4;w.G.community=[card(2),card(3,1),card(7,2),card(8,3),card(11)];w.G.pot=40;w.G.session={hands:0,wins:0,net:0};w.G.players.forEach((p,i)=>{p.hole=[card(14,i),card(13,i)];p.chips=490;p.totalBet=10;p.folded=i>0;p._v=null;});w.G.growthStart15=500;if(mode==='ranked')w.player.rankedPending={id:'rank-test',game:'holdem',difficulty:'easy'};const sleep=w.sleep;w.sleep=async()=>{};const stop=fail?quota():()=>{};await w.finishHand();stop();w.sleep=sleep;if(fail){assert(!w.G.handSettled);assert.equal(w.player.coins,500);assert.equal(w.profile15('holdem').metrics.hands||0,0);w.renderControls();const btn=w.document.querySelector('#bottomBar button');assert(btn);assert(btn.textContent.includes('重试'));if(mode==='ranked'){const r=w.G.rankRetry;assert(w.finishHoldemRank15(r.winnings,r.pot,r.net));}else btn.click();}assert(w.G.handSettled);assert.equal(w.G.players[0].chips,530);assert.equal(w.player.coins,mode==='ranked'?500:530);assert.equal(w.profile15('holdem').metrics.hands,1);assert.equal(w.G.session.hands,1);if(mode==='ranked'){assert.equal(w.profile15('holdem').redeemPoints,1);assert.equal(w.profile15('holdem').rankPoints,12);assert.equal(w.player.rankedPending,null);}w.G.active=false;}
(async()=>{for(const mode of ['coins','ranked'])for(const fail of [false,true]){await holdFinish(mode,fail);passed++;console.log('PASS 德州真实结算 '+mode+' 保存失败='+fail+' 筹码不重复发放');}fresh();w.player.rankedPending={game:'holdem',difficulty:'hard'};w.profile15('holdem').redeemPoints=9;w.profile15('holdem').rankPoints=30;w.recoverRanked15();w.recoverRanked15();assert.equal(w.profile15('holdem').redeemPoints,6);assert.equal(w.profile15('holdem').rankPoints,21);assert.equal(w.player.coins,500);passed++;console.log('PASS 德州刷新恢复幂等');console.log('TOTAL '+passed);dom.window.close();})().catch(e=>{console.error(e);dom.window.close();process.exitCode=1;});
