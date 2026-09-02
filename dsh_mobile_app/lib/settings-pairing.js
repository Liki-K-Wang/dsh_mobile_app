/**
 * dsh_mobile_app — lib/settings-pairing.js
 *
 * 在 DSH Web GUI 的「设置」弹窗里注入一个「手机配对 · 管理连接」入口：
 *  - 设置左侧导航追加一个「手机配对」项（对所有客户端生效，桌面端也能用）；
 *    v0.3.1 起该项样式与原生设置导航项（navCell）逐属性统一；
 *  - v0.3.6 起点击「手机配对」不再弹全屏浮层，而是在设置弹窗内容区（.options）内
 *    渲染为一个分节（与通用设置/模型/Agent 预设一致）：标题 + 说明 + 二维码卡片 +
 *    border-bottom 行（局域网/远程地址、配对码）+ DSH 主/次/危险按钮。
 *    实现：在 .options 上挂一个绝对定位覆盖层（.options 设 position:relative），
 *    底部常驻 React 分节不动 —— 切到其他导航项天然还原，无需与 React 状态打架；
 *    React 重绘擦掉覆盖层时由观察器用缓存数据补回；选中态用 :has() 压制原生高亮。
 *  - 点击后加载：
 *      · 配对二维码（GET /api/dsh-mobile/pair 返回 dataURL）
 *      · 局域网 / 远程（Tailscale/隧道）地址列表（可复制）
 *      · 配对码（默认打码，可显示/复制）
 *      · 重新生成配对码（POST .../regenerate，轮换令牌）
 *      · 撤销所有连接（POST .../revoke，清空会话）
 *  - 导航项用 MutationObserver 在被 React 重绘后自动补回。
 *
 * 注入脚本对所有客户端生效（无移动端判定），幂等；设置弹窗不存在时无操作。
 */
const SETTINGS_MARKER = "data-dsh-pairing";

const SETTINGS_SCRIPT = `<style ${SETTINGS_MARKER}="1">
  /* v0.3.6：配对改为设置弹窗内容区内的一个分节（与通用设置/模型/Agent 预设一致），
     不再弹全屏浮层。分节样式对齐 DSH section 视觉语言（rtSEdW / zGbnIq）：
     max-width:720px 容器、18px/600 标题、13px tertiary 说明、border-bottom 行、DSH 按钮。 */
  [role=dialog][aria-modal=true] [class$=_options]{position:relative}
  /* v0.3.7：覆盖层加不透明背景（与设置弹窗面板同款 --dsw-alias-bg-layer-2），
     否则底层 React 分节透出来，配对分节和其他分节视觉重合。 */
  #dsh-pair-section{position:absolute;inset:0;overflow-y:auto;padding:0 24px 24px;z-index:2;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
  #dsh-pair-section .pp-body{max-width:720px;width:100%;margin:0 auto;display:flex;flex-direction:column;gap:12px}
  #dsh-pair-section .pp-title{margin:0;font-size:18px;font-weight:600;line-height:1.3}
  #dsh-pair-section .pp-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}
  #dsh-pair-section .pp-qr{display:flex;justify-content:center;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:14px}
  #dsh-pair-section .pp-qr img{width:min(220px,60vw);height:auto;border-radius:10px;background:#fff;padding:6px}
  #dsh-pair-section .pp-row{display:flex;align-items:center;gap:10px;padding:14px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
  #dsh-pair-section .pp-rowText{flex:1;flex-direction:column;gap:4px;min-width:0;display:flex}
  #dsh-pair-section .pp-title2{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
  #dsh-pair-section .pp-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
  #dsh-pair-section .pp-code{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;word-break:break-all;color:var(--dsw-alias-label-secondary)}
  #dsh-pair-section .pp-links{display:flex;flex-direction:column;gap:4px;width:100%;min-width:0}
  #dsh-pair-section .pp-link{display:flex;align-items:center;gap:8px;min-width:0}
  #dsh-pair-section .pp-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:4px}
  #dsh-pair-section .pp-empty{color:var(--dsw-alias-label-tertiary);opacity:.7}
  #dsh-pair-section .pp-btn{height:36px;padding:0 14px;border-radius:18px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:14px;font-weight:400;line-height:22px;transition:background .15s ease}
  #dsh-pair-section .pp-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
  #dsh-pair-section .pp-btn:disabled{opacity:.5;cursor:default}
  #dsh-pair-section .pp-btn.primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-specific-accent));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
  #dsh-pair-section .pp-btn.primary:hover{background:var(--dsw-alias-button-primary-fill-hover,var(--dsw-specific-accent))}
  #dsh-pair-section .pp-btn.danger{color:var(--dsw-alias-text-danger);border-color:var(--dsw-alias-text-danger)}
  #dsh-pair-section .pp-btn.danger:hover{background:var(--dsw-alias-text-danger);color:#fff}
  #dsh-pair-section .pp-err{color:var(--dsw-alias-text-danger);font-size:13px}
  /* 「手机配对」导航项：样式与 DSH 原生设置导航项（SettingsRoot.module.css 的 navCell）逐属性一致，
     v0.3.6 选中态：用 :has() 在配对选中时压制所有原生 navCell 的高亮背景（不触碰 React 的 active
     类，切换/还原零冲突），只高亮配对项自身。 */
  [data-dsh-pair-cell]{box-sizing:border-box;cursor:pointer;height:40px;width:100%;color:var(--dsw-alias-label-primary);text-align:left;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;padding:9px 16px 9px 12px;font-family:inherit;font-size:14px;font-weight:400;line-height:22px;display:flex;-webkit-tap-highlight-color:transparent}
  [data-dsh-pair-cell]:hover{background:var(--dsw-specific-sidebar-nav-item-hover)}
  [data-dsh-pair-cell]:active{background:var(--dsw-specific-sidebar-nav-item-active)}
  [data-dsh-pair-cell] span{white-space:nowrap;text-overflow:ellipsis;flex:1;min-width:0;overflow:hidden}
  [role=dialog][aria-modal=true] [class$=_navList]:has([data-dsh-pair-selected]) [class$=_navCell]{background:transparent}
  [data-dsh-pair-cell][data-dsh-pair-selected]{background:var(--dsw-specific-sidebar-nav-item-active)}
  @media (max-width:1023px){ [data-dsh-pair-cell]{justify-content:center;width:38px;height:38px;padding:0} [data-dsh-pair-cell] span{display:none} }
</style>
<script ${SETTINGS_MARKER}="1">
(function(){
  var NS = "dsh_mobile_app";
  var pairingSelected = false;
  var lastPairData = null;

  function dialogEl(){ return document.querySelector('[role="dialog"][aria-modal="true"]'); }
  function navListEl(){ var d = dialogEl(); return d ? d.querySelector("[class$=_navList]") : null; }
  function optionsEl(){ var d = dialogEl(); return d ? d.querySelector("[class$=_options]") : null; }
  function cellEl(){ var nl = navListEl(); return nl ? nl.querySelector("[data-dsh-pair-cell]") : null; }
  function cellPresent(){ return !!cellEl(); }
  function sectionEl(){ var o = optionsEl(); return o ? o.querySelector("[data-dsh-pair-section]") : null; }
  function ensureCell(){
    try {
      var nl = navListEl();
      if (!nl || cellPresent()) return;
      var cell = document.createElement("button");
      cell.type = "button";
      cell.setAttribute("data-dsh-pair-cell", "1");
      cell.setAttribute("role", "tab");
      cell.setAttribute("aria-selected", "false");
      // 图标 16px：与原生设置导航项 navIcon（IconXxxOutline16, size:16）同尺寸
      cell.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg><span>手机配对</span>';
      // 点击由 document capture 统一处理（showPairingSection），此处监听作为兜底（幂等）
      cell.addEventListener("click", showPairingSection);
      nl.appendChild(cell);
    } catch (e) {}
  }

  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
  function copyText(t, btn){
    var done = function(){ var o = btn.textContent; btn.textContent = "已复制"; setTimeout(function(){ btn.textContent = o; }, 1200); };
    var fallback = function(){ try { var ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); done(); } catch (e) {} };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, fallback);
    else fallback();
  }

  function setCellSelected(on){
    var c = cellEl();
    if (!c) return;
    if (on) c.setAttribute("data-dsh-pair-selected", "1");
    else c.removeAttribute("data-dsh-pair-selected");
  }
  function ensureSection(){
    var o = optionsEl();
    if (!o) return null;
    var sec = o.querySelector("[data-dsh-pair-section]");
    if (!sec) {
      sec = document.createElement("div");
      sec.id = "dsh-pair-section";
      sec.setAttribute("data-dsh-pair-section", "1");
      o.appendChild(sec);
    }
    return sec;
  }

  function showPairingSection(){
    try {
      var sec = ensureSection();
      if (!sec) return;
      pairingSelected = true;
      setCellSelected(true);
      if (lastPairData) renderPairInfo(sec, lastPairData);
      else loadPairInfo(sec);
    } catch (e) {}
  }
  function hidePairing(){
    try {
      pairingSelected = false;
      setCellSelected(false);
      var sec = sectionEl();
      if (sec) sec.remove();
    } catch (e) {}
  }

  function renderError(body, msg){
    body.innerHTML = '<div class="pp-err">' + esc(msg) + '</div>' +
      '<div><button type="button" class="pp-btn primary" data-pair-retry>重试</button></div>';
    var b = body.querySelector("[data-pair-retry]");
    if (b) b.addEventListener("click", function(){ loadPairInfo(body); });
  }

  function loadPairInfo(sec){
    fetch("/api/dsh-mobile/pair", { method: "GET", credentials: "same-origin", cache: "no-store" })
      .then(function(r){ if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function(data){ lastPairData = data; renderPairInfo(sec, data); })
      .catch(function(e){ renderError(sec, "获取配对信息失败：" + e.message + "（网关未就绪或会话过期）"); });
  }

  function renderPairInfo(body, data){
    var linksRows = function(title, desc, list){
      var items = (list && list.length) ? list.map(function(it){
        return '<div class="pp-link"><code class="pp-code">' + esc(it) + '</code>' +
          '<button type="button" class="pp-btn" data-pair-copy="' + esc(it) + '">复制</button></div>';
      }).join("") : '<div class="pp-empty">（未检测到）</div>';
      return '<div class="pp-row"><div class="pp-rowText"><div class="pp-title2">' + title + '</div>' +
        (desc ? '<div class="pp-desc">' + desc + '</div>' : '') +
        '<div class="pp-links">' + items + '</div></div></div>';
    };
    var tokenShown = false;
    body.innerHTML =
      '<div class="pp-body">' +
        '<div class="pp-title">手机配对 · 管理连接</div>' +
        '<p class="pp-intro">扫码即可让手机安全连接本机 DSH；不在同一网络时，手机装 Tailscale 并登录同一账号即可远程访问。</p>' +
        '<div class="pp-qr">' + (data.qr ? '<img src="' + data.qr + '" alt="配对二维码"/>' : '<div class="pp-empty">二维码不可用</div>') + '</div>' +
        linksRows("局域网地址", "同一 WiFi / 网段可直接访问", data.links && data.links.lan) +
        linksRows("远程地址", "Tailscale / 隧道，需手机登录同一账号", data.links && data.links.wan) +
        '<div class="pp-row"><div class="pp-rowText"><div class="pp-title2">配对码</div>' +
          '<div class="pp-links"><div class="pp-link"><code class="pp-code" data-pair-token>' + (data.token ? esc(data.token.slice(0, 8)) + "…" : "") + '</code>' +
          '<button type="button" class="pp-btn" data-pair-reveal>显示</button>' +
          '<button type="button" class="pp-btn" data-pair-copy-token>复制</button></div></div></div></div>' +
        '<div class="pp-actions">' +
          '<button type="button" class="pp-btn primary" data-pair-regen>重新生成配对码</button>' +
          '<button type="button" class="pp-btn danger" data-pair-revoke>撤销所有连接</button>' +
        '</div>' +
      '</div>';

    body.querySelectorAll("[data-pair-copy]").forEach(function(b){
      b.addEventListener("click", function(){ copyText(b.getAttribute("data-pair-copy"), b); });
    });
    var tokenEl = body.querySelector("[data-pair-token]");
    body.querySelector("[data-pair-reveal]").addEventListener("click", function(){
      tokenShown = !tokenShown;
      tokenEl.textContent = tokenShown ? data.token : (data.token ? data.token.slice(0, 8) + "…" : "");
      this.textContent = tokenShown ? "隐藏" : "显示";
    });
    body.querySelector("[data-pair-copy-token]").addEventListener("click", function(){
      copyText(data.token || "", this);
    });
    body.querySelector("[data-pair-regen]").addEventListener("click", function(){
      if (!confirm("重新生成后，旧二维码立即失效。确定继续？")) return;
      var btn = this; btn.disabled = true; btn.textContent = "生成中…";
      fetch("/api/dsh-mobile/pair/regenerate", { method: "POST", credentials: "same-origin", cache: "no-store" })
        .then(function(r){ if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function(d){ lastPairData = d; renderPairInfo(body, d); })
        .catch(function(e){ renderError(body, "重新生成失败：" + e.message); });
    });
    body.querySelector("[data-pair-revoke]").addEventListener("click", function(){
      if (!confirm("将断开所有已配对的手机（需重新扫码）。确定继续？")) return;
      var btn = this; btn.disabled = true;
      fetch("/api/dsh-mobile/pair/revoke", { method: "POST", credentials: "same-origin", cache: "no-store" })
        .then(function(r){ if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function(){ btn.textContent = "已撤销"; })
        .catch(function(e){ btn.textContent = "撤销失败"; renderError(body, "撤销失败：" + e.message); });
    });
  }

  // document capture：点击任何设置导航项 → 先于 React onClick 处理配对选中/隐藏。
  // 点「手机配对」→ 显示分节；点其他导航项 → 隐藏覆盖层（底层 React 分节一直在，天然还原）。
  function armNavCapture(){
    document.addEventListener("click", function(e){
      var el = e.target;
      while (el && el !== document.body) {
        if (el.getAttribute && el.getAttribute("data-dsh-pair-cell")) { showPairingSection(); return; }
        if (el.classList && el.classList.toString().indexOf("_navCell") > -1) { hidePairing(); return; }
        el = el.parentElement;
      }
    }, true);
  }

  // 设置弹窗出现时确保导航项存在；被 React 重绘后自动补回。
  // 观察器常驻：页面加载很久后再打开设置，入口仍能注入；开销可忽略——无设置弹窗时回调提前返回。
  function arm(){
    try {
      var raf = null;
      var onMutations = function(){
        raf = null;
        if (!cellPresent()) ensureCell();
        // 配对选中但覆盖层被 React 重绘擦掉 → 用缓存数据补回（不重新请求，避免闪屏）
        if (pairingSelected) {
          if (!sectionEl() && optionsEl()) {
            var s = ensureSection();
            if (s) { if (lastPairData) renderPairInfo(s, lastPairData); else loadPairInfo(s); }
          }
        }
        // 弹窗关闭 → 重置选中态
        if (!dialogEl() && pairingSelected) pairingSelected = false;
      };
      var obs = new MutationObserver(function(){
        if (raf !== null) return;
        raf = requestAnimationFrame(onMutations);
      });
      obs.observe(document.body, { childList: true, subtree: true });
      armNavCapture();
      ensureCell();
    } catch (e) {}
  }
  if (document.body) arm();
  else document.addEventListener("DOMContentLoaded", arm);
})();
</script>`;

/**
 * 把设置配对入口注入 index.html（幂等：已注入则原样返回）。
 * @param {string} html - DSH 前端 index.html 内容。
 * @returns {string} 注入后的 HTML。
 */
export function injectSettingsPairing(html) {
	if (typeof html !== "string") return html;
	if (html.includes(SETTINGS_MARKER)) return html;
	if (html.includes("</head>")) {
		return html.replace("</head>", `<!-- dsh-mobile-pairing -->\n${SETTINGS_SCRIPT}\n</head>`);
	}
	return `<!-- dsh-mobile-pairing -->\n${SETTINGS_SCRIPT}\n${html}`;
}

export { SETTINGS_MARKER };
