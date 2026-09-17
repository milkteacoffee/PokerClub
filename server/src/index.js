'use strict';
/**
 * 牌友小馆后端主入口：
 *   HTTP  : 排行榜 / 好友 / 健康检查（JSON API，供纯单机模式拉榜单）
 *   WebSocket: 好友开房联机（/ws）
 *
 * 认证模型（按需求选择「昵称 + 设备ID」）：
 *   客户端首次生成 UUID 存 localStorage，后续所有请求带 X-Device-Id。
 *   服务端首次见到该设备即建档，昵称可随时改。
 */
const http = require('http');
const { WebSocketServer } = require('ws');
const config = require('./config');
const { Store, GAMES } = require('./store');
const { RoomManager, ADAPTERS } = require('./rooms');
const crypto = require('crypto');

const store = new Store(config.dataDir);
const rooms = new RoomManager(store);

/* claim 接口限流：ip -> [最近60秒内的请求时间戳] */
const claimHits = new Map();

const GAME_NAMES = {
  holdem: '德州扑克', blackjack: '21点', gold: '炸金花',
  dice: '猜骰子', diceduel: '骰子比大小', guandan: '掼蛋',
};

/* ---------------- 工具 ---------------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': config.allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, X-Device-Id',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); }
    });
  });
}

function validDeviceId(id) {
  return typeof id === 'string' && id.length >= 8 && id.length <= config.auth.deviceIdMaxLen && /^[A-Za-z0-9_-]+$/.test(id);
}

function cleanNick(n) {
  const s = String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, config.auth.nicknameMaxLen);
  return s || '牌友';
}

/* ---------------- HTTP 路由 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const path = url.pathname;
  const deviceId = req.headers['x-device-id'];
  const method = req.method;

  if (method === 'OPTIONS') return json(res, 204, {});

  try {
    /* 健康检查 */
    if (path === '/health' || path === '/api/health') {
      return json(res, 200, { ok: true, uptime: Math.floor(process.uptime()), ...rooms.stats(), memoryMB: Math.round(process.memoryUsage().rss / 1048576) });
    }

    if (path === '/api/admin-panel' && method === 'GET') {
      var page = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>牌友小馆 · 管理控制台</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0b1118; --card:#121b26; --card2:#0f1822; --line:rgba(255,255,255,.07);
  --txt:#c8d2dc; --muted:#5a6a76; --gold:#d4a847; --gold2:#f2c14e; --green:#6cc4a1; --red:#e05656; --blue:#7fa7d8;
}
html,body{background:var(--bg);color:var(--txt);font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;-webkit-font-smoothing:antialiased}
button{font-family:inherit;cursor:pointer;border:none}
input,select{font-family:inherit;outline:none}
::placeholder{color:#4d5a66}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px}

/* ── 登录 ── */
.auth-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.auth-card{width:100%;max-width:400px;background:linear-gradient(170deg,#141f2c,#0e1722);border:1px solid var(--line);border-radius:20px;padding:38px 34px;box-shadow:0 24px 60px rgba(0,0,0,.45)}
.brand-row{display:flex;align-items:center;gap:12px;justify-content:center;margin-bottom:6px}
.logo-mark{width:44px;height:44px;border-radius:13px;background:linear-gradient(150deg,#f0d79a,#cfa85b);display:flex;align-items:center;justify-content:center;font-size:22px;color:#2a1d0c;font-weight:900;box-shadow:0 6px 18px rgba(212,168,71,.35)}
.auth-title{font-size:19px;font-weight:800;color:#e8d5a3;letter-spacing:2px}
.auth-sub{text-align:center;font-size:12px;color:var(--muted);margin-bottom:26px;letter-spacing:4px}
.field{margin-bottom:14px}
.field label{display:block;font-size:11.5px;color:#7d8b96;margin-bottom:6px;letter-spacing:1px}
.field input{width:100%;background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:10px;color:#dbe6ef;padding:12px 14px;font-size:13.5px;transition:border .15s, box-shadow .15s}
.field input:focus{border-color:rgba(212,168,71,.55);box-shadow:0 0 0 3px rgba(212,168,71,.12)}
.btn-gold{width:100%;padding:13px;border-radius:12px;font-size:14.5px;font-weight:800;letter-spacing:2px;color:#2a1d0c;background:linear-gradient(150deg,#f0d79a,#cfa85b);box-shadow:0 8px 20px rgba(212,168,71,.3);transition:transform .12s, box-shadow .12s}
.btn-gold:hover{transform:translateY(-1px);box-shadow:0 10px 26px rgba(212,168,71,.4)}
.btn-gold:active{transform:translateY(0)}
.auth-err{min-height:18px;text-align:center;font-size:12px;color:#ff8a8a;margin-top:10px}
.auth-foot{text-align:center;font-size:11px;color:#4d5a66;margin-top:18px;line-height:1.8}

/* ── 顶栏 ── */
.topbar{position:sticky;top:0;z-index:50;background:rgba(11,17,24,.88);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.topbar .wrap{display:flex;align-items:center;gap:14px;height:62px}
.brand{display:flex;align-items:center;gap:10px}
.brand .logo-mark{width:34px;height:34px;font-size:17px;border-radius:10px}
.brand b{color:#e8d5a3;font-size:15.5px;letter-spacing:1px}
.brand em{font-style:normal;font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:20px;padding:3px 10px;letter-spacing:1px}
.tb-actions{margin-left:auto;display:flex;align-items:center;gap:10px}
.chip{font-size:11.5px;color:#9fe8bd;background:rgba(108,196,161,.12);border:1px solid rgba(108,196,161,.3);border-radius:20px;padding:4px 12px}
.tb-btn{background:rgba(255,255,255,.04);color:var(--txt);border:1px solid var(--line);border-radius:9px;padding:7px 14px;font-size:12px;transition:all .15s}
.tb-btn:hover{background:rgba(240,215,154,.12);color:#e8d5a3}
.tb-btn.danger:hover{background:rgba(224,86,86,.15);color:#ff9a9a}

/* ── 主区 ── */
main{padding:22px 0 60px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:12px;margin-bottom:18px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px;position:relative;overflow:hidden;transition:transform .15s,border-color .15s}
.stat:hover{transform:translateY(-2px);border-color:rgba(212,168,71,.35)}
.stat .ic{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;margin-bottom:10px;background:rgba(212,168,71,.12);color:var(--gold2)}
.stat .v{font-size:26px;font-weight:800;color:#e8d5a3;line-height:1.1;font-variant-numeric:tabular-nums}
.stat .l{font-size:11.5px;color:var(--muted);margin-top:4px;letter-spacing:.5px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px 22px;margin-bottom:18px}
.card>h3{font-size:13.5px;color:#d4c5a9;margin-bottom:14px;letter-spacing:1.5px;font-weight:700;display:flex;align-items:center;gap:8px}
.card>h3::before{content:'';width:3px;height:14px;border-radius:2px;background:linear-gradient(180deg,#f0d79a,#cfa85b)}
.grid2{display:grid;grid-template-columns:1.4fr 1fr;gap:18px}
@media (max-width:860px){.grid2{grid-template-columns:1fr}}
.chart{width:100%;height:210px;display:block}
.legend{display:flex;gap:18px;font-size:11.5px;color:#8fa0b4;margin-top:8px}
.legend i{display:inline-block;width:12px;height:3px;border-radius:2px;margin-right:6px;vertical-align:middle}
.ret-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:12px}
.ret-card{text-align:center;padding:16px 8px;border-radius:14px;background:rgba(108,196,161,.06);border:1px solid rgba(108,196,161,.18)}
.ret-card .rv{font-size:24px;font-weight:800;color:var(--green)}
.ret-card .rv.pend{color:#5a6a76;font-size:16px}
.ret-card .rl{font-size:12px;color:#8fa0b4;margin-top:4px}
.muted{font-size:11px;color:#4d5a66;line-height:1.7}

/* ── 表格 ── */
.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.toolbar input{flex:1;min-width:200px;max-width:360px;background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:10px;color:var(--txt);padding:10px 14px;font-size:13px}
.toolbar input:focus{border-color:rgba(212,168,71,.55)}
.toolbar select{background:rgba(255,255,255,.04);border:1px solid var(--line);color:var(--txt);border-radius:10px;padding:9px 12px;font-size:12.5px}
.btn{background:rgba(240,215,154,.12);color:#e8d5a3;border:1px solid rgba(212,168,71,.25);border-radius:10px;padding:9px 16px;font-size:12.5px;font-weight:600;transition:all .15s}
.btn:hover{background:rgba(240,215,154,.2)}
.tbl-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:14px}
table{width:100%;border-collapse:collapse;min-width:720px}
th{text-align:left;padding:11px 14px;font-size:11px;color:#7d8b96;font-weight:600;letter-spacing:1px;background:rgba(255,255,255,.02);border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:12px 14px;font-size:12.5px;border-bottom:1px solid rgba(255,255,255,.03);white-space:nowrap;vertical-align:middle}
tbody tr{transition:background .12s}
tbody tr:hover{background:rgba(255,255,255,.025)}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:#93a5b5}
.avatar-dot{width:30px;height:30px;border-radius:50%;background:linear-gradient(150deg,#2c3e50,#1a2632);display:inline-flex;align-items:center;justify-content:center;font-size:13px;color:#e8d5a3;font-weight:700;flex:none}
.pcell{display:flex;align-items:center;gap:10px}
.pcell .pn{font-weight:600;color:#dbe6ef}
.pcell .pu{font-family:ui-monospace,monospace;font-size:10.5px;color:#7d8b96}
.coin-b{display:inline-flex;align-items:center;gap:4px;font-weight:700;color:#8fd6b0}
.copybtn{padding:4px 10px;font-size:11px;border-radius:7px;background:rgba(240,215,154,.1);color:#e8d5a3;border:none;cursor:pointer}
.copybtn:hover{background:rgba(240,215,154,.2)}
.mini{padding:5px 12px;font-size:11.5px;border-radius:8px;background:rgba(240,215,154,.1);color:#e8d5a3;border:none;cursor:pointer}
.mini:hover{background:rgba(240,215,154,.2)}
.pager{display:flex;gap:8px;align-items:center;margin-top:14px;font-size:12px;color:#8fa0b4}
.pager .sp{margin-left:auto}
.pager button{padding:7px 14px;border-radius:9px;background:rgba(240,215,154,.1);color:#e8d5a3;border:none;font-size:12px;cursor:pointer}
.pager button:disabled{opacity:.3;cursor:default}
.code-tag{font-family:ui-monospace,monospace;font-weight:700;color:#f2c14e;letter-spacing:1px}

/* ── 兑换码 ── */
.gen-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.gen-row input{width:150px;background:rgba(255,255,255,.04);border:1px solid var(--line);color:var(--txt);border-radius:10px;padding:10px 14px;font-size:13px}
.lastcode{margin:6px 0 2px;min-height:22px;font-size:14px;color:#f2c14e;font-weight:700;letter-spacing:1px}

/* ── 弹窗 / toast ── */
.modal-mask{position:fixed;inset:0;background:rgba(4,8,12,.72);z-index:200;display:none;align-items:center;justify-content:center;padding:20px}
.modal-mask.show{display:flex}
.modal{width:100%;max-width:400px;background:linear-gradient(170deg,#141f2c,#0e1722);border:1px solid rgba(212,168,71,.25);border-radius:18px;padding:26px;box-shadow:0 24px 60px rgba(0,0,0,.5)}
.modal h4{font-size:15px;color:#e8d5a3;margin-bottom:4px}
.modal .sub{font-size:11.5px;color:var(--muted);margin-bottom:14px}
.modal .mrow{margin-bottom:12px}
.modal .mrow label{display:block;font-size:11px;color:#7d8b96;margin-bottom:5px}
.modal input{width:100%;background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:10px;color:#dbe6ef;padding:11px 13px;font-size:13px}
.modal .macts{display:flex;gap:10px;margin-top:16px}
.modal .macts button{flex:1;padding:11px;border-radius:10px;font-size:13px;font-weight:700}
.m-cancel{background:rgba(255,255,255,.05);color:var(--txt);border:1px solid var(--line)}
.m-ok{background:linear-gradient(150deg,#f0d79a,#cfa85b);color:#2a1d0c;border:none}
#toast{position:fixed;top:20px;right:20px;z-index:400;display:flex;flex-direction:column;gap:8px}
.toast-item{background:linear-gradient(170deg,#18242f,#101a24);border:1px solid rgba(212,168,71,.3);color:#e8d5a3;font-size:12.5px;padding:11px 16px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.4);animation:tin .25s}
.toast-item.err{border-color:rgba(224,86,86,.4);color:#ffb0b0}
@keyframes tin{from{opacity:0;transform:translateX(30px)}to{opacity:1;transform:none}}
</style>
</head>
<body>

<div id="loginView" class="auth-wrap">
  <div class="auth-card">
    <div class="brand-row"><div class="logo-mark">♠</div></div>
    <div class="auth-title" style="text-align:center">牌友小馆</div>
    <div class="auth-sub">管 理 控 制 台</div>
    <div class="field"><label>管理员账号</label><input id="au" placeholder="请输入管理员账号" autocomplete="username"></div>
    <div class="field"><label>密码</label><input id="ap" type="password" placeholder="请输入密码" autocomplete="current-password"></div>
    <button class="btn-gold" onclick="login()">登 录</button>
    <div class="auth-err" id="loginErr"></div>
    <div class="auth-foot">仅限授权管理人员使用<br>所有操作均有记录</div>
  </div>
</div>

<div id="mainView" style="display:none">
  <header class="topbar"><div class="wrap">
    <div class="brand"><div class="logo-mark">♠</div><b>牌友小馆</b><em>管理控制台</em></div>
    <div class="tb-actions">
      <span class="chip">● 管理员</span>
      <button class="tb-btn" onclick="refreshAll()">刷新数据</button>
      <button class="tb-btn danger" onclick="logout()">退出</button>
    </div>
  </div></header>
  <main class="wrap">

    <div class="stats">
      <div class="stat"><div class="ic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/></svg></div><div class="v" id="stP">-</div><div class="l">注册玩家</div></div>
      <div class="stat"><div class="ic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="9" stroke-dasharray="3 3"/></svg></div><div class="v" id="stO">-</div><div class="l">在线</div></div>
      <div class="stat"><div class="ic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/></svg></div><div class="v" id="stG">-</div><div class="l">对局中</div></div>
      <div class="stat"><div class="ic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 20h14"/></svg></div><div class="v" id="stN">-</div><div class="l">今日新增</div></div>
      <div class="stat"><div class="ic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17l5-6 4 3 5-8 4 5"/></svg></div><div class="v" id="stA">-</div><div class="l">24h 活跃</div></div>
      <div class="stat"><div class="ic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/></svg></div><div class="v" id="stM">-</div><div class="l">今日对局</div></div>
      <div class="stat"><div class="ic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 8l6 4-6 4z"/></svg></div><div class="v" id="stC">-</div><div class="l">兑换码</div></div>
    </div>

    <div class="grid2">
      <section class="card">
        <h3>玩家趋势 · 最近 14 天</h3>
        <svg class="chart" id="trendChart" viewBox="0 0 720 210" preserveAspectRatio="none"></svg>
        <div class="legend">
          <span><i style="background:#e8d5a3"></i>新增玩家</span>
          <span><i style="background:#6cc4a1"></i>活跃玩家</span>
          <span><i style="background:#7fa7d8"></i>对局数</span>
        </div>
      </section>
      <section class="card">
        <h3>留存率 · 按注册分群</h3>
        <div class="ret-grid">
          <div class="ret-card"><div class="rv" id="retD1">-</div><div class="rl">次日留存</div></div>
          <div class="ret-card"><div class="rv" id="retD7">-</div><div class="rl">7 日留存</div></div>
          <div class="ret-card"><div class="rv" id="retD30">-</div><div class="rl">30 日留存</div></div>
        </div>
        <div class="ret-card" style="margin-bottom:10px"><div class="rv" id="retSize" style="color:#e8d5a3">-</div><div class="rl">近 30 天样本</div></div>
        <p class="muted">留存 = 注册后第 N 天当天有打开游戏 / 保存资料 / 联机行为。自然日未到达的群组显示「待累计」。数据自服务端上线（2026-09-15）起统计。</p>
      </section>
    </div>

    <section class="card">
      <h3>玩家管理</h3>
      <div class="toolbar">
        <input id="pSearch" placeholder="搜索昵称 / 玩家号 / 设备ID" oninput="searchTO()">
        <select id="pSize" onchange="changePageSize()"><option value="10">10 条/页</option><option value="20" selected>20 条/页</option><option value="50">50 条/页</option></select>
        <button class="btn" onclick="loadPlayers(1)">搜索</button>
        <span class="muted" id="pTotal" style="margin-left:auto"></span>
      </div>
      <div class="tbl-wrap">
        <table><thead><tr><th>玩家</th><th>玩家号</th><th>金币</th><th>称号/成就</th><th>签到</th><th>设备ID</th><th>最后在线</th><th>操作</th></tr></thead><tbody id="pList"></tbody></table>
      </div>
      <div class="pager">
        <button id="pPrev" onclick="gotoPage(-1)">上一页</button>
        <button id="pNext" onclick="gotoPage(1)">下一页</button>
        <span class="sp" id="pInfo">-</span>
      </div>
    </section>

    <section class="card">
      <h3>兑换码</h3>
      <div class="gen-row">
        <input id="cCoins" type="number" placeholder="面额金币" style="width:150px">
        <input id="cUses" type="number" value="1" placeholder="次数" style="width:110px">
        <button class="btn" onclick="mkcode()">生成兑换码</button>
        <button class="btn" onclick="copyAllCodes()">一键复制全部</button>
      </div>
      <div class="lastcode" id="lastCode"></div>
      <div class="tbl-wrap">
        <table><thead><tr><th>兑换码</th><th>面额</th><th>已用/上限</th><th>创建时间</th><th>操作</th></tr></thead><tbody id="codeList"></tbody></table>
      </div>
    </section>

  </main>
</div>

<div id="modalMask" class="modal-mask">
  <div class="modal">
    <h4>发放金币</h4>
    <div class="sub">金币将进入对方邮箱，对方登录后领取</div>
    <div class="mrow"><label>目标玩家</label><input id="gName" readonly></div>
    <div class="mrow"><label>设备ID</label><input id="gDev" readonly style="font-family:monospace;font-size:11.5px"></div>
    <div class="mrow"><label>金币数量</label><input id="gCoins" type="number" placeholder="请输入金额"></div>
    <div class="macts"><button class="m-cancel" onclick="closeModal()">取消</button><button class="m-ok" onclick="doGrant()">确认发放</button></div>
  </div>
</div>

<div id="toast"></div>

<script>
var TK = localStorage.getItem('admTK') || '';
function api(m, p, b) {
  return fetch('/_poker' + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TK }, body: b ? JSON.stringify(b) : undefined }).then(function (r) {
    if (r.status === 401) { var j = { ok: false, msg: '登录已过期，请重新登录' }; forceLogin(j.msg); return j; }
    return r.json();
  });
}
function toast(msg, err) {
  var box = document.getElementById('toast');
  var el = document.createElement('div');
  el.className = 'toast-item' + (err ? ' err' : '');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(function () { el.remove(); }, 2600);
}
function needLogin(j) { if (j && j.ok === false && /登录/.test(j.msg || '')) { forceLogin(j.msg); return true; } return false; }
function forceLogin(msg) { TK = ''; localStorage.removeItem('admTK'); showLogin(); var e = document.getElementById('loginErr'); if (e) e.textContent = msg || ''; }
function showLogin() { document.getElementById('loginView').style.display = 'flex'; document.getElementById('mainView').style.display = 'none'; }
function showMain() { document.getElementById('loginView').style.display = 'none'; document.getElementById('mainView').style.display = 'block'; }
function login() {
  api('POST', '/api/admin/login', { user: document.getElementById('au').value, password: document.getElementById('ap').value }).then(function (j) {
    if (j.ok) { TK = j.token; localStorage.setItem('admTK', TK); showMain(); refreshAll(); toast('欢迎回来'); }
    else document.getElementById('loginErr').textContent = j.msg || '账号或密码不正确';
  });
}
function logout() { TK = ''; localStorage.removeItem('admTK'); showLogin(); }
function refreshAll() { api('GET', '/api/admin/stats').then(paintStats); loadTrend(); loadRetention(); loadPlayers(1); loadCodes(); }
function ts(t) { if (!t) return '-'; var d = new Date(t); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function copyTxt(t, btn) { try { navigator.clipboard.writeText(t).then(function () { if (btn) { var o = btn.textContent; btn.textContent = '已复制'; setTimeout(function () { btn.textContent = o; }, 900); } else toast('已复制'); }, function () { toast('复制失败', true); }); } catch (e) { toast('复制失败', true); } }

function paintStats(j) {
  if (!j || !j.ok) return;
  var m = { stP: j.totalPlayers, stO: j.online, stG: j.playing, stN: j.newToday, stA: j.activeToday, stM: j.matchesToday, stC: j.totalCodes };
  Object.keys(m).forEach(function (id) { var e = document.getElementById(id); if (e) e.textContent = fmt(m[id]); });
}
function sparkPath(vals, max, w, h, pad) {
  var n = vals.length; if (n < 2) return '';
  var step = (w - pad * 2) / (n - 1), out = [];
  for (var i = 0; i < n; i++) { var x = pad + i * step; var y = pad + (h - pad * 2) * (1 - (vals[i] / (max || 1))); out.push((i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)); }
  return out.join(' ');
}
function drawTrend(rows) {
  var svg = document.getElementById('trendChart'); if (!svg || !rows || !rows.length) return;
  var W = 720, H = 210, pad = 26;
  var nb = rows.map(r => r.newPlayers || 0), ab = rows.map(r => r.active || 0), mb = rows.map(r => r.matches || 0);
  var max = Math.max.apply(null, nb.concat(ab, mb).concat([1]));
  var g = [];
  for (var k = 0; k <= 4; k++) {
    var y = pad + (H - pad * 2) * k / 4, val = Math.round(max * (1 - k / 4));
    g.push('<line x1="' + pad + '" y1="' + y + '" x2="' + (W - pad) + '" y2="' + y + '" stroke="rgba(255,255,255,.06)"/>');
    g.push('<text x="2" y="' + (y + 4) + '" fill="#5a6a76" font-size="10">' + val + '</text>');
  }
  var step = (W - pad * 2) / Math.max(1, rows.length - 1);
  for (var i = 0; i < rows.length; i++) { if (rows.length > 10 && i % 2) continue; g.push('<text x="' + (pad + i * step) + '" y="' + (H - 6) + '" fill="#5a6a76" font-size="10" text-anchor="middle">' + rows[i].label + '</text>'); }
  var series = [['#7fa7d8', mb], ['#6cc4a1', ab], ['#e8d5a3', nb]];
  for (var s = 0; s < series.length; s++) {
    var d = sparkPath(series[s][1], max, W, H, pad);
    if (d) g.push('<path d="' + d + ' L' + (W - pad) + ' ' + (H - pad) + ' L' + pad + ' ' + (H - pad) + ' Z" fill="' + series[s][0] + '" opacity=".06"/>');
    if (d) g.push('<path d="' + d + '" fill="none" stroke="' + series[s][0] + '" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>');
    for (var q = 0; q < series[s][1].length; q++) {
      var xq = pad + q * step, yq = pad + (H - pad * 2) * (1 - (series[s][1][q] / max));
      g.push('<circle cx="' + xq.toFixed(1) + '" cy="' + yq.toFixed(1) + '" r="2.4" fill="' + series[s][0] + '"/>');
    }
  }
  svg.innerHTML = g.join('');
}
function loadTrend() { api('GET', '/api/admin/trend?days=14').then(function (j) { if (needLogin(j)) return; if (j.ok) drawTrend(j.trend || []); }); }
function loadRetention() {
  api('GET', '/api/admin/retention?days=30').then(function (j) {
    if (needLogin(j)) return;
    if (!j.ok) return;
    var o = (j.retention || {}).overall || {};
    [['retD1', o.d1], ['retD7', o.d7], ['retD30', o.d30]].forEach(function (kv) {
      var e = document.getElementById(kv[0]); if (!e) return;
      if (kv[1] === null || kv[1] === undefined) { e.textContent = '待累计'; e.className = 'rv pend'; }
      else { e.textContent = kv[1] + '%'; e.className = 'rv'; }
    });
    var sz = document.getElementById('retSize'); if (sz) sz.textContent = fmt((j.retention || {}).overall ? o.size : 0) || 0;
    if (sz) sz.textContent = fmt(o.size || 0);
  });
}
var PG = { page: 1, size: 20, pages: 1, total: 0 };
function gotoPage(d) { var p = PG.page + d; if (p < 1 || p > PG.pages) return; loadPlayers(p); }
function changePageSize() { PG.size = Number(document.getElementById('pSize').value) || 20; loadPlayers(1); }
function loadPlayers(page) {
  var q = document.getElementById('pSearch').value;
  var pg = page || 1;
  api('GET', '/api/admin/players?search=' + encodeURIComponent(q) + '&page=' + pg + '&size=' + PG.size).then(function (j) {
    if (needLogin(j)) return;
    if (!j.ok) return;
    PG.page = j.page || 1; PG.pages = j.pages || 1; PG.total = j.total || 0;
    var tb = document.getElementById('pList');
    var list = j.list || [];
    tb.innerHTML = list.length ? list.map(function (p) {
      var first = (p.nickname || '?').charAt(0).toUpperCase();
      return '<tr>'
        + '<td><div class="pcell"><span class="avatar-dot">' + esc(first) + '</span><div><div class="pn">' + esc(p.nickname || '-') + '</div><div class="pu">' + esc(p.user_code || '-') + '</div></div></div></td>'
        + '<td><span class="code-tag">' + esc(p.user_code || '-') + '</span> <button class="copybtn" data-copy="' + esc(p.user_code || '') + '">复制</button></td>'
        + '<td><span class="coin-b">● ' + fmt(p.coins || 0) + '</span></td>'
        + '<td>' + (p.title_count || 0) + ' / ' + (p.ach_count || 0) + ' · 签' + (p.checkin_days || 0) + '天</td>'
        + '<td class="mono" title="' + esc(p.device_id) + '">' + esc(String(p.device_id || '').slice(0, 10)) + '… <button class="copybtn" data-copy="' + esc(p.device_id) + '">复制</button></td>'
        + '<td>' + ts(p.last_seen) + '</td>'
        + '<td><button class="mini" onclick="openGrant(\\'' + esc(p.device_id) + '\\',\\'' + esc(p.nickname || '-') + '\\')">发放金币</button></td></tr>';
    }).join('') : '<tr><td colspan="8" class="empty" style="text-align:center">暂无玩家数据 · 玩家首次进入游戏时会自动注册</td></tr>';
    var info = document.getElementById('pInfo'); if (info) info.textContent = '第 ' + PG.page + ' / ' + PG.pages + ' 页 · 共 ' + PG.total + ' 名玩家';
    document.getElementById('pTotal').textContent = PG.total;
    document.getElementById('pPrev').disabled = PG.page <= 1;
    document.getElementById('pNext').disabled = PG.page >= PG.pages;
    bindCopies();
  });
}
function bindCopies() {
  document.querySelectorAll('[data-copy]').forEach(function (b) {
    b.onclick = function () { copyTxt(b.getAttribute('data-copy'), b); };
  });
}
function openGrant(dev, name) {
  document.getElementById('gName').value = name;
  document.getElementById('gDev').value = dev;
  document.getElementById('gCoins').value = '';
  document.getElementById('modalMask').classList.add('show');
}
function closeModal() { document.getElementById('modalMask').classList.remove('show'); }
function doGrant() {
  var dev = document.getElementById('gDev').value, c = Number(document.getElementById('gCoins').value);
  if (!c || c <= 0) return toast('请输入有效金额', true);
  api('POST', '/api/admin/grant', { deviceId: dev, coins: c }).then(function (j) {
    toast(j.msg || (j.ok ? '发放成功' : '发放失败'), !j.ok);
    if (j.ok) { closeModal(); loadPlayers(PG.page); }
  });
}
function mkcode() {
  api('POST', '/api/admin/code', { coins: Number(document.getElementById('cCoins').value), maxUses: Number(document.getElementById('cUses').value) }).then(function (j) {
    if (needLogin(j)) return;
    if (j.ok) { document.getElementById('lastCode').innerHTML = '最新兑换码：<span class="code-tag">' + esc(j.code) + '</span> · 面额 ' + fmt(j.coins) + ' · 可用 ' + j.maxUses + ' 次'; loadCodes(); toast('兑换码已生成'); }
    else toast(j.msg || '生成失败', true);
  });
}
function loadCodes() {
  api('GET', '/api/admin/codes').then(function (j) {
    if (needLogin(j)) return;
    if (!j.ok) return;
    var list = j.list || [];
    var tb = document.getElementById('codeList');
    tb.innerHTML = list.length ? list.map(function (c) {
      return '<tr><td class="code-tag">' + esc(c.code) + '</td><td>' + fmt(c.coins) + '</td><td>' + c.used_count + ' / ' + c.max_uses + '</td><td>' + ts(c.created_at) + '</td>'
        + '<td><button class="copybtn" data-copy="' + esc(c.code) + '">复制</button></td></tr>';
    }).join('') : '<tr><td colspan="5" class="empty" style="text-align:center">暂无兑换码 · 在上方生成后即可复制发放</td></tr>';
    bindCopies();
  });
}
function copyAllCodes() {
  api('GET', '/api/admin/codes').then(function (j) {
    if (!j.ok || !j.list || !j.list.length) return toast('暂无兑换码可复制', true);
    copyTxt(j.list.map(function (c) { return c.code; }).join('\\n'));
  });
}
function paintStats(j) {
  if (!j || !j.ok) return;
  var m = { stP: j.totalPlayers, stO: j.online, stG: j.playing, stN: j.newToday, stA: j.activeToday, stM: j.matchesToday, stC: j.totalCodes };
  Object.keys(m).forEach(function (id) { var e = document.getElementById(id); if (e) e.textContent = fmt(m[id]); });
}
var searchTimer;
function searchTO() { clearTimeout(searchTimer); searchTimer = setTimeout(function () { loadPlayers(1); }, 300); }
function refreshAll() { api('GET', '/api/admin/stats').then(paintStats); loadTrend(); loadRetention(); loadPlayers(1); loadCodes(); }
document.getElementById('pSize').addEventListener('change', changePageSize);
document.getElementById('pSearch').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadPlayers(1); });
document.getElementById('modalMask').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
if (TK) { showMain(); refreshAll(); } else { showLogin(); }
</script>
</body>
</html>
`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }

    if (path === '/api/admin-panel') {
    var page = '<!DOCTYPE html><html lang="zh"><meta charset="utf-8"><title>牌友小馆管理</title>'
      + '<body style="font-family:system-ui;background:#0d1520;color:#d8e0e8;max-width:760px;margin:30px auto;padding:0 16px">'
      + '<h2 style="color:#f2c14e">牌友小馆 · 管理端</h2>'
      + '<div id="login"><input id="u" placeholder="账号" style="width:200px;padding:8px"><input id="p" type="password" placeholder="密码" style="width:200px;padding:8px"><button onclick="login()" style="padding:8px 16px">登录</button></div>'
      + '<div id="panel" style="display:none">'
      + '<h3>发放金币</h3><input id="gDev" placeholder="设备ID" style="width:340px;padding:8px"><input id="gCoins" placeholder="金币数" type="number" style="width:120px;padding:8px"><button onclick="grant()" style="padding:8px 16px">发放（进对方邮箱）</button>'
      + '<h3>生成兑换码</h3><input id="cCoins" placeholder="面额金币" type="number" style="width:120px;padding:8px"><input id="cUses" placeholder="可用次数" type="number" value="1" style="width:100px;padding:8px"><button onclick="mkcode()" style="padding:8px 16px">生成</button>'
      + '<h3>最近兑换码</h3><button onclick="codes()" style="padding:8px 16px">刷新</button>'
      + '</div><pre id="out" style="background:#111c28;padding:12px;border-radius:8px;white-space:pre-wrap"></pre>'
      + '<scr' + 'ipt>var TK=localStorage.getItem("admTK")||"";function api(m,p,b){return fetch("/_poker"+p,{method:m,headers:{"Content-Type":"application/json","X-Admin-Token":TK},body:b?JSON.stringify(b):undefined}).then(function(r){return r.json()})}'
      + 'function out(x){document.getElementById("out").textContent=typeof x==="string"?x:JSON.stringify(x,null,2)}'
      + 'function login(){api("POST","/api/admin/login",{user:document.getElementById("u").value,password:document.getElementById("p").value}).then(function(j){if(j.ok){TK=j.token;localStorage.setItem("admTK",TK);document.getElementById("login").style.display="none";document.getElementById("panel").style.display="block";out("登录成功")}else out("登录失败: "+(j.msg||""))})}'
      + 'function grant(){api("POST","/api/admin/grant",{deviceId:document.getElementById("gDev").value,coins:Number(document.getElementById("gCoins").value)}).then(out)}'
      + 'function mkcode(){api("POST","/api/admin/code",{coins:Number(document.getElementById("cCoins").value),maxUses:Number(document.getElementById("cUses").value)}).then(out)}'
      + 'function codes(){api("GET","/api/admin/codes").then(out)}'
      + 'if(TK){document.getElementById("login").style.display="none";document.getElementById("panel").style.display="block"}'
      + '</scr' + 'ipt></body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page);
    return;
  }
  if (path === '/api/info') {
      return json(res, 200, {
        ok: true, name: '牌友小馆联机服务', version: '1.0.0',
        games: Object.keys(ADAPTERS).map(id => ({ id, name: GAME_NAMES[id] || id, min: ADAPTERS[id].minPlayers, max: ADAPTERS[id].maxPlayers })),
        leaderboardGames: GAMES,
      });
    }

    /* 设备建档 / 改名 / 设头像 */
    if (path === '/api/player' && method === 'POST') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      const body = await readBody(req);
      const p = store.ensurePlayer(deviceId, cleanNick(body.nickname));
      /* 头像：预设 id（如 a01），宽松校验为短 token，防止超长串入库 */
      if (body && body.avatar) {
        const av = String(body.avatar);
        if (/^[A-Za-z0-9_-]{1,16}$/.test(av)) store.setAvatar(deviceId, av);
      }
      /* 个性签名：去控制字符与尖括号，最长 60 字 */
      if (body && body.bio !== undefined) {
        const bio = String(body.bio).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
        store.setBio(deviceId, bio);
      }
      /* 佩戴中的称号：只接受称号 id 形式的短 token（如 tt_top_holdem） */
      if (body && body.title !== undefined) {
        const tid = String(body.title || '').trim();
        if (!tid || /^[A-Za-z0-9_]{1,32}$/.test(tid)) store.setTitle(deviceId, tid);
      }
      /* 榜单快照：金币 / 称号数 / 成就数 / 签到天数与连签（客户端保存资料时带上） */
      store.setRankStats(deviceId, {
        coins: body && body.coins,
        titles: body && body.titles,
        achievements: body && body.achievements,
        checkinDays: body && body.checkinDays,
        checkinStreak: body && body.checkinStreak,
        puzzles: body && body.puzzles,
        tourBest: body && body.tourBest,
      });
      store.touchActiveDay(deviceId);
      const fresh = store.getPlayer(deviceId);
      return json(res, 200, { ok: true, deviceId, nickname: fresh.nickname, avatar: fresh.avatar || 'a01', bio: fresh.bio || '', title: fresh.title || '', userCode: fresh.user_code, recoveryCode: fresh.recovery_code, rank: store.getRank(deviceId), items: store.getItems(deviceId) });
    }

    /* 云存档：全量状态 blob 的读取 / 上推（最后写入胜出，客户端凭 updatedAt 比对） */
    if (path === '/api/state' && method === 'GET') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      store.ensurePlayer(deviceId, '牌友');
      store.touchActiveDay(deviceId);
      const s = store.getState(deviceId);
      return json(res, 200, { ok: true, state: s.state, updatedAt: s.updatedAt });
    }
    if (path === '/api/state' && method === 'PUT') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      const body = await readBody(req);
      if (!body || typeof body.state !== 'object' || body.state === null) {
        return json(res, 400, { ok: false, msg: '缺少存档数据' });
      }
      let raw;
      try { raw = JSON.stringify(body.state); } catch (e) { return json(res, 400, { ok: false, msg: '存档不可序列化' }); }
      if (raw.length > 512e3) return json(res, 413, { ok: false, msg: '存档过大' });
      store.ensurePlayer(deviceId, '牌友');
      const updatedAt = store.setState(deviceId, body.state);
      return json(res, 200, { ok: true, updatedAt });
    }

    /* 跨设备接管：凭 玩家号+恢复码 校验身份，返回原设备ID（客户端本机换绑后拉取云存档） */
    if (path === '/api/player/claim' && method === 'POST') {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const now = Date.now();
      claimHits.set(ip, (claimHits.get(ip) || []).filter(t => now - t < 60e3));
      const hits = claimHits.get(ip); hits.push(now); claimHits.set(ip, hits);
      if (hits.length > 10) return json(res, 429, { ok: false, msg: '尝试过于频繁，请稍后再试' });
      const body = await readBody(req);
      const code = String(body.userCode || '').trim().toUpperCase();
      const recovery = String(body.recoveryCode || '').replace(/[\s-]/g, '').toUpperCase();
      if (!code || !recovery) return json(res, 400, { ok: false, msg: '请填写玩家号与恢复码' });
      const p = store.getUserByCode(code);
      if (!p || String(p.recovery_code || '').toUpperCase() !== recovery) {
        return json(res, 401, { ok: false, msg: '玩家号或恢复码不正确' });
      }
      return json(res, 200, { ok: true, deviceId: p.device_id, nickname: p.nickname, avatar: p.avatar || 'a01' });
    }

    /* 重新生成恢复码（旧码立即作废） */
    if (path === '/api/player/recovery/rotate' && method === 'POST') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      store.ensurePlayer(deviceId, '牌友');
      const rc = store.rotateRecovery(deviceId);
      return json(res, 200, { ok: true, recoveryCode: rc });
    }

    /* 同步本地段位到服务端（单机模式也上榜） */
    if (path === '/api/rank' && method === 'POST') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      const body = await readBody(req);
      const rank = (body && body.rank) || {};
      const clean = {};
      GAMES.forEach(g => {
        const v = rank[g] || {};
        clean[g] = {
          points: Math.max(0, Math.min(1e9, Number(v.points) || 0)),
          tier: Math.max(0, Math.min(99, Number(v.tier) || 0)),
          peak: Math.max(0, Math.min(99, Number(v.peak) || 0)),
        };
      });
      store.setRank(deviceId, clean);
      if (body && body.stats) store.setStats(deviceId, body.stats);
      if (body && body.items) store.setItems(deviceId, body.items);
      return json(res, 200, { ok: true });
    }

    /* 排行榜：全服榜 / 好友榜
       —— 全服榜是公开数据，无需设备ID（未登录也能围观）；
          好友榜必须有身份才能算出「我的好友」集合。 */
    if (path === '/api/leaderboard') {
      const game = url.searchParams.get('game') || 'holdem';
      if (!GAMES.includes(game)) return json(res, 400, { ok: false, msg: '未知游戏' });
      const scope = url.searchParams.get('scope') || 'global';
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const me = validDeviceId(deviceId) ? deviceId : '';

      if (scope === 'friends' && !me) {
        return json(res, 400, { ok: false, msg: '好友榜需要设备ID' });
      }

      let list;
      if (scope === 'friends') {
        store.ensurePlayer(me, '牌友');
        list = store.friendBoard(me, game);
      } else {
        if (me) store.ensurePlayer(me, '牌友');
        list = store.globalBoard(game, limit);
      }
      const withRank = list.map((x, i) => ({ ...x, rank: i + 1, isMe: !!me && x.deviceId === me }));
      return json(res, 200, { ok: true, game, gameName: GAME_NAMES[game], scope, list: withRank });
    }

    /* 好友：列表 / 请求 / 接受 / 删除 */
    if (path === '/api/friends') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      if (method === 'GET') {
        const ids = store.friendsOf(deviceId);
        const list = ids.map(id => {
          const p = store.getPlayer(id);
          return p ? { deviceId: id, nickname: p.nickname, avatar: p.avatar || 'a01', rank: store.getRank(id), lastSeen: p.last_seen, online: conns.has(id) } : null;
        }).filter(Boolean);
        return json(res, 200, {
          ok: true, friends: list,
          requests: store.pendingRequests(deviceId).map(r => {
            const p = store.getPlayer(r.from_id);
            return { deviceId: r.from_id, nickname: r.nickname || '牌友', avatar: (p && p.avatar) || 'a01' };
          }),
        });
      }
      if (method === 'POST') {
        const body = await readBody(req);
        /* 兼容两种字段名：deviceId / friendId / targetId */
        const raw = String(body.deviceId || body.friendId || body.targetId || '').trim();
        if (!raw) return json(res, 400, { ok: false, msg: '请填写对方玩家号或设备ID' });
        /* 解析目标：优先当设备ID；否则当短玩家号（大小写不敏感） */
        let target = raw;
        let targetPlayer = validDeviceId(raw) ? store.getPlayer(raw) : null;
        if (!targetPlayer) {
          const byCode = store.getUserByCode(raw);
          if (byCode) { targetPlayer = byCode; target = byCode.device_id; }
        }
        if (!targetPlayer) return json(res, 404, { ok: false, msg: '对方不存在（请确认玩家号或设备ID）' });
        if (target === deviceId) return json(res, 400, { ok: false, msg: '不能加自己为好友' });
        store.ensurePlayer(deviceId, '牌友');
        const r = store.requestFriend(deviceId, target);
        return json(res, 200, r);
      }
    }
    if (path === '/api/friends/accept' && method === 'POST') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      const body = await readBody(req);
      const from = String(body.deviceId || body.friendId || body.fromId || '');
      if (!validDeviceId(from)) return json(res, 400, { ok: false, msg: '非法来源设备ID' });
      /* 必须确实存在待处理请求，否则是假成功 */
      const pending = store.pendingRequests(deviceId).some(r => r.from_id === from);
      if (!pending) return json(res, 404, { ok: false, msg: '没有来自该玩家的好友请求' });
      store.addFriend(deviceId, from);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/friends' && method === 'DELETE') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      const target = String(url.searchParams.get('deviceId') || url.searchParams.get('friendId') || '');
      if (!validDeviceId(target)) return json(res, 400, { ok: false, msg: '非法目标设备ID' });
      store.removeFriend(deviceId, target);
      return json(res, 200, { ok: true });
    }

    /* 好友搜索：按昵称模糊匹配玩家（需身份，排除自己）
       —— 返回候选列表，供前端"昵称互加"。标记 isFriend / requested / pending 让 UI 直接显示状态。 */
    if (path === '/api/friends/search' && method === 'GET') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return json(res, 400, { ok: false, msg: '搜索词不能为空' });
      if (q.length > config.auth.nicknameMaxLen) return json(res, 400, { ok: false, msg: '搜索词过长' });
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      const rows = store.searchPlayersByNick(q, deviceId, limit);
      const friends = new Set(store.friendsOf(deviceId));
      const requested = new Set(store.outgoingRequests(deviceId));
      const pending = new Set(store.pendingRequests(deviceId).map(r => r.from_id));
      const list = rows.map(r => ({
        deviceId: r.deviceId,
        nickname: r.nickname,
        avatar: r.avatar || 'a01',
        isFriend: friends.has(r.deviceId),
        requested: requested.has(r.deviceId),
        pending: pending.has(r.deviceId),
      }));
      return json(res, 200, { ok: true, q, list });
    }

    /* ---- 账号：注册（把当前存档身份升级为账号）---- */
    if (path === '/api/account/register' && method === 'POST') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      const body = await readBody(req);
      const username = String((body && body.username) || '').trim();
      const password = String((body && body.password) || '');
      if (!USERNAME_RE.test(username)) return json(res, 400, { ok: false, msg: '用户名需 3~16 位字母/数字/下划线' });
      if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return json(res, 400, { ok: false, msg: '密码需 ' + PASSWORD_MIN + '~' + PASSWORD_MAX + ' 位' });
      if (store.getAccountByName(username)) return json(res, 409, { ok: false, msg: '该用户名已被占用' });
      if (store.getAccountByDevice(deviceId)) return json(res, 409, { ok: false, msg: '当前设备已绑定账号，请先退出登录' });
      const salt = newSalt();
      const okc = store.createAccount(username, deviceId, salt, hashPassword(password, salt));
      if (!okc) return json(res, 409, { ok: false, msg: '注册失败：用户名或身份已被占用' });
      store.ensurePlayer(deviceId, '牌友');
      return json(res, 200, { ok: true, username: username, deviceId: deviceId });
    }

    /* ---- 账号：登录（返回该账号绑定的存档身份，客户端切换身份后拉云存档）---- */
    if (path === '/api/account/login' && method === 'POST') {
      const body = await readBody(req);
      const username = String((body && body.username) || '').trim();
      const password = String((body && body.password) || '');
      if (!USERNAME_RE.test(username)) return json(res, 400, { ok: false, msg: '用户名或密码不正确' });
      if (loginBlocked(username)) return json(res, 429, { ok: false, msg: '尝试次数过多，请 10 分钟后再试' });
      const acc = store.getAccountByName(username);
      if (!acc) { noteLoginFail(username); return json(res, 401, { ok: false, msg: '用户名或密码不正确' }); }
      const hash = hashPassword(password, acc.pass_salt);
      let same = false;
      try { same = crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(acc.pass_hash, 'hex')); } catch (e) { same = false; }
      if (!same) { noteLoginFail(username); return json(res, 401, { ok: false, msg: '用户名或密码不正确' }); }
      clearLoginFail(username);
      store.touchLogin(username);
      return json(res, 200, { ok: true, username: username, deviceId: acc.device_id });
    }

    /* ---- 账号：查询当前身份绑定的账号（未登录返回 account:null）---- */
    if (path === '/api/account/me' && method === 'GET') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      const acc = store.getAccountByDevice(deviceId);
      return json(res, 200, { ok: true, account: accountView(acc) });
    }

    /* ---- 金币邮箱：查询 / 领取（兑换码、邀请、管理员补发的统一入口）---- */
    if (path === '/api/mailbox' && method === 'GET') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      return json(res, 200, { ok: true, coins: store.mailboxOf(deviceId) });
    }
    if (path === '/api/mailbox/claim' && method === 'POST') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      return json(res, 200, { ok: true, coins: store.takeMailbox(deviceId) });
    }

    /* ---- 兑换码 ---- */
    if (path === '/api/redeem' && method === 'POST') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      const body = await readBody(req);
      const code = String((body && body.code) || '').trim().toUpperCase();
      if (!code) return json(res, 400, { ok: false, msg: '请输入兑换码' });
      const coins = store.redeemCode(code, deviceId);
      if (!coins) return json(res, 400, { ok: false, msg: '兑换码无效、已用完或已被该设备使用' });
      return json(res, 200, { ok: true, coins: coins, msg: '兑换成功，' + coins + ' 金币已存入邮箱' });
    }

    if (path === '/api/redeem/mine' && method === 'GET') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      return json(res, 200, { ok: true, list: store.redemptionsOf(deviceId, 20), mailbox: store.mailboxOf(deviceId) });
    }

    /* ---- 邀请上报：好友带 ?ref= 首次进入，双方各得 1000 金币 ---- */
    if (path === '/api/invite/report' && method === 'POST') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      const body = await readBody(req);
      const ref = String((body && body.ref) || '');
      if (!validDeviceId(ref) || ref === deviceId) return json(res, 200, { ok: false, msg: '无效邀请' });
      if (store.inviteExists(deviceId)) return json(res, 200, { ok: true, coins: 0, msg: '已领取过邀请奖励' });
      store.recordInvite(ref, deviceId);
      store.addMailbox(deviceId, 1000);
      store.addMailbox(ref, 1000);
      return json(res, 200, { ok: true, coins: 1000 });
    }

    /* ---- 管理端 API ---- */
    if (path === '/api/admin/login' && method === 'POST') {
      const body = await readBody(req);
      const u = String((body && body.user) || ''), p = String((body && body.password) || '');
      if (u === ADMIN_USER && p === ADMIN_PASS) {
        const token = require('crypto').randomBytes(24).toString('hex');
        adminTokens.set(token, Date.now() + 2 * 3600 * 1000);
        return json(res, 200, { ok: true, token: token });
      }
      return json(res, 401, { ok: false, msg: '账号或密码不正确' });
    }
    if (path.startsWith('/api/admin/') && path !== '/api/admin/login') {
      if (!adminOk(req)) return json(res, 401, { ok: false, msg: '请先登录管理端' });
      if (path === '/api/admin/players' && method === 'GET') {
        var search = url.searchParams.get('search') || '';
        var size = Math.max(5, Math.min(100, Number(url.searchParams.get('size')) || 20));
        var page = Math.max(1, Number(url.searchParams.get('page')) || 1);
        var pg = store.listPlayersPaged(size, (page - 1) * size, search);
        return json(res, 200, { ok: true, list: pg.list, total: pg.total, page: page, size: size, pages: Math.max(1, Math.ceil(pg.total / size)) });
      }
      if (path === '/api/admin/retention' && method === 'GET') {
        var rdays = Math.max(3, Math.min(90, Number(url.searchParams.get('days')) || 30));
        return json(res, 200, { ok: true, days: rdays, retention: store.retention(rdays) });
      }
      if (path === '/api/admin/trend' && method === 'GET') {
        var days = Math.max(3, Math.min(60, Number(url.searchParams.get('days')) || 14));
        return json(res, 200, { ok: true, days: days, trend: store.adminTrend(days) });
      }
      if (path === '/api/admin/player-detail' && method === 'GET') {
        var pd = url.searchParams.get('deviceId') || '';
        return json(res, 200, { ok: true, player: store.playerDetail(pd) });
      }
      if (path === '/api/admin/stats' && method === 'GET') {
        var totalP = store.db.prepare('SELECT COUNT(*) AS n FROM players').get().n;
        var totalCodes = store.db.prepare('SELECT COUNT(*) AS n FROM redeem_codes').get().n;
        var onlineNow = conns.size;
        var playing = 0;
        try { for (const c of conns.values()) if (c.roomCode) playing++; } catch (e) {}
        var dayAgo = Date.now() - 24 * 3600 * 1000;
        var newToday = store.db.prepare('SELECT COUNT(*) AS n FROM players WHERE created_at >= ?').get(dayAgo).n;
        var activeToday = store.db.prepare('SELECT COUNT(*) AS n FROM players WHERE last_seen >= ?').get(dayAgo).n;
        var matchesToday = 0;
        try { matchesToday = store.db.prepare('SELECT COUNT(*) AS n FROM matches WHERE ended_at >= ?').get(dayAgo).n; } catch (e) {}
        return json(res, 200, { ok: true, totalPlayers: totalP, totalCodes: totalCodes, online: onlineNow, playing: playing, newToday: newToday, activeToday: activeToday, matchesToday: matchesToday });
      }
      if (path === '/api/admin/grant' && method === 'POST') {
        const body = await readBody(req);
        const n = store.addMailbox(String((body && body.deviceId) || ''), Number((body && body.coins) || 0));
        return json(res, 200, { ok: n > 0, msg: n > 0 ? '已发放 ' + n + ' 金币到对方邮箱' : '发放失败（设备不存在或金额非法）' });
      }
      if (path === '/api/admin/code' && method === 'POST') {
        const body = await readBody(req);
        const code = 'PK-' + require('crypto').randomBytes(4).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');
        const created = store.createCode(code, Number((body && body.coins) || 0), Number((body && body.maxUses) || 1));
        return json(res, created ? 200 : 400, { ok: created, code: code, coins: Number((body && body.coins) || 0), maxUses: Number((body && body.maxUses) || 1) });
      }
      if (path === '/api/admin/codes' && method === 'GET') {
        return json(res, 200, { ok: true, list: store.listCodes(30) });
      }
      return json(res, 404, { ok: false, msg: '未知管理接口' });
    }

    /* ---- 免费锦标赛：提交成绩 / 榜单 / 我的成绩 ---- */
    if (path === '/api/tournament' && method === 'POST') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      let tb = {};
      try { tb = await readBody(req); } catch (e) { tb = {}; }
      const r = store.submitTournament(deviceId, tb.score, tb.hands);
      return json(res, r.ok ? 200 : 400, r);
    }
    if (path === '/api/tournament/board' && method === 'GET') {
      const scope = String(url.searchParams.get('scope') || 'today');
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 50));
      const list = store.tourBoard(scope === 'all' ? 'all' : 'today', limit);
      return json(res, 200, { ok: true, scope: scope, list: list.map((x, i) => ({ rank: i + 1, ...x, isMe: !!deviceId && x.deviceId === deviceId })) });
    }
    if (path === '/api/tournament/mine' && method === 'GET') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      return json(res, 200, { ok: true, mine: store.myTournament(deviceId) });
    }

    /* ---- 排行榜：coins 金币 / titles 称号 / achievements 成就 / checkin 签到连签 ---- */
    if (path === '/api/rank' && method === 'GET') {
      var rtype = String(url.searchParams.get('type') || 'coins');
      var rlimit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 50));
      if (['coins', 'titles', 'achievements', 'checkin', 'puzzles', 'tournament'].indexOf(rtype) < 0) return json(res, 400, { ok: false, msg: '未知榜单类型' });
      var rlist = store.rankBy(rtype, rlimit);
      return json(res, 200, {
        ok: true, type: rtype, limit: rlimit,
        list: rlist.map(function (x, i) { return { rank: i + 1, deviceId: x.deviceId, nickname: x.nickname, avatar: x.avatar, userCode: x.userCode, value: x.value, isMe: !!deviceId && x.deviceId === deviceId }; }),
      });
    }

    /* ---- 拉黑名单（UGC 处置）：GET 列表 / POST 拉黑 / DELETE 解除 ---- */
    if (path === '/api/blocks') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      if (method === 'GET') return json(res, 200, { ok: true, list: store.listBlocks(deviceId) });
      let body = {};
      try { body = await readBody(req); } catch (e) { return json(res, 400, { ok: false, msg: '请求体不合法' }); }
      const targetId = String((body && (body.targetId || body.deviceId)) || '').slice(0, 64);
      if (!validDeviceId(targetId)) return json(res, 400, { ok: false, msg: '目标玩家不合法' });
      if (targetId === deviceId) return json(res, 400, { ok: false, msg: '不能对自己操作' });
      if (method === 'POST') { store.addBlock(deviceId, targetId); return json(res, 200, { ok: true, blocked: true, list: store.listBlocks(deviceId) }); }
      if (method === 'DELETE') { store.removeBlock(deviceId, targetId); return json(res, 200, { ok: true, blocked: false, list: store.listBlocks(deviceId) }); }
      return json(res, 405, { ok: false, msg: '方法不支持' });
    }

    /* ---- 举报（留证用，不自动处罚）---- */
    if (path === '/api/report' && method === 'POST') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      let body = {};
      try { body = await readBody(req); } catch (e) { return json(res, 400, { ok: false, msg: '请求体不合法' }); }
      const targetId = String((body && (body.targetId || body.deviceId)) || '').slice(0, 64);
      const reason = String((body && body.reason) || '').replace(/[\u0000-\u001f<>]/g, '').slice(0, 40);
      if (!validDeviceId(targetId)) return json(res, 400, { ok: false, msg: '目标玩家不合法' });
      if (targetId === deviceId) return json(res, 400, { ok: false, msg: '不能举报自己' });
      store.addReport(deviceId, targetId, reason);
      return json(res, 200, { ok: true, count: store.reportCount(targetId) });
    }

    /* 房间号搜索成员：通过房号查房内现时成员（无需身份也能围观成员，用于"房间号互加"）
       —— 返回成员 deviceId/nickname/seat/online/ready，并相对查询者标记 isMe / isFriend。 */
    if (path === '/api/room/members' && method === 'GET') {
      const code = (url.searchParams.get('code') || '').trim();
      if (!/^\d+$/.test(code) || code.length !== config.room.codeLength) {
        return json(res, 400, { ok: false, msg: '房间号格式不正确（' + config.room.codeLength + ' 位数字）' });
      }
      const room = rooms.get(code);
      if (!room) return json(res, 404, { ok: false, msg: '房间不存在或已解散' });
      const friends = new Set(validDeviceId(deviceId) ? store.friendsOf(deviceId) : []);
      const pending = new Set(validDeviceId(deviceId) ? store.pendingRequests(deviceId).map(r => r.from_id) : []);
      const members = room.seats.map(s => {
        const sp = store.getPlayer(s.deviceId);
        return {
          deviceId: s.deviceId,
          nickname: s.name || '牌友',
          avatar: (sp && sp.avatar) || 'a01',
          seat: s.seat,
          online: !!s.online,
          ready: !!s.ready,
          isMe: validDeviceId(deviceId) && s.deviceId === deviceId,
          isFriend: friends.has(s.deviceId),
          pending: pending.has(s.deviceId),
        };
      });
      return json(res, 200, { ok: true, code, game: room.game, members });
    }

    return json(res, 404, { ok: false, msg: 'not found' });
  } catch (e) {
    console.error('[http] 处理失败', path, e);
    return json(res, 500, { ok: false, msg: '服务内部错误' });
  }
});

/* ---------------- WebSocket 联机 ---------------- */
const wss = new WebSocketServer({ server, path: '/ws' });
/* ============ 账号（用户名 + 密码）============
   设计取舍：不引入手机号/短信（需付费与备案）与第三方登录（需开放平台资质），
   用自建账号即可满足"换设备不丢档、好友与榜单有稳定身份"，且保持零成本。 */
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const PASSWORD_MIN = 6, PASSWORD_MAX = 64;
const loginFails = new Map();          // username -> { n, at }（内存限流，防爆破）
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString('hex');
}
function newSalt() { return crypto.randomBytes(16).toString('hex'); }
function loginBlocked(username) {
  const r = loginFails.get(username);
  if (!r) return false;
  if (Date.now() - r.at > LOGIN_WINDOW_MS) { loginFails.delete(username); return false; }
  return r.n >= LOGIN_MAX_FAILS;
}
function noteLoginFail(username) {
  const r = loginFails.get(username);
  if (!r || Date.now() - r.at > LOGIN_WINDOW_MS) loginFails.set(username, { n: 1, at: Date.now() });
  else { r.n++; r.at = Date.now(); }
}
function clearLoginFail(username) { loginFails.delete(username); }
const accountView = (a) => a ? { username: a.username, createdAt: a.created_at, lastLogin: a.last_login || 0 } : null;

/* ============ 管理端（/admin）============
     凭据：ADMIN_USER / ADMIN_PASS 环境变量可覆盖；登录换 2 小时 token。 */
  const ADMIN_USER = process.env.ADMIN_USER || 'poker';
  const ADMIN_PASS = process.env.ADMIN_PASS || 'poker@123';
  const adminTokens = new Map();   // token -> expiry
  function adminOk(req) {
    var t = req.headers['x-admin-token'];
    if (!t) return false;
    var exp = adminTokens.get(String(t));
    if (!exp || Date.now() > exp) { adminTokens.delete(String(t)); return false; }
    return true;
  }

  const conns = new Map();   // deviceId -> { ws, roomCode, lastMsgs: [] }

/* 局内快捷语白名单：与前端 SAY_TEXTS 一字不差。
   服务端只放行白名单 —— 这样局内社交不存在自由文本，天然规避内容审核风险。 */
const SAY_TEXTS = [
  '大家好，很高兴见到各位', '快点吧，等到花都谢了', '打得不错', '手气真好',
  '承让承让', '这牌有点难打', '我先看看', '稳住，我们能赢',
  '队友给力', '别急，慢慢来', '这波漂亮', '好牌，可惜了',
  '我弃牌，你们继续', '再来一局，别走', '不好意思，我赢了', '绝了',
];

/* ============ 快速匹配（陌生人匹配：凑满即建房并直接开局）============
   设计取舍：真人优先，凑不满就继续等（不做 AI 补位，避免"以为是真人"的误解）；
   匹配房无需准备，建房即开局，与好友房的准备流程互不影响。 */
const matchQueue = new Map();   // game -> [ { deviceId, nickname, ws } ]
const matchMin = (game) => { const ad = ADAPTERS[game]; return (ad && ad.minPlayers) || 2; };
function broadcastMatch(game) {
  const q = matchQueue.get(game) || [];
  for (const e of q) if (e.ws && e.ws.readyState === 1) {
    send(e.ws, 'matching', { game, name: GAME_NAMES[game] || game, waiting: q.length, need: matchMin(game), names: q.map(x => x.nickname) });
  }
}
function matchRemove(deviceId) {
  for (const [g, q] of matchQueue) {
    const i = q.findIndex(e => e.deviceId === deviceId);
    if (i >= 0) { q.splice(i, 1); broadcastMatch(g); }
  }
}
function matchPush(game, deviceId, nickname, ws) {
  if (!ADAPTERS[game]) return { ok: false, msg: '该玩法暂不支持快速匹配' };
  matchRemove(deviceId);
  rooms.leaveCurrent(deviceId);
  let q = matchQueue.get(game);
  if (!q) { q = []; matchQueue.set(game, q); }
  q.push({ deviceId, nickname, ws });
  return { ok: true };
}
function tryMatch(game) {
  const q = matchQueue.get(game) || [];
  const need = matchMin(game);
  if (q.length < need) { broadcastMatch(game); return; }
  const group = q.splice(0, need);
  broadcastMatch(game);
  const host = group[0];
  const r = rooms.create(game, host.deviceId, host.nickname, { matched: true });
  if (!r.ok) { for (const e of group) if (e.ws) send(e.ws, 'error', { msg: r.msg }); return; }
  const room = r.room, code = r.code;
  room.matched = true;
  const hs = room.seats.find(x => x.deviceId === host.deviceId); if (hs) hs.ws = host.ws;
  const hc = conns.get(host.deviceId); if (hc) hc.roomCode = code;
  for (let i = 1; i < group.length; i++) {
    const e = group[i];
    const jr = rooms.join(code, e.deviceId, e.nickname, e.ws);
    if (jr.ok) { const c = conns.get(e.deviceId); if (c) c.roomCode = code; }
    else if (e.ws) send(e.ws, 'error', { msg: '匹配失败：' + jr.msg });
  }
  const st = room.start();
  if (st.ok) startTick(room);
  for (const s of room.seats) if (s.online && s.ws) send(s.ws, 'room', { code, seat: s.seat, room: room.viewFor(s.deviceId), matched: true });
  for (const s of room.seats) if (s.online && s.ws) send(s.ws, 'state', { state: room.viewFor(s.deviceId) });
  console.log('[match] ' + game + ' 匹配成功 ' + code + '（' + group.map(x => x.nickname).join('、') + '）');
}



function send(ws, type, data) {
  if (ws && ws.readyState === 1) {
    let payload;
    try { payload = JSON.stringify({ type, ...data }); }
    catch (e) { console.error('[ws] 序列化失败 type=' + type, e && e.message); return; }
    try { ws.send(payload); } catch (e) { console.error('[ws] 发送失败 type=' + type, e && e.message); }
  }
}

function broadcast(room, type, data, exceptDevice) {
  for (const s of room.seats) {
    if (!s.online || !s.ws) continue;
    if (exceptDevice && s.deviceId === exceptDevice) continue;
    send(s.ws, type, data);
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const deviceId = url.searchParams.get('deviceId') || req.headers['x-device-id'];
  if (!validDeviceId(deviceId)) { send(ws, 'error', { msg: '非法设备ID' }); ws.close(); return; }
  const nickname = cleanNick(url.searchParams.get('nickname'));
  store.ensurePlayer(deviceId, nickname);

  /* 同设备旧连接踢掉 */
  const old = conns.get(deviceId);
  if (old && old.ws && old.ws !== ws) { try { old.ws.close(4001, '重复登录'); } catch {} }

  const conn = { ws, deviceId, nickname, roomCode: null, msgs: [] };
  conns.set(deviceId, conn);
  try { store.touchActiveDay(deviceId); } catch (e) {}
  const meP = store.getPlayer(deviceId);
  send(ws, 'hello', { deviceId, nickname, userCode: meP ? meP.user_code : '', avatar: meP ? (meP.avatar || 'a01') : 'a01', games: Object.keys(ADAPTERS) });

  ws.on('message', (raw) => {
    /* 限流 */
    const now = Date.now();
    conn.msgs = conn.msgs.filter(t => now - t < 10000);
    if (conn.msgs.length >= config.rateLimit.messagesPer10s) { send(ws, 'error', { msg: '操作过于频繁' }); return; }
    conn.msgs.push(now);

    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws, 'error', { msg: '消息格式错误' }); }
    const t = msg.type;
    try {
      if (t === 'nick') {
        conn.nickname = cleanNick(msg.nickname);
        store.ensurePlayer(deviceId, conn.nickname);
        const code = conn.roomCode;
        if (code) {
          const room = rooms.get(code);
          if (room) { const s = room.seats.find(x => x.deviceId === deviceId); if (s) s.name = conn.nickname; broadcast(room, 'room', { room: room.viewFor(null) }); }
        }
        return send(ws, 'ok', { msg: '昵称已更新', nickname: conn.nickname });
      }

      if (t === 'create') {
        const r = rooms.create(msg.game, deviceId, conn.nickname, {
          level: 2,
          maxPlayers: Number(msg.maxPlayers) || 0,
          rounds: Number(msg.rounds) || 0,
          open: !!msg.open,                                  /* 明牌房 */
          double: !!msg.double,                              /* 积分 ×2 */
          turnMs: Number(msg.turnMs) || 0,                    /* 单步时长 */
        });
        if (!r.ok) return send(ws, 'error', { msg: r.msg });
        conn.roomCode = r.code;
        r.room.seats[0].ws = ws;
        send(ws, 'room', { code: r.code, seat: r.seat, room: r.room.viewFor(deviceId) });
        return;
      }

      if (t === 'join') {
        const code = String(msg.code || '').trim();
        const r = rooms.join(code, deviceId, conn.nickname, ws);
        if (!r.ok) return send(ws, 'error', { msg: r.msg });
        conn.roomCode = code;
        send(ws, 'room', { code, seat: r.seat, room: r.room.viewFor(deviceId) });
        broadcast(r.room, 'room', { room: r.room.viewFor(null) }, deviceId);
        /* 广播给房内其他人，让他们知道自己被 join 了 */
        for (const s of r.room.seats) {
          if (s.deviceId !== deviceId && s.online && s.ws) send(s.ws, 'room', { code, room: r.room.viewFor(s.deviceId) });
        }
        return;
      }

      if (t === 'ready') {
        const room = getRoomOf(conn);
        if (!room) return send(ws, 'error', { msg: '不在房间内' });
        const s = room.seats.find(x => x.deviceId === deviceId);
        if (!s) return send(ws, 'error', { msg: '不在房间内' });
        s.ready = msg.ready !== false;
        room.lastActivity = Date.now();
        broadcast(room, 'room', { code: room.code, room: room.viewFor(null) });
        return;
      }

      if (t === 'start') {
        const room = getRoomOf(conn);
        if (!room) return send(ws, 'error', { msg: '不在房间内' });
        if (room.hostDevice !== deviceId) return send(ws, 'error', { msg: '只有房主能开始' });
        const r = room.start();
        if (!r.ok) return send(ws, 'error', { msg: r.msg });
        startTick(room);
        for (const s of room.seats) if (s.online && s.ws) send(s.ws, 'state', { state: room.viewFor(s.deviceId) });
        return;
      }

      if (t === 'act') {
        const room = getRoomOf(conn);
        if (!room) return send(ws, 'error', { msg: '不在房间内' });
        const r = room.act(deviceId, msg.payload || msg);
        if (!r.ok) return send(ws, 'error', { msg: r.msg });
        /* 全员同步 */
        for (const s of room.seats) if (s.online && s.ws) send(s.ws, 'state', { state: room.viewFor(s.deviceId) });
        if (room.adapter.isDone(room.state)) settleRoom(room);
        return;
      }

      if (t === 'say') {
        const room = getRoomOf(conn);
        if (!room) return send(ws, 'error', { msg: '不在房间内' });
        const text = String(msg.text || '').trim();
        if (SAY_TEXTS.indexOf(text) < 0) return send(ws, 'error', { msg: '只支持预设快捷语' });
        const sd = room.seats.find(x => x.deviceId === deviceId);
        if (!sd) return;
        /* 注意：不刷新 lastActivity —— 发言不该影响「行动超时自动代打」的计时 */
        broadcast(room, 'say', { seat: sd.seat, text });
        return;
      }

      if (t === 'invite') {
        /* 房内邀请好友：仅限好友关系，目标在线才推送（断线好友提示用链接邀请） */
        const target = String(msg.to || '').trim();
        if (!validDeviceId(target)) return send(ws, 'error', { msg: '邀请目标非法' });
        if (target === deviceId) return;
        if (store.friendsOf(deviceId).indexOf(target) < 0) return send(ws, 'inviteResult', { ok: false, to: target, msg: '只能邀请你的好友' });
        const room = getRoomOf(conn);
        if (!room) return send(ws, 'inviteResult', { ok: false, to: target, msg: '你还没有房间，请先创建房间' });
        const tc = conns.get(target);
        if (!tc || !tc.ws || tc.ws.readyState !== 1) { try { store.ensurePlayer(deviceId, conn.nickname); } catch {} return send(ws, 'inviteResult', { ok: false, to: target, msg: '对方不在线，可复制邀请链接发给 TA' }); }
        send(tc.ws, 'invite', { code: room.code, game: room.game, from: deviceId, fromName: conn.nickname || '牌友', fromAvatar: (store.getPlayer(deviceId) || {}).avatar || 'a01' });
        return send(ws, 'inviteResult', { ok: true, to: target });
      }

      if (t === 'leave') {
        const room = getRoomOf(conn);
        if (room) {
          room.leave(deviceId);
          broadcast(room, 'room', { code: room.code, room: room.viewFor(null) });
          send(ws, 'left', {});
        }
        conn.roomCode = null;
        rooms.byDevice.delete(deviceId);
        matchRemove(deviceId);
        return;
      }

      if (t === 'match') {
        const game = String(msg.game || 'holdem');
        const r = matchPush(game, deviceId, conn.nickname, ws);
        if (!r.ok) return send(ws, 'error', { msg: r.msg });
        tryMatch(game);
        return;
      }

      if (t === 'matchCancel') {
        matchRemove(deviceId);
        return send(ws, 'left', { cancelled: true });
      }

      if (t === 'ping') return send(ws, 'pong', { t: Date.now() });
      return send(ws, 'error', { msg: '未知消息类型: ' + t });
    } catch (e) {
      console.error('[ws] 处理消息失败', t, e);
      send(ws, 'error', { msg: '服务内部错误' });
    }
  });

  ws.on('close', () => {
    const c = conns.get(deviceId);
    if (c && c.ws === ws) conns.delete(deviceId);
    matchRemove(deviceId);
    const room = conn.roomCode ? rooms.get(conn.roomCode) : null;
    if (room) {
      room.leave(deviceId);
      broadcast(room, 'room', { code: room.code, room: room.viewFor(null) });
      for (const s of room.seats) if (s.online && s.ws) send(s.ws, 'state', { state: room.viewFor(s.deviceId) });
    }
  });

  ws.on('error', () => {});
});

function getRoomOf(conn) {
  if (!conn.roomCode) return null;
  return rooms.get(conn.roomCode);
}

/* 每秒驱动一次房间，负责：断线托管、断线宽限、行动超时 */
function startTick(room) {
  if (room.tickTimer) return;
  room.tickTimer = setInterval(() => {
    if (!rooms.rooms.has(room.code)) { clearInterval(room.tickTimer); return; }
    const now = Date.now();
    /* 断线宽限超时：移出座位 */
    let removed = false;
    for (const s of room.seats) {
      if (!s.online && s.leftAt && now - s.leftAt > config.room.reconnectGraceMs) {
        room.seats.splice(room.seats.indexOf(s), 1);
        rooms.byDevice.delete(s.deviceId);
        removed = true;
      }
    }
    if (removed) {
      broadcast(room, 'room', { code: room.code, room: room.viewFor(null) });
      /* 人数不足则中止牌局 */
      const ad = room.adapter;
      if (room.started && room.seats.filter(s => s.online).length < ad.minPlayers) {
        room.started = false; room.state = null;
        broadcast(room, 'aborted', { msg: '人数不足，牌局已中止' });
        if (room.tickTimer) { clearInterval(room.tickTimer); room.tickTimer = null; }
        return;
      }
    }
    /* 行动超时：自动代为操作 */
    if (room.started && room.state && !room.adapter.isDone(room.state)) {
      const turnSeat = room.game === 'guandan' ? room.state.g.turn : room.state.turn;
      const s = room.seats.find(x => x.seat === turnSeat);
      const idle = now - room.lastActivity;
      if (s && s.online && idle > (room.turnMs ? room.turnMs() : config.room.actionTimeoutMs)) {
        const payload = room.adapter.autoAct(room.state, turnSeat);
        if (payload && payload.ids) room.act(s.deviceId, { ids: payload.ids });
        else if (payload && payload.pass) room.act(s.deviceId, { pass: true });
        else if (payload && payload.action) room.act(s.deviceId, payload);
        room.lastActivity = now;
        for (const x of room.seats) if (x.online && x.ws) send(x.ws, 'state', { state: room.viewFor(x.deviceId) });
      } else if (!s || !s.online) {
        room.stepAuto();
        room._checkSettle();
        for (const x of room.seats) if (x.online && x.ws) send(x.ws, 'state', { state: room.viewFor(x.deviceId) });
      }
    }
    if (room.state && room.adapter.isDone(room.state)) settleRoom(room);
  }, 1000);
  if (room.tickTimer.unref) room.tickTimer.unref();
}

function settleRoom(room) {
  /* 幂等：同一局只广播一次结算 */
  if (room.settleSent) return;
  const res = room.result || (room.adapter.settlement ? room.adapter.settlement(room.state) : null);
  if (!res) return;
  room.settleSent = true;
  /* 娱乐加倍房：结算积分翻倍（仅展示层倍率，玩法内部数值不变） */
  let res2 = res;
  try {
    const f = room.doubleFactor ? room.doubleFactor() : 1;
    if (f > 1 && res && res.payouts) {
      const np = {};
      Object.keys(res.payouts).forEach(k => { np[k] = Math.round((res.payouts[k] || 0) * f); });
      res2 = Object.assign({}, res, { payouts: np, doubled: f });
    }
  } catch (e) { res2 = res; }
  const seatAvatar = (d) => { try { const p = store.getPlayer(d); return (p && p.avatar) || 'a01'; } catch (e) { return 'a01'; } };
  for (const s of room.seats) {
    if (s.online && s.ws) send(s.ws, 'settle', {
      result: res2,
      round: { no: room.roundNo || 1, total: room.roundTotal ? room.roundTotal() : 0, ended: !!room.roundEnded },
      seatInfo: room.seats.map(x => ({ seat: x.seat, name: x.name, avatar: seatAvatar(x.deviceId), online: x.online })),
    });
  }
  /* 结算已下发 → 房间回到等待态（可继续下一局 / 新一轮） */
  room.backToWaiting();
  for (const s of room.seats) if (s.online && s.ws) send(s.ws, 'room', { code: room.code, room: room.viewFor(s.deviceId) });
}

/* 掼蛋：手动驱动 AI（人类出牌后需要连续推进直到轮到下一个人）
   —— 这里在每次 act 后触发一次 stepAuto 补位 */
setInterval(() => {
  for (const room of rooms.rooms.values()) {
    if (room.started && room.state && !room.adapter.isDone(room.state)) room.stepAuto();
  }
}, 300);

/* ---------------- 启动 ---------------- */
function start() {
  server.listen(config.port, config.host, () => {
    console.log('[牌友小馆后端] 已启动 http://' + config.host + ':' + config.port);
    console.log('  HTTP  : /health  /api/info  /api/leaderboard  /api/friends  /api/rank');
    console.log('  WS    : /ws?deviceId=xxx&nickname=xxx');
    console.log('  数据  : ' + store.file);
  });
}

if (require.main === module) start();

module.exports = { server, store, rooms, start, GAME_NAMES };
