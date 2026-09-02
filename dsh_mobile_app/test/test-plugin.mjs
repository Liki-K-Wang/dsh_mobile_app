#!/usr/bin/env node
/**
 * dsh_mobile_app 插件测试
 *
 * 独立进程验证：
 *  1) 插件模块可通过 file:// 导入（模拟 dsh loader 的加载方式）
 *  2) startMobileServer 在测试端口运行后，完整 E2E 通过（对运行中的 DSH）
 *
 * 用法: node test/test-plugin.mjs [testPort] [dshUrl]
 */
import WebSocket from "ws";
import { startMobileServer, DEFAULTS, registerPairingRoutes } from "../lib/index.js";
import { injectMobilePatch } from "../lib/mobile-patch.js";
import { injectSettingsPairing } from "../lib/settings-pairing.js";

const PORT = Number(process.argv[2] ?? 3181);
const DSH_URL = process.argv[3] ?? "http://127.0.0.1:3080";
const TOKEN = "plugintesttoken123";
const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${extra}`); }
}

async function main() {
  console.log(`插件测试 @ ${BASE} (上游 ${DSH_URL})`);

  // 0) 模块可导入 + 默认配置完整
  check("模块导入 & DEFAULTS 存在", typeof startMobileServer === "function" && !!DEFAULTS?.port);

  // 0b) 移动端补丁（randomUUID / 悬浮球 / 设置导航 / 详情列隐藏）
  {
    const sample = '<!doctype html><html><head></head><body><div id="root"></div></body></html>';
    const patched = injectMobilePatch(sample);
    const once = injectMobilePatch(patched);
    check("补丁注入含标记", patched.includes("data-dsh-mobile-patch") && patched.includes("randomUUID") && patched.includes("_navLabel") && patched.includes("applyDetailsHidden") && patched.includes("enforceMobileLayout"));
    check("补丁 v0.3 含抽屉/Logo/标题行图标标记", patched.includes("__dshMobileToggleSidebar") && patched.includes("data-dsh-overlay") && patched.includes("dsh-drawer-mask") && patched.includes("data-dsh-drawer-spacer") && patched.includes("_sidebarCol") && patched.includes("data-dsh-model-logo") && patched.includes("dsh-sidebar-toggle") && !patched.includes("ensureExpanded"));
    // v0.3.9 回归：网页悬浮球彻底删除（函数定义/球 id/磁吸拖拽/弹层隐藏/原生桥全无）
    check("v0.3.9 无悬浮球/无原生桥", !patched.includes("dsh-mobile-ball") && !patched.includes("function installBall") && !patched.includes("function makeDraggable") && !patched.includes("DSHBridge") && !patched.includes("onModalChanged") && !patched.includes("__dshMobileNative"));
    // v0.3.9 回归：标题行侧边栏图标注入逻辑 + 隐藏 DSH 自带开关（防双入口，仅侧栏列内）
    check("v0.3.9 标题行图标 + _toggle 隐藏", patched.includes("ensureHeaderToggle") && patched.includes("dsh-sidebar-toggle") && patched.includes("body:has([class$=_titleRow]) [class$=_sidebarCol] [class$=_toggle]{display:none!important}"));
    // v0.3.10 回归：抽屉布局 CSS !important 强制 + 标记移到 document.body——
    // 侧栏列不再依赖 applyOverlayLayout 的内联样式（会被 DSH React 展开后重绘覆盖，
    // 观察器不触发 → 抽屉塌回 280px + 右侧空白）；frame 上不再挂标记。
    check("v0.3.10 抽屉 CSS 收口(body 标记+!important)", patched.includes('document.body.setAttribute("data-dsh-overlay", "1")') && patched.includes('document.body.removeAttribute("data-dsh-overlay")') && patched.includes("body[data-dsh-overlay] [class$=_sidebarCol]{position:fixed!important") && patched.includes("width:100vw!important") && !patched.includes('frame.setAttribute("data-dsh-overlay"') && !patched.includes('frame.removeAttribute("data-dsh-overlay")'));
    // v0.3.11 回归：标题行图标加 per-titleRow childList 守护（armTitleRowGuard）——
    // React 原地重绘标题行会把注入的 #dsh-sidebar-toggle 删掉，armHeaderToggle 只监听
    // 新增 titleRow 节点抓不到原地重绘 → 图标消失；守护在 childList 变化时确认/重插。
    check("v0.3.11 标题行图标 childList 守护", patched.includes("function armTitleRowGuard") && patched.includes("function ensureHeaderToggle(trArg)") && patched.includes('ensureHeaderToggle(tr)') && patched.includes('tr.__dshGuard') && patched.includes('tr.querySelector("#dsh-sidebar-toggle")'));
    // v0.3.12 回归：hero（新对话空状态）兜底侧边栏按钮——无 titleRow 时左上角固定按钮
    // #dsh-mobile-hero-toggle（仅 [class$=_root][data-phase=hero] 且无弹窗、抽屉未开时显示）；
    // 观察器扩展为同时检查 removedNodes 与 data-phase 属性变化（hero→active 是原地属性变化）。
    check("v0.3.12 hero 兜底按钮+观察器扩展", patched.includes("function ensureHeroToggle") && patched.includes('id = "dsh-mobile-hero-toggle"') && patched.includes('[class$=_root][data-phase=hero]') && patched.includes("m.removedNodes") && patched.includes('attributeFilter: ["data-phase"]') && patched.includes("nodeRelevant"));
    // v0.3.13 回归：抽屉「打开后先正确后收缩」——closeOverlay 加 400ms 防误关守卫
    //（真机 WebView tap 把点击重定向到刚出现的遮罩 → 误关）。校验 lastOpenAt 时间戳、
    // openOverlay 里刷新它、closeOverlay 开头 400ms 内忽略，且守卫在 state.overlay=false 之前。
    check("v0.3.13 closeOverlay 400ms 防误关守卫", patched.includes("lastOpenAt") && patched.includes("state.lastOpenAt = Date.now()") && patched.includes("Date.now() - state.lastOpenAt < 400") && patched.indexOf("Date.now() - state.lastOpenAt < 400") < patched.indexOf("state.overlay = false") && patched.includes('window.__dshMobilePatchVersion = "0.3.15"'));
    // v0.3.14 回归：抽屉打开后 1-3s「对话区宽度收缩、右侧空白」——DSH 用 frame 上的
    // data-details-collapsed 数据属性驱动详情面板（详情列 = grid 轨道3），原 layoutObserver
    // 只盯 style 抓不到。校验：新增 armLayoutWatchdog 400ms 布防守卫（覆盖态保持 0px 1fr 0px
    // + 列固定）、observer attributeFilter 扩展含 class / data-details-collapsed、版本号。
    check("v0.3.14 详情面板布防守卫", patched.includes("function armLayoutWatchdog") && patched.includes("setInterval(function") && patched.includes("}, 400);") && patched.includes('attributeFilter: ["style", "class", "data-details-collapsed"]') && patched.includes("armLayoutWatchdog();") && patched.includes('window.__dshMobilePatchVersion = "0.3.15"'));
    // v0.3.15 回归：抽屉打开后「对话区收缩」最终兜底——纯 CSS 强制 frame grid（0px 1fr 0px）、
    // arm() 每步独立 try/catch、看门狗覆盖态重挂 body 标记。
    check("v0.3.15 CSS grid 兜底+arm 加固", patched.includes("body[data-dsh-overlay] [class$=_frame]") && patched.includes("grid-template-columns:0px minmax(0px, 1fr) 0px!important") && patched.includes('window.__dshMobilePatchVersion = "0.3.15"'));
    check("补丁幂等（不重复注入）", once === patched && patched.includes("dsh-mobile-patch"));
    // v0.3.8 回归：设置 .content 的移动端选择器必须是「后代选择器」（带空格）——
    // [role=dialog][aria-modal=true][class$=_content]（无空格）要求元素同时带 role+aria，
    // 只有 panel 命中，.content 不命中 → min-height:0/overflow:visible 失效 → 设置内容无法滚动。
    check("设置 .content 选择器带空格(内容可滚动)", patched.includes('[role=dialog][aria-modal=true] [class$=_content]{flex:1;min-height:0;overflow:visible}'));
    const m = patched.match(/<script\b[^>]*>([\s\S]*?)<\/script>/);
    let syntaxOk = false;
    if (m) { try { new Function(m[1]); syntaxOk = true; } catch (e) { syntaxOk = false; } }
    check("补丁脚本语法合法", syntaxOk === true);
  }

  // 0c) 设置「手机配对」入口注入
  {
    const sample = '<!doctype html><html><head></head><body><div id="root"></div></body></html>';
    const patched = injectSettingsPairing(sample);
    const once = injectSettingsPairing(patched);
    check("设置入口注入含标记", patched.includes("dsh-pair-section") && patched.includes("/api/dsh-mobile/pair") && patched.includes("data-dsh-pair-cell") && patched.includes("dsh-mobile-pairing"));
    check("设置入口幂等（不重复注入）", once === patched);
    check("配对入口观察器常驻(无60s断开)", !patched.includes("60000") && !/obs\.disconnect/.test(patched));
    const tags = patched.match(/<script\b[^>]*>([\s\S]*?)<\/script>/g) ?? [];
    let syntaxOk = true;
    for (const tag of tags) {
      const body = tag.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
      try { new Function(body); } catch (e) { syntaxOk = false; }
    }
    check("设置入口脚本语法合法", syntaxOk === true);
    // v0.3.8 回归：配对 :has() 压制规则必须是后代选择器（带空格），否则 navList 不命中。
    check("配对 :has() 压制规则带空格", patched.includes('[role=dialog][aria-modal=true] [class$=_navList]:has([data-dsh-pair-selected])'));
  }

  // 0d) 配对 REST 路由注册（fake webServer）
  {
    const routes = new Map();
    const web = { register: (r) => { routes.set(r.path, r.handler); return () => routes.delete(r.path); } };
    const fakeServer = {
      getPairingInfo: async () => ({ token: "T", qr: "data:image/png;base64,xx", links: { lan: ["192.168.1.8:3081"], wan: [] } }),
      rotateToken: async () => ({ token: "T2", qr: "data:image/png;base64,yy", links: { lan: [], wan: [] } }),
      revokeSessions: () => ({ ok: true, revoked: 3 })
    };
    const disp = registerPairingRoutes(web, () => fakeServer);
    check("注册 3 条配对路由", routes.size === 3 && routes.has("/api/dsh-mobile/pair") && routes.has("/api/dsh-mobile/pair/regenerate") && routes.has("/api/dsh-mobile/pair/revoke"));
    const call = (path, method) => new Promise((resolve) => {
      const res = { _s: 0, _b: "", writeHead(s) { this._s = s; }, end(b) { this._b = String(b); resolve({ status: this._s, body: this._b }); } };
      routes.get(path)({ method, url: path, headers: {} }, res);
    });
    const r1 = await call("/api/dsh-mobile/pair", "GET");
    check("GET pair -> 200 + token/QR", r1.status === 200 && r1.body.includes('"token":"T"') && r1.body.includes("data:image/png;base64"), `status=${r1.status}`);
    const r2 = await call("/api/dsh-mobile/pair/regenerate", "POST");
    check("POST regenerate -> 200 换令牌", r2.status === 200 && r2.body.includes('"token":"T2"'), `status=${r2.status}`);
    const r3 = await call("/api/dsh-mobile/pair/revoke", "POST");
    check("POST revoke -> ok", r3.status === 200 && r3.body.includes('"ok":true'), `status=${r3.status}`);
    const r4 = await call("/api/dsh-mobile/pair", "POST");
    check("GET-only 路由拒绝 POST", r4.status === 405, `status=${r4.status}`);
    disp();
    check("disposer 后路由移除", routes.size === 0);
  }

  const instance = await startMobileServer({ port: PORT, token: TOKEN, dshUrl: DSH_URL, openBrowser: false }, console);
  check("startMobileServer 启动成功", !!instance && !!instance.token && instance.token === TOKEN);

  // 1) 探测：无令牌 -> 401
  { const r = await fetch(`${BASE}/pair/probe`); check("probe 无令牌 -> 401", r.status === 401, `got ${r.status}`); }
  // 2) 探测：有令牌 -> ok
  { const r = await fetch(`${BASE}/pair/probe?t=${TOKEN}`); const j = await r.json();
    check("probe 有令牌 -> 200 ok", r.status === 200 && j.ok === true && j.dsh === true, JSON.stringify(j)); }
  // 3) 首次接触：?token= -> 302 + HttpOnly Cookie + 去 token
  let cookie = "";
  { const r = await fetch(`${BASE}/?token=${TOKEN}`, { redirect: "manual" });
    const sc = r.headers.getSetCookie?.() ?? [];
    cookie = sc.find((c) => c.startsWith("dsh_gw=")) ?? "";
    check("首次接触 -> 302", r.status === 302, `got ${r.status}`);
    check("Set-Cookie HttpOnly", /dsh_gw=[^;]+;.*HttpOnly/i.test(cookie), cookie);
    check("302 已去 token", (r.headers.get("location") ?? "") === "/", r.headers.get("location")); }
  // 4) 无 Cookie -> 401
  { const r = await fetch(`${BASE}/`); check("无 Cookie GET / -> 401", r.status === 401, `got ${r.status}`); }
  // 5) 带 Cookie GET / -> DSH 首页 + __DSH_BOOT__
  { const r = await fetch(`${BASE}/`, { headers: { cookie } }); const t = await r.text();
    check("带 Cookie GET / -> 200 + __DSH_BOOT__", r.status === 200 && t.includes("__DSH_BOOT__"), `got ${r.status}`); }
  // 6) 静态资源 immutable（资产哈希随 DSH 版本变化，从首页 HTML 动态取，避免硬编码过期）
  { const home = await fetch(`${BASE}/`, { headers: { cookie } }); const h = await home.text();
    const m = h.match(/assets\/index-[A-Za-z0-9]+\.js/);
    const assetPath = m ? m[0] : "assets/index-Dqw48FrP.js";
    const r = await fetch(`${BASE}/${assetPath}`, { headers: { cookie } });
    const cc = r.headers.get("cache-control") ?? "";
    check("静态资源 immutable 缓存", r.status === 200 && cc.includes("immutable"), `cc=${cc} status=${r.status} asset=${assetPath}`); }
  // 7) /api RPC 到达 DSH 业务层
  { const eps = ["session/query", "agent/presets", "llm/providers", "settings/describe", "conversation/query"];
    let got = false;
    for (const ep of eps) {
      const r = await fetch(`${BASE}/api/${ep}`, { method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ type: "client-request", rpcId: "t-1", method: ep, payload: { args: {} } }) });
      const t = await r.text();
      if (r.status !== 401 && r.status !== 403) { got = true; console.log(`    /api/${ep} -> ${r.status} ${t.slice(0, 120)}`); break; }
    }
    check("/api RPC 到达 DSH 业务层", got); }
  // 8) /api 无 Cookie -> 401
  { const r = await fetch(`${BASE}/api/session/query`, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "t-2", method: "session/query", payload: { args: {} } }) });
    check("无 Cookie /api -> 401", r.status === 401, `got ${r.status}`); }
  // 9) WS 无 Cookie -> 403
  { const code = await new Promise((resolve) => {
      const ws = new WebSocket(`${WS_BASE}/api/events.mux`, { handshakeTimeout: 3000 });
      ws.on("open", () => { ws.close(); resolve(101); });
      ws.on("unexpected-response", (q, r) => resolve(r.statusCode));
      ws.on("error", () => resolve(0)); });
    check("WS 无 Cookie -> 403", code === 403, `got ${code}`); }
  // 10) WS 带 Cookie -> 连接成功（活动时收帧；空闲保持打开也算通过）
  //     v0.2.2：收到的帧必须是「文本帧」——网关曾把文本帧转成二进制帧，
  //     手机端 dsh-client-connection 只认文本帧导致无法发送消息。
  { const outcome = await new Promise((resolve) => {
      const ws = new WebSocket(`${WS_BASE}/api/events.mux`, { headers: { cookie }, handshakeTimeout: 5000 });
      let opened = false; let closed = false;
      const timer = setTimeout(() => { try { ws.close(); } catch {} resolve({ opened, frames: 0, closed, stayedOpen: opened && !closed }); }, 6000);
      ws.on("open", () => { opened = true; });
      ws.on("message", (d, isBinary) => { clearTimeout(timer); ws.close(); resolve({ opened, frames: 1, sample: d.toString().slice(0, 120), isBinary }); });
      ws.on("close", () => { closed = true; });
      ws.on("unexpected-response", (q, r) => { clearTimeout(timer); resolve({ opened, frames: 0, code: r.statusCode }); });
      ws.on("error", (e) => { clearTimeout(timer); resolve({ opened, frames: 0, err: e.message }); }); });
    const ok = outcome.opened && (
      (outcome.frames > 0 && outcome.isBinary === false) ||   // 收到帧必须为文本帧
      outcome.stayedOpen === true);                            // 或空闲保持打开
    check("WS 带 Cookie 连接成功(收文本帧)", ok, JSON.stringify(outcome));
    if (outcome.sample) console.log(`    首帧: ${outcome.sample}`); }
  // 11) 配对页（回环）有二维码
  { const r = await fetch(`${BASE}/pair`);
    const t = await r.text();
    check("配对页 200 + QR", r.status === 200 && t.includes("data:image/png;base64"), `got ${r.status}`); }
  // 12) 配对信息 / 轮换 / 撤销（实例方法，供设置面板路由使用）
  {
    const info = await instance.getPairingInfo();
    check("getPairingInfo: qr + 链接", !!info && info.qr.startsWith("data:image/png;base64,") && info.pairingUrl.startsWith("dshm://v1/") && Array.isArray(info.links.lan), JSON.stringify(info).slice(0, 140));
    const before = instance.token;
    const rotated = await instance.rotateToken();
    check("rotateToken 换令牌", !!rotated && rotated.token !== before && rotated.token !== TOKEN && rotated.qr.startsWith("data:image/png;base64,"), `same=${rotated.token === before}`);
    const rev = instance.revokeSessions();
    check("revokeSessions 清会话", !!rev && rev.ok === true && typeof rev.revoked === "number", JSON.stringify(rev));
  }
  // 13) 清理关闭
  await instance.close();
  check("实例 close() 正常", true);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("测试异常:", e); process.exit(1); });
