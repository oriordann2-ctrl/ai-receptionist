(function () {
  "use strict";

  var BACKEND = "https://app.sprimal.com";

  // ── Prevent double-init ──────────────────────────────────────────────────
  if (window.__sprimalWidget) return;
  window.__sprimalWidget = true;

  // ── Tenant config — read data-* attributes from the <script> tag ────────
  var scriptTag = document.currentScript || (function () {
    var scripts = document.getElementsByTagName("script");
    return scripts[scripts.length - 1];
  })();
  var clubId     = (scriptTag && scriptTag.getAttribute("data-club-id"))     || "aom";
  var botName    = (scriptTag && scriptTag.getAttribute("data-bot-name"))    || "Maeve";
  var clubName   = (scriptTag && scriptTag.getAttribute("data-club-name"))   || "At Once Mortgages";
  var fullscreen = (scriptTag && scriptTag.getAttribute("data-fullscreen")) === "true";

  // ── Session IDs ──────────────────────────────────────────────────────────
  var userId = "user-" + Math.random().toString(36).slice(2, 10);
  var conversationId = sessionStorage.getItem("sprimal_conv_" + clubId);
  if (!conversationId) {
    conversationId = "conv-" + Date.now();
    sessionStorage.setItem("sprimal_conv_" + clubId, conversationId);
  }

  // ── Load Inter font from Google Fonts ────────────────────────────────────
  if (!document.getElementById("sprimal-font")) {
    var fontLink = document.createElement("link");
    fontLink.id   = "sprimal-font";
    fontLink.rel  = "stylesheet";
    fontLink.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap";
    document.head.appendChild(fontLink);
  }

  // ── Styles ───────────────────────────────────────────────────────────────
  var FONT = "'Inter',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
  var style = document.createElement("style");
  style.textContent = [
    "#sprimal-btn{position:fixed;bottom:24px;right:24px;z-index:99999;width:56px;height:56px;border-radius:50%;background:#111827;border:none;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;transition:transform .2s;}",
    "#sprimal-btn:hover{transform:scale(1.08);}",
    "#sprimal-btn svg{width:26px;height:26px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}",
    "#sprimal-badge{position:absolute;top:-4px;right:-4px;background:#ef4444;color:#fff;font-size:11px;font-weight:700;width:18px;height:18px;border-radius:50%;display:none;align-items:center;justify-content:center;font-family:Arial,sans-serif;}",
    "#sprimal-panel{position:fixed;bottom:92px;right:24px;z-index:99998;width:370px;max-width:calc(100vw - 32px);height:540px;max-height:calc(100vh - 120px);background:#f8f9fc;border-radius:18px;box-shadow:0 12px 40px rgba(0,0,0,.16);display:flex;flex-direction:column;overflow:hidden;transition:opacity .2s,transform .2s;}",
    "#sprimal-panel.sprimal-hidden{opacity:0;transform:translateY(12px);pointer-events:none;}",
    "#sprimal-header{background:#111827;color:#fff;padding:14px 18px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}",
    "#sprimal-header-left{display:flex;align-items:center;gap:10px;}",
    "#sprimal-avatar{width:38px;height:38px;border-radius:50%;background:#374151;overflow:hidden;display:flex;align-items:center;justify-content:center;flex-shrink:0;}",
    "#sprimal-avatar img{width:100%;height:100%;object-fit:cover;}",
    "#sprimal-header-info{display:flex;flex-direction:column;}",
    "#sprimal-header-name{font-size:15px;font-weight:700;font-family:" + FONT + ";letter-spacing:-0.01em;}",
    "#sprimal-header-sub{font-size:12px;color:#93c5fd;font-family:" + FONT + ";margin-top:1px;font-weight:400;}",
    "#sprimal-header-right{display:flex;align-items:center;gap:10px;}",
    "#sprimal-online-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;flex-shrink:0;}",
    "#sprimal-close{background:rgba(255,255,255,0.12);border:none;border-radius:50%;cursor:pointer;color:#e2e8f0;font-size:16px;line-height:1;width:28px;height:28px;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s;flex-shrink:0;}",
    "#sprimal-close:hover{background:rgba(255,255,255,0.22);color:#fff;}",
    "#sprimal-end{background:none;border:none;cursor:pointer;color:#9ca3af;font-size:11px;font-family:" + FONT + ";font-weight:500;padding:4px 6px;border-radius:8px;transition:color .15s,background .15s;flex-shrink:0;white-space:nowrap;}",
    "#sprimal-end:hover{color:#e2e8f0;background:rgba(255,255,255,0.08);}",
    "#sprimal-end.sprimal-end-confirm{color:#fca5a5;font-weight:600;}",
    "#sprimal-messages{flex:1;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;gap:8px;background:#f8f9fc;}",
    "#sprimal-messages::-webkit-scrollbar{width:4px;}",
    "#sprimal-messages::-webkit-scrollbar-track{background:transparent;}",
    "#sprimal-messages::-webkit-scrollbar-thumb{background:#d1d5db;border-radius:4px;}",
    ".sprimal-msg{max-width:84%;padding:11px 15px;border-radius:18px;font-size:14px;line-height:1.55;font-family:" + FONT + ";word-wrap:break-word;white-space:pre-wrap;letter-spacing:-0.01em;}",
    ".sprimal-bot{background:#fff;color:#1f2937;align-self:flex-start;border-bottom-left-radius:5px;box-shadow:0 1px 4px rgba(0,0,0,0.07);}",
    ".sprimal-user{background:#111827;color:#fff;align-self:flex-end;border-bottom-right-radius:5px;}",
    ".sprimal-typing{display:flex;gap:4px;padding:12px 15px;align-items:center;background:#fff;border-radius:18px;border-bottom-left-radius:5px;box-shadow:0 1px 4px rgba(0,0,0,0.07);}",
    ".sprimal-dot{width:7px;height:7px;border-radius:50%;background:#93c5fd;animation:sprimal-bounce .9s infinite ease-in-out;}",
    ".sprimal-dot:nth-child(2){animation-delay:.15s;}",
    ".sprimal-dot:nth-child(3){animation-delay:.3s;}",
    "@keyframes sprimal-bounce{0%,80%,100%{transform:translateY(0);}40%{transform:translateY(-6px);}}",
    "#sprimal-footer{padding:10px 12px;border-top:1px solid #e9ecf3;background:#fff;display:flex;gap:8px;align-items:center;flex-shrink:0;}",
    "#sprimal-input{flex:1;border:1.5px solid #e2e8f0;border-radius:22px;padding:9px 16px;font-size:14px;font-family:" + FONT + ";outline:none;resize:none;transition:border-color .15s;background:#f8f9fc;color:#1f2937;}",
    "#sprimal-input::placeholder{color:#9ca3af;}",
    "#sprimal-input:focus{border-color:#111827;background:#fff;}",
    "#sprimal-send{width:36px;height:36px;flex-shrink:0;background:#111827;color:#fff;border:none;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s;padding:0;}",
    "#sprimal-send:hover{background:#1f2937;}",
    "#sprimal-send:disabled{background:#d1d5db;cursor:not-allowed;}",
    "#sprimal-choices{padding:2px 0 6px;display:flex;flex-wrap:wrap;gap:7px;align-self:flex-start;max-width:92%;}",
    ".sprimal-choice{background:#fff;border:1.5px solid #111827;border-radius:20px;padding:7px 16px;font-size:13px;font-family:" + FONT + ";cursor:pointer;color:#111827;font-weight:500;transition:background .12s,color .12s;white-space:nowrap;line-height:1.4;letter-spacing:-0.01em;}",
    ".sprimal-choice:hover{background:#111827;color:#fff;}",
    ".sprimal-choice-ai{border:1.5px dashed #d1d5db;color:#6b7280;font-weight:400;}",
    ".sprimal-choice-ai:hover{background:#f1f5f9;color:#374151;border-color:#9ca3af;}",
    "@media(max-width:640px){#sprimal-panel{width:100vw;max-width:100vw;right:0;left:0;bottom:0;height:78vh;max-height:78vh;border-radius:22px 22px 0 0;}#sprimal-panel.sprimal-hidden{transform:translateY(100%);}#sprimal-btn{bottom:88px;right:16px;}}",
  ].join("");
  document.head.appendChild(style);

  // ── Fullscreen override (QR / standalone page) ───────────────────────────
  if (fullscreen) {
    var fsStyle = document.createElement("style");
    fsStyle.textContent = [
      "html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#111827;}",
      "#sprimal-btn{display:none!important;}",
      "#sprimal-panel{position:fixed!important;inset:0!important;width:100%!important;height:100%!important;",
      "max-width:100%!important;max-height:100%!important;bottom:0!important;right:0!important;",
      "border-radius:0!important;box-shadow:none!important;}",
      "#sprimal-close{display:none!important;}",
    ].join("");
    document.head.appendChild(fsStyle);
  }

  // ── Launcher button ──────────────────────────────────────────────────────
  var btn = document.createElement("button");
  btn.id = "sprimal-btn";
  btn.setAttribute("aria-label", "Chat with Maeve");
  btn.innerHTML = [
    '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    '<div id="sprimal-badge">1</div>'
  ].join("");
  document.body.appendChild(btn);

  // ── Chat panel ───────────────────────────────────────────────────────────
  var panel = document.createElement("div");
  panel.id = "sprimal-panel";
  panel.className = "sprimal-hidden";

  // AOM uses the full chat-aom.html page in an iframe — preloaded immediately
  if (clubId === "aom") {
    panel.style.cssText += "padding:0;overflow:hidden;";
    panel.innerHTML = [
      '<div id="sprimal-iframe-loader" style="position:absolute;inset:0;background:#0f2a5e;display:flex;align-items:center;justify-content:center;border-radius:16px;z-index:1;">',
      '  <div style="display:flex;gap:6px;">',
      '    <div style="width:8px;height:8px;border-radius:50%;background:#93c5fd;animation:sprimal-bounce .9s infinite ease-in-out;"></div>',
      '    <div style="width:8px;height:8px;border-radius:50%;background:#93c5fd;animation:sprimal-bounce .9s .15s infinite ease-in-out;"></div>',
      '    <div style="width:8px;height:8px;border-radius:50%;background:#93c5fd;animation:sprimal-bounce .9s .3s infinite ease-in-out;"></div>',
      '  </div>',
      '</div>',
      '<iframe id="sprimal-iframe" src="' + BACKEND + '/chat/aom" allow="clipboard-write" style="width:100%;height:100%;border:none;border-radius:16px;display:block;position:relative;z-index:2;"></iframe>'
    ].join("");
    document.body.appendChild(panel);
  } else {
    var defaultAvatarSvg = '<svg viewBox="0 0 48 48" fill="none" style="width:100%;height:100%;"><rect width="48" height="48" rx="11" fill="#4f76f6"/><line x1="24" y1="11" x2="38.5" y2="36" stroke="white" stroke-width="3" stroke-linecap="round"/><line x1="38.5" y1="36" x2="9.5" y2="36" stroke="white" stroke-width="3" stroke-linecap="round"/><line x1="9.5" y1="36" x2="24" y2="11" stroke="white" stroke-width="3" stroke-linecap="round"/><circle cx="24" cy="11" r="4.5" fill="white"/><circle cx="38.5" cy="36" r="4.5" fill="white"/><circle cx="9.5" cy="36" r="4.5" fill="white"/></svg>';
    panel.innerHTML = [
      '<div id="sprimal-header">',
      '  <div id="sprimal-header-left">',
      '    <div id="sprimal-avatar">' + defaultAvatarSvg + '</div>',
      '    <div id="sprimal-header-info">',
      '      <span id="sprimal-header-name">' + botName + '</span>',
      '      <span id="sprimal-header-sub">' + clubName + '</span>',
      '    </div>',
      '  </div>',
      '  <div id="sprimal-header-right">',
      '    <button id="sprimal-end" aria-label="End chat">End chat</button>',
      '    <div id="sprimal-online-dot"></div>',
      '    <button id="sprimal-close" aria-label="Close chat">&times;</button>',
      '  </div>',
      '</div>',
      '<div id="sprimal-messages"></div>',
      '<div id="sprimal-footer">',
      '  <input id="sprimal-input" type="text" placeholder="Type a message..." autocomplete="off" />',
      '  <button id="sprimal-send" aria-label="Send">',
      '    <svg viewBox="0 0 24 24" style="width:18px;height:18px;fill:white;pointer-events:none;"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>',
      '  </button>',
      '</div>'
    ].join("");
    document.body.appendChild(panel);
  }

  // ── Refs ─────────────────────────────────────────────────────────────────
  var messages  = document.getElementById("sprimal-messages");
  var input     = document.getElementById("sprimal-input");
  var sendBtn   = document.getElementById("sprimal-send");
  var closeBtn  = document.getElementById("sprimal-close");
  var endBtn    = document.getElementById("sprimal-end");
  var badge     = document.getElementById("sprimal-badge");
  var iframe    = document.getElementById("sprimal-iframe");
  var iframeLoader = document.getElementById("sprimal-iframe-loader");

  // Hide the loading overlay once the iframe has loaded
  if (iframe && iframeLoader) {
    iframe.addEventListener("load", function() {
      iframeLoader.style.display = "none";
    });
  }

  var isOpen    = false;
  var hasOpened = false;

  // ── Message history persistence (survives panel close/reopen & page nav) ──
  var MSG_STORE = "sprimal_history_" + clubId;

  function saveHistory() {
    if (clubId === "aom" || !messages) return;
    try {
      var items = [];
      var nodes = messages.children;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        // Skip transient elements — typing dots and choice buttons
        if (n.id === "sprimal-typing" || n.id === "sprimal-choices") continue;
        items.push({ cls: n.className, inner: n.innerHTML });
      }
      sessionStorage.setItem(MSG_STORE, JSON.stringify({ ts: Date.now(), items: items }));
    } catch (e) {}
  }

  function loadHistory() {
    if (clubId === "aom" || !messages) return false;
    try {
      var raw = sessionStorage.getItem(MSG_STORE);
      if (!raw) return false;
      var data = JSON.parse(raw);
      // Expire after 30 minutes
      if (!data || !data.items || !data.items.length || (Date.now() - data.ts) > 1800000) {
        sessionStorage.removeItem(MSG_STORE);
        return false;
      }
      // Only restore if the user actually typed something — otherwise restart
      // the workflow fresh (avoids restoring a blank AI-mode state from button-only sessions)
      var hasUserMsg = data.items.some(function (item) {
        return item.cls && item.cls.indexOf("sprimal-user") !== -1;
      });
      if (!hasUserMsg) {
        sessionStorage.removeItem(MSG_STORE);
        return false;
      }
      data.items.forEach(function (item) {
        var div = document.createElement("div");
        div.className = item.cls;
        div.innerHTML = item.inner; // safe — only our own rendered markup
        messages.appendChild(div);
      });
      messages.scrollTop = messages.scrollHeight;
      return true;
    } catch (e) { return false; }
  }

  // ── Workflow state ────────────────────────────────────────────────────────
  var wfSteps    = [];       // sorted steps for the currently-active flow
  var wfFlowMap  = {};       // { flowId: sortedSteps[] } — all flows pre-fetched for switch_flow
  var wfMode     = false;
  var rootFlowId = null;     // ID of the entry-point (active) flow — used for "Back to menu"
  var lastWorkflowMsg = null; // last workflow bot_message shown — passed as context to AI so it can answer follow-up questions
  var brandColor = "#111827"; // updated when tenant config loads

  // Pre-fetch all flows in background (non-AOM only)
  if (clubId !== "aom") {
    fetch(BACKEND + "/api/workflow/" + clubId)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        // Build lookup map for all flows
        (d.allFlows || []).forEach(function (f) {
          if (f.workflow_steps && f.workflow_steps.length) {
            wfFlowMap[f.id] = f.workflow_steps.slice().sort(function (a, b) { return a.step_order - b.step_order; });
          }
        });
        // Entry point = the active (root) flow
        if (d.workflow && d.workflow.workflow_steps && d.workflow.workflow_steps.length) {
          wfSteps = wfFlowMap[d.workflow.id] || [];
          rootFlowId = d.workflow.id;
        }
        // Fullscreen mode: auto-open now that wfSteps is ready
        if (fullscreen && !hasOpened) openPanel();
      })
      .catch(function () {
        // Fullscreen mode: open even if workflow fetch failed (AI mode)
        if (fullscreen && !hasOpened) openPanel();
      });
  }

  // Fullscreen with AOM: open immediately
  if (fullscreen && clubId === "aom") {
    setTimeout(openPanel, 50);
  }

  // ── Fetch tenant config and update branding ───────────────────────────────
  if (clubId !== "aom") {
    fetch(BACKEND + "/api/tenant-config/" + clubId)
      .then(function (r) { return r.json(); })
      .then(function (config) {
        if (config.name) {
          clubName = config.name;
          var sub = document.getElementById("sprimal-header-sub");
          if (sub) sub.textContent = config.name;
        }
        // Always try the favicon proxy — comes from our own domain, no hotlinking issues
        var avatar = document.getElementById("sprimal-avatar");
        if (avatar) {
          var img = document.createElement("img");
          img.src = BACKEND + "/api/tenant-favicon/" + clubId;
          img.alt = config.name || clubName;
          img.style.cssText = "width:100%;height:100%;object-fit:cover;border-radius:50%;";
          img.onerror = function () { avatar.innerHTML = defaultAvatarSvg; };
          avatar.innerHTML = "";
          avatar.appendChild(img);
        }
        // Apply brand colour if available
        if (config.brand_color) {
          brandColor = config.brand_color;
          applyBrandColor(config.brand_color);
        }
      })
      .catch(function () { /* silently keep defaults */ });
  }

  // ── Brand colour — inject dynamic CSS ────────────────────────────────────
  function applyBrandColor(color) {
    var el = document.getElementById("sprimal-brand-style");
    if (!el) {
      el = document.createElement("style");
      el.id = "sprimal-brand-style";
      document.head.appendChild(el);
    }
    el.textContent = [
      "#sprimal-header{background:" + color + "!important;}",
      "#sprimal-send{background:" + color + "!important;}",
      "#sprimal-send:hover{background:" + color + ";filter:brightness(0.88)!important;}",
      "#sprimal-send:disabled{background:" + color + ";opacity:0.4!important;}",
      ".sprimal-user{background:" + color + "!important;}",
      ".sprimal-choice{border-color:" + color + "!important;color:" + color + "!important;}",
      ".sprimal-choice:hover{background:" + color + "!important;color:#fff!important;}",
      "#sprimal-input:focus{border-color:" + color + "!important;}",
    ].join("");
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function stripHtml(str) {
    return str.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim();
  }

  function addMsg(text, sender) {
    var div = document.createElement("div");
    div.className = "sprimal-msg sprimal-" + sender;
    div.textContent = stripHtml(text);
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    saveHistory();
    return div;
  }

  // Workflow bot messages — supports safe inline markup from DB content:
  //   [warn]...[/warn]  → light red + bold  (warnings)
  //   [b]...[/b]        → bold              (key info)
  //   [link]url[/link]  → clickable link    (URLs)
  // Everything else is plain text — no XSS risk.
  function addWorkflowMsg(text) {
    var div = document.createElement("div");
    div.className = "sprimal-msg sprimal-bot";
    // Supports: [warn]...[/warn]  [b]...[/b]  [link]url[/link]  [link=url]Label[/link]
    var tagRe = /(\[warn\][\s\S]*?\[\/warn\]|\[b\][\s\S]*?\[\/b\]|\[link(?:=[^\]]+)?\][\s\S]*?\[\/link\])/;
    var parts = text.split(tagRe);
    parts.forEach(function (part) {
      if (!part) return;
      var warnM  = part.match(/^\[warn\]([\s\S]*?)\[\/warn\]$/);
      var boldM  = part.match(/^\[b\]([\s\S]*?)\[\/b\]$/);
      var linkM  = part.match(/^\[link\]([\s\S]*?)\[\/link\]$/);         // [link]url[/link]
      var linkLM = part.match(/^\[link=([^\]]+)\]([\s\S]*?)\[\/link\]$/);// [link=url]Label[/link]
      if (warnM) {
        var span = document.createElement("span");
        span.style.color = "#ef4444";
        span.style.fontWeight = "600";
        span.textContent = warnM[1];
        div.appendChild(span);
      } else if (boldM) {
        var strong = document.createElement("strong");
        strong.textContent = boldM[1];
        div.appendChild(strong);
      } else if (linkLM) {
        var href  = linkLM[1].trim();
        var label = linkLM[2].trim();
        var a = document.createElement("a");
        a.href = href.startsWith("http") ? href : "https://" + href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = label;
        a.style.cssText = "color:#2563eb;font-weight:600;text-decoration:underline;";
        div.appendChild(a);
      } else if (linkM) {
        var raw = linkM[1].trim();
        var a = document.createElement("a");
        a.href = raw.startsWith("http") ? raw : "https://" + raw;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = raw;
        a.style.cssText = "color:#2563eb;font-weight:600;text-decoration:underline;word-break:break-all;";
        div.appendChild(a);
      } else {
        div.appendChild(document.createTextNode(part));
      }
    });
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    saveHistory();
    return div;
  }

  function showTyping() {
    var el = document.createElement("div");
    el.className = "sprimal-msg sprimal-bot sprimal-typing";
    el.id = "sprimal-typing";
    el.innerHTML = '<div class="sprimal-dot"></div><div class="sprimal-dot"></div><div class="sprimal-dot"></div>';
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
  }

  function hideTyping() {
    var el = document.getElementById("sprimal-typing");
    if (el) el.parentNode.removeChild(el);
  }

  function showBadge() {
    badge.style.display = "flex";
  }

  function hideBadge() {
    badge.style.display = "none";
  }

  // ── Workflow helpers ──────────────────────────────────────────────────────

  // Remove the choice-buttons container from the panel
  function clearChoices() {
    var el = document.getElementById("sprimal-choices");
    if (el) el.parentNode.removeChild(el);
  }

  // Switch from button-menu mode → text input mode
  function enableTextInput() {
    wfMode = false;
    clearChoices();
    var footer = document.getElementById("sprimal-footer");
    if (footer) footer.style.display = "flex";
    if (input) { input.value = ""; input.focus(); }
  }

  // Show a subtle "Back to main menu" button after an AI reply in text mode
  function showBackToMenu() {
    if (!rootFlowId || !wfFlowMap[rootFlowId]) return;
    var existing = document.getElementById("sprimal-back-menu");
    if (existing) existing.parentNode.removeChild(existing);
    var container = document.createElement("div");
    container.id = "sprimal-back-menu";
    container.style.cssText = "padding:4px 0 6px;align-self:flex-start;";
    var menuBtn = document.createElement("button");
    menuBtn.className = "sprimal-choice sprimal-choice-ai";
    menuBtn.textContent = "↩ Back to main menu";
    menuBtn.addEventListener("click", function () {
      var el = document.getElementById("sprimal-back-menu");
      if (el) el.parentNode.removeChild(el);
      wfSteps = wfFlowMap[rootFlowId];
      wfMode = true;
      var footer = document.getElementById("sprimal-footer");
      if (footer) footer.style.display = "none";
      showWorkflowStep(wfSteps[0]);
    });
    container.appendChild(menuBtn);
    messages.appendChild(container);
    messages.scrollTop = messages.scrollHeight;
  }

  // Remove the back-to-menu button (called when user sends a new message)
  function clearBackToMenu() {
    var el = document.getElementById("sprimal-back-menu");
    if (el) el.parentNode.removeChild(el);
  }

  // Render a workflow step: bot message + choice buttons
  function showWorkflowStep(step) {
    if (!step) return;
    lastWorkflowMsg = step.bot_message || null; // remember for AI follow-up context
    addWorkflowMsg(step.bot_message);

    var choices = (step.workflow_choices || []).slice().sort(function (a, b) { return a.choice_order - b.choice_order; });

    clearChoices();
    var container = document.createElement("div");
    container.id  = "sprimal-choices";

    // Shared selection handler — fades unselected buttons, fills selected one
    function selectAndProceed(btn, allBtns, action) {
      allBtns.forEach(function (b) {
        b.disabled = true;
        b.style.opacity = "0.4";
        b.style.cursor = "default";
      });
      btn.style.opacity = "1";
      btn.style.background = brandColor;
      btn.style.color = "#fff";
      btn.style.borderColor = brandColor;
      setTimeout(action, 280);
    }

    var allBtns = [];

    choices.forEach(function (ch) {
      var btn = document.createElement("button");
      btn.className = "sprimal-choice";
      btn.textContent = ch.label;
      allBtns.push(btn);
      btn.addEventListener("click", function () {
        selectAndProceed(btn, allBtns, function () { handleChoice(ch); });
      });
      container.appendChild(btn);
    });

    // Always offer AI fallback
    var aiBtn = document.createElement("button");
    aiBtn.className = "sprimal-choice sprimal-choice-ai";
    aiBtn.textContent = "🤖 Ask something else";
    allBtns.push(aiBtn);
    aiBtn.addEventListener("click", function () {
      selectAndProceed(aiBtn, allBtns, function () { clearChoices(); enableTextInput(); });
    });
    container.appendChild(aiBtn);

    // Append inside the scrollable messages area — flows inline like AOM
    messages.appendChild(container);
    messages.scrollTop = messages.scrollHeight;
  }

  // Handle a button press in the workflow
  function handleChoice(choice) {
    addMsg(choice.label, "user");  // echo the user's selection
    clearChoices();

    var type = choice.action_type;
    var val  = choice.action_value || "";

    if (type === "next_step") {
      var order   = parseInt(val, 10);
      var nextStep = wfSteps.find(function (s) { return s.step_order === order; });
      if (nextStep) {
        showWorkflowStep(nextStep);
      } else {
        addMsg("I can help with that! Feel free to type your question below.", "bot");
        enableTextInput();
      }

    } else if (type === "message") {
      addMsg(val || "Thank you!", "bot");
      // Offer a restart button after terminal message
      setTimeout(function () {
        var container = document.createElement("div");
        container.id  = "sprimal-choices";
        var restartBtn = document.createElement("button");
        restartBtn.className = "sprimal-choice sprimal-choice-ai";
        restartBtn.textContent = "↩ Back to menu";
        restartBtn.addEventListener("click", function () {
          clearChoices();
          if (wfSteps.length) showWorkflowStep(wfSteps[0]);
        });
        container.appendChild(restartBtn);
        var aiBtn2 = document.createElement("button");
        aiBtn2.className = "sprimal-choice sprimal-choice-ai";
        aiBtn2.textContent = "🤖 Ask something else";
        aiBtn2.addEventListener("click", function () { clearChoices(); enableTextInput(); });
        container.appendChild(aiBtn2);
        messages.appendChild(container);
        messages.scrollTop = messages.scrollHeight;
      }, 300);

    } else if (type === "url") {
      if (val) window.open(val, "_blank");
      addMsg("Opening that page for you 👍\n\nIs there anything else I can help with?", "bot");
      setTimeout(function () {
        clearChoices();
        var urlChoices = document.createElement("div");
        urlChoices.id = "sprimal-choices";
        // Back to main menu — only if we have the root flow
        if (rootFlowId && wfFlowMap[rootFlowId]) {
          var backBtn = document.createElement("button");
          backBtn.className = "sprimal-choice sprimal-choice-ai";
          backBtn.textContent = "↩ Back to main menu";
          backBtn.addEventListener("click", function () {
            clearChoices();
            wfSteps = wfFlowMap[rootFlowId];
            wfMode = true;
            var footer = document.getElementById("sprimal-footer");
            if (footer) footer.style.display = "none";
            showWorkflowStep(wfSteps[0]);
          });
          urlChoices.appendChild(backBtn);
        }
        // Always offer free-text fallback
        var askBtn = document.createElement("button");
        askBtn.className = "sprimal-choice sprimal-choice-ai";
        askBtn.textContent = "💬 Ask a question";
        askBtn.addEventListener("click", function () { clearChoices(); enableTextInput(); });
        urlChoices.appendChild(askBtn);
        messages.appendChild(urlChoices);
        messages.scrollTop = messages.scrollHeight;
      }, 300);

    } else if (type === "switch_flow") {
      var targetSteps = wfFlowMap[val];
      if (targetSteps && targetSteps.length) {
        wfSteps = targetSteps;
        showWorkflowStep(wfSteps[0]);
      } else {
        addMsg("Let me help you with that! Feel free to type your question below.", "bot");
        enableTextInput();
      }

    } else if (type === "ai_fallback") {
      addMsg("Sure! What would you like to know?", "bot");
      enableTextInput();

    } else if (type === "agent") {
      // Start an agent session — send trigger to backend, show response + agent choices
      showTyping();
      fetch(BACKEND + "/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: userId, conversationId: conversationId, message: "", clubId: clubId, agentTrigger: val })
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          hideTyping();
          if (data.reply) addMsg(data.reply, "bot");
          if (data.agentChoices && data.agentChoices.length) {
            showAgentChoices(data.agentChoices, { multiSelect: data.multiSelect, maxSelect: data.maxSelect });
          } else {
            enableTextInput();
          }
        })
        .catch(function () {
          hideTyping();
          addMsg("Sorry, I couldn't connect. Please try again.", "bot");
          enableTextInput();
        });
    }
  }

  // Persists across day-switches so selections accumulate across dates
  var agentSelectedSlots = [];

  // Render agent choice buttons (returned from /chat agentChoices array).
  // Choices may be strings, {label,value,badge?,secondary?} objects, or
  // {label,value,badge,slots:[]} objects — the last form triggers the court accordion.
  function showAgentChoices(choices, opts) {
    var multiSelect  = opts && opts.multiSelect;
    var maxSelect    = (opts && opts.maxSelect) || 3;
    var resetSlots   = opts && opts.resetSlots;
    if (resetSlots) agentSelectedSlots = [];

    clearChoices();
    var container = document.createElement("div");
    container.id  = "sprimal-choices";

    var isAccordion = choices.length > 0 && typeof choices[0] === "object" && Array.isArray(choices[0].slots);

    if (isAccordion) {
      // ── Court accordion: court buttons on top, slot panel below ────────────
      var courtBtns       = [];
      var currentSlotBtns = [];
      // Use module-level array so selections survive day switches
      var selectedSlots   = agentSelectedSlots;

      var courtRow = document.createElement("div");
      courtRow.style.cssText = "display:flex;flex-wrap:wrap;gap:7px;";

      var slotPanel = document.createElement("div");
      slotPanel.style.cssText = "display:none;flex-direction:column;gap:0;padding-top:10px;margin-top:6px;border-top:1.5px solid #e5e7eb;width:100%;";

      // Multi-select footer (counter + confirm button) — built once, moved into slotPanel
      var msFooter = null;
      var msCounter = null;
      var msConfirm = null;
      if (multiSelect) {
        msFooter = document.createElement("div");
        msFooter.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;padding-top:8px;border-top:1px dashed #e5e7eb;width:100%;";

        msCounter = document.createElement("span");
        msCounter.style.cssText = "font-size:13px;font-weight:600;font-family:" + FONT + ";color:#9ca3af;transition:color 0.2s;";
        msCounter.textContent = "0 of " + maxSelect + " selected";

        msConfirm = document.createElement("button");
        msConfirm.className = "sprimal-choice";
        msConfirm.textContent = "Confirm →";
        msConfirm.disabled = true;
        msConfirm.style.cssText = "opacity:0.35;padding:6px 16px;font-size:13px;font-weight:600;";
        msConfirm.addEventListener("click", function () {
          if (!selectedSlots.length) return;
          courtBtns.forEach(function (b) { b.disabled = true; b.style.opacity = "0.4"; });
          currentSlotBtns.forEach(function (b) { b.disabled = true; b.style.opacity = "0.4"; });
          msConfirm.disabled = true; msConfirm.style.opacity = "0.4";
          var displayText = selectedSlots.map(function (s) { return s.label; }).join(", ");
          var value       = selectedSlots.map(function (s) { return s.value; }).join(" | ");
          agentSelectedSlots = []; // reset after confirming
          setTimeout(function () { sendAgentMessage(value, displayText); }, 280);
        });
        msFooter.appendChild(msCounter);
        msFooter.appendChild(msConfirm);
      }

      function updateCounter() {
        if (!msCounter) return;
        var n = selectedSlots.length;
        msCounter.textContent   = n + " of " + maxSelect + " selected";
        msCounter.style.color   = n > 0 ? "#16a34a" : "#9ca3af";
        msConfirm.disabled      = n === 0;
        msConfirm.style.opacity = n > 0 ? "1" : "0.35";
      }

      choices.forEach(function (choice) {
        var btn = document.createElement("button");
        btn.className = "sprimal-choice";
        btn.style.cssText = "display:inline-flex;align-items:center;gap:6px;";
        courtBtns.push(btn);

        var labelSpan = document.createElement("span");
        labelSpan.textContent = choice.label;
        btn.appendChild(labelSpan);

        // Green badge showing free-slot count
        if (choice.badge != null) {
          var badgeEl = document.createElement("span");
          badgeEl.textContent = choice.badge;
          badgeEl.style.cssText = "background:#dcfce7;color:#16a34a;font-size:11px;font-weight:700;border-radius:10px;padding:1px 6px;flex-shrink:0;";
          btn.appendChild(badgeEl);
        }

        (function (choice, btn) {
          btn.addEventListener("click", function () {
            // Highlight selected court, reset others
            courtBtns.forEach(function (cb) {
              cb.style.background  = "";
              cb.style.color       = "";
              cb.style.borderColor = "";
            });
            btn.style.background  = brandColor;
            btn.style.color       = "#fff";
            btn.style.borderColor = brandColor;

            // Rebuild slot panel for this court
            var slotBtnRow = document.createElement("div");
            slotBtnRow.style.cssText = "display:flex;flex-wrap:wrap;gap:7px;";
            while (slotPanel.firstChild) slotPanel.removeChild(slotPanel.firstChild);
            currentSlotBtns = [];

            choice.slots.forEach(function (slot) {
              var slotBtn = document.createElement("button");
              slotBtn.className = "sprimal-choice";
              slotBtn.style.cssText = "display:inline-flex;align-items:center;gap:5px;";

              var slotLabel = document.createElement("span");
              slotLabel.textContent = slot.label;
              slotBtn.appendChild(slotLabel);

              // Restore selected state if this slot was previously picked
              var alreadySelected = selectedSlots.some(function (s) { return s.value === slot.value; });
              if (alreadySelected) {
                slotBtn.style.background  = brandColor;
                slotBtn.style.color       = "#fff";
                slotBtn.style.borderColor = brandColor;
                var tick = document.createElement("span");
                tick.textContent = "✓";
                tick.style.cssText = "font-size:11px;font-weight:700;";
                slotBtn.appendChild(tick);
              }
              currentSlotBtns.push(slotBtn);

              if (multiSelect) {
                slotBtn.addEventListener("click", function () {
                  var idx = selectedSlots.findIndex(function (s) { return s.value === slot.value; });
                  if (idx >= 0) {
                    // Deselect
                    selectedSlots.splice(idx, 1);
                    slotBtn.style.background  = "";
                    slotBtn.style.color       = "";
                    slotBtn.style.borderColor = "";
                    // Remove tick if present
                    var t = slotBtn.querySelector("span:last-child");
                    if (t && t.textContent === "✓") slotBtn.removeChild(t);
                  } else if (selectedSlots.length < maxSelect) {
                    // Select
                    selectedSlots.push({ label: slot.label, value: slot.value });
                    slotBtn.style.background  = brandColor;
                    slotBtn.style.color       = "#fff";
                    slotBtn.style.borderColor = brandColor;
                    var tick = document.createElement("span");
                    tick.textContent = "✓";
                    tick.style.cssText = "font-size:11px;font-weight:700;";
                    slotBtn.appendChild(tick);
                  }
                  updateCounter();
                });
              } else {
                slotBtn.addEventListener("click", function () {
                  courtBtns.forEach(function (b) { b.disabled = true; b.style.opacity = "0.4"; });
                  currentSlotBtns.forEach(function (b) { b.disabled = true; b.style.opacity = "0.4"; });
                  slotBtn.style.opacity     = "1";
                  slotBtn.style.background  = brandColor;
                  slotBtn.style.color       = "#fff";
                  slotBtn.style.borderColor = brandColor;
                  setTimeout(function () { sendAgentMessage(slot.value, slot.label); }, 280);
                });
              }
              slotBtnRow.appendChild(slotBtn);
            });

            slotPanel.appendChild(slotBtnRow);
            if (multiSelect) {
              // "Change day" link lets user go back to the day picker without losing selections
              var changeDayBtn = document.createElement("button");
              changeDayBtn.className = "sprimal-choice sprimal-choice-ai";
              changeDayBtn.textContent = "← Change day";
              changeDayBtn.style.cssText = "margin-top:6px;font-size:12px;padding:5px 12px;";
              changeDayBtn.addEventListener("click", function () {
                courtBtns.forEach(function (b) { b.disabled = true; b.style.opacity = "0.4"; });
                currentSlotBtns.forEach(function (b) { b.disabled = true; b.style.opacity = "0.4"; });
                changeDayBtn.disabled = true;
                setTimeout(function () { sendAgentMessage("__back_to_days__", "← Change day"); }, 200);
              });
              slotPanel.appendChild(changeDayBtn);
            }
            if (multiSelect && msFooter) slotPanel.appendChild(msFooter);
            slotPanel.style.display = "flex";
            updateCounter();
            messages.scrollTop = messages.scrollHeight;
          });
        })(choice, btn);

        courtRow.appendChild(btn);
      });

      container.appendChild(courtRow);
      container.appendChild(slotPanel);

    } else {
      // ── Flat choices (strings or {label,value,badge?,secondary?}) ──────────
      var allBtns = [];
      choices.forEach(function (choice) {
        var label     = typeof choice === "string" ? choice : (choice.label || String(choice));
        var value     = typeof choice === "string" ? choice : (choice.value != null ? choice.value : label);
        var badge     = typeof choice === "object" ? choice.badge : null;
        var secondary = typeof choice === "object" && choice.secondary;

        var btn = document.createElement("button");
        btn.className = secondary ? "sprimal-choice sprimal-choice-ai" : "sprimal-choice";

        if (badge != null) {
          btn.style.cssText = "display:inline-flex;align-items:center;gap:8px;justify-content:space-between;min-width:110px;";
          var labelSpan = document.createElement("span");
          labelSpan.textContent = label;
          var badgeEl = document.createElement("span");
          badgeEl.textContent = badge;
          badgeEl.style.cssText = "background:#f1f5f9;color:#475569;font-size:11px;font-weight:700;border-radius:10px;padding:1px 7px;flex-shrink:0;";
          btn.appendChild(labelSpan);
          btn.appendChild(badgeEl);
        } else {
          btn.textContent = label;
        }

        // External link button — style with an arrow icon
        if (typeof value === "string" && value.startsWith("__url__")) {
          btn.style.cssText = "display:inline-flex;align-items:center;gap:6px;";
          var arrSpan = document.createElement("span");
          arrSpan.textContent = "↗";
          arrSpan.style.cssText = "font-size:12px;";
          btn.appendChild(arrSpan);
        }

        allBtns.push(btn);
        btn.addEventListener("click", function () {
          allBtns.forEach(function (b) { b.disabled = true; b.style.opacity = "0.4"; });
          btn.style.opacity = "1";
          // External URL — open in new tab, don't send to bot
          if (typeof value === "string" && value.startsWith("__url__")) {
            window.open(value.slice(7), "_blank", "noopener,noreferrer");
            return;
          }
          if (!secondary) { btn.style.background = brandColor; btn.style.color = "#fff"; btn.style.borderColor = brandColor; }
          setTimeout(function () { sendAgentMessage(value, label); }, 280);
        });
        container.appendChild(btn);
      });
    }

    messages.appendChild(container);
    messages.scrollTop = messages.scrollHeight;
  }

  // Send a message as part of an active agent session
  // displayText is what appears in the chat bubble; text is what goes to the backend
  function sendAgentMessage(text, displayText) {
    clearChoices();
    addMsg(displayText || text, "user");
    showTyping();
    fetch(BACKEND + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: userId, conversationId: conversationId, message: text, clubId: clubId })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        hideTyping();
        if (data.reply) addMsg(data.reply, "bot");
        if (data.agentChoices && data.agentChoices.length) {
          showAgentChoices(data.agentChoices, { multiSelect: data.multiSelect, maxSelect: data.maxSelect });
        } else {
          // Agent complete or asking for typed input
          enableTextInput();
          if (!data.agentChoices) showBackToMenu();
        }
      })
      .catch(function () {
        hideTyping();
        addMsg("Sorry, I couldn't connect. Please try again.", "bot");
        enableTextInput();
      });
  }

  // ── Send message ─────────────────────────────────────────────────────────
  function send() {
    var text = input.value.trim();
    if (!text) return;

    clearBackToMenu();
    addMsg(text, "user");
    input.value = "";
    sendBtn.disabled = true;
    showTyping();

    var payload = { userId: userId, conversationId: conversationId, message: text, clubId: clubId };
    if (lastWorkflowMsg) { payload.workflowContext = lastWorkflowMsg; lastWorkflowMsg = null; }

    fetch(BACKEND + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        hideTyping();
        addMsg(data.reply || "Sorry, something went wrong.", "bot");
        sendBtn.disabled = false;
        // If agent returned choices, show them; otherwise stay in text mode
        if (data.agentChoices && data.agentChoices.length) {
          showAgentChoices(data.agentChoices, { multiSelect: data.multiSelect, maxSelect: data.maxSelect });
        } else {
          input.focus();
          showBackToMenu();
        }
      })
      .catch(function () {
        hideTyping();
        addMsg("Sorry, I couldn't connect. Please try again.", "bot");
        sendBtn.disabled = false;
        showBackToMenu();
      });
  }

  // ── Open / close ──────────────────────────────────────────────────────────
  function isMobile() { return window.innerWidth <= 640; }

  function openPanel() {
    isOpen = true;
    panel.classList.remove("sprimal-hidden");
    hideBadge();
    if (isMobile()) btn.style.display = "none";

    if (clubId === "aom") {
      // iframe already preloaded — nothing to do
    } else {
      if (!hasOpened) {
        if (loadHistory()) {
          // Restored previous session — show text input so they can continue
          var footer = document.getElementById("sprimal-footer");
          if (footer) footer.style.display = "flex";
          setTimeout(function () { if (input) input.focus(); }, 100);
        } else if (wfSteps.length) {
          // Fresh start — workflow mode: hide footer, show button menu
          wfMode = true;
          var footer = document.getElementById("sprimal-footer");
          if (footer) footer.style.display = "none";
          addMsg("Hi there 👋 I'm " + botName + ", your " + clubName + " assistant.", "bot");
          showWorkflowStep(wfSteps[0]);
        } else {
          // Fresh start — standard AI mode
          var greeting = "Hi there 👋 I'm " + botName + ", your " + clubName + " assistant.\n\nWhat would you like to know?";
          addMsg(greeting, "bot");
          setTimeout(function () { if (input) input.focus(); }, 100);
        }
      }
    }
    hasOpened = true;
  }

  function closePanel() {
    isOpen = false;
    panel.classList.add("sprimal-hidden");
    btn.style.display = "flex"; // always restore button on close
  }

  // ── End chat — clears history and restarts the flow ───────────────────────
  function endChat() {
    try { sessionStorage.removeItem(MSG_STORE); } catch(e) {}
    // Clear all message content
    while (messages && messages.firstChild) messages.removeChild(messages.firstChild);
    clearChoices();
    // Reset to root flow and show greeting
    if (rootFlowId && wfFlowMap[rootFlowId]) wfSteps = wfFlowMap[rootFlowId];
    if (wfSteps.length) {
      wfMode = true;
      var footer = document.getElementById("sprimal-footer");
      if (footer) footer.style.display = "none";
      addMsg("Hi there 👋 I'm " + botName + ", your " + clubName + " assistant.", "bot");
      showWorkflowStep(wfSteps[0]);
    } else {
      var footer = document.getElementById("sprimal-footer");
      if (footer) footer.style.display = "flex";
      addMsg("Hi there 👋 I'm " + botName + ", your " + clubName + " assistant.\n\nWhat would you like to know?", "bot");
    }
  }

  // Double-tap confirmation on End chat button
  var endConfirmPending = false;
  var endConfirmTimer   = null;
  if (endBtn) {
    endBtn.addEventListener("click", function () {
      if (endConfirmPending) {
        // Second tap — go ahead
        clearTimeout(endConfirmTimer);
        endConfirmPending = false;
        endBtn.textContent = "End chat";
        endBtn.classList.remove("sprimal-end-confirm");
        endChat();
      } else {
        // First tap — ask to confirm
        endConfirmPending = true;
        endBtn.textContent = "Tap again to end";
        endBtn.classList.add("sprimal-end-confirm");
        endConfirmTimer = setTimeout(function () {
          endConfirmPending = false;
          endBtn.textContent = "End chat";
          endBtn.classList.remove("sprimal-end-confirm");
        }, 3000);
      }
    });
  }

  // ── Events ────────────────────────────────────────────────────────────────
  btn.addEventListener("click", function () {
    if (isOpen) { closePanel(); } else { openPanel(); }
  });

  if (closeBtn) closeBtn.addEventListener("click", closePanel);

  if (sendBtn) sendBtn.addEventListener("click", send);

  if (input) input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // ── Show badge after 5 seconds if not opened ─────────────────────────────
  if (!fullscreen) {
    setTimeout(function () {
      if (!hasOpened) showBadge();
    }, 5000);
  }

  // ── Fullscreen: auto-open (triggered by workflow fetch completing below) ──
  // openPanel() is called at the end of the workflow fetch .then()/.catch()
  // so wfSteps is guaranteed to be populated before the panel opens.

})();
