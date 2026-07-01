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
    "#sprimal-messages{flex:1;overflow-y:auto;padding:16px 14px 32px;display:flex;flex-direction:column;gap:8px;background:#f8f9fc;}",
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
    "#sprimal-gdpr{padding:10px 14px;background:#f0f9ff;border-top:1px solid #bae6fd;display:flex;flex-direction:column;gap:8px;flex-shrink:0;}",
    "#sprimal-gdpr p{font-size:12px;color:#374151;font-family:" + FONT + ";line-height:1.5;margin:0;}",
    "#sprimal-gdpr a{color:#2563eb;text-decoration:underline;}",
    "#sprimal-gdpr-accept{background:#111827;color:#fff;border:none;border-radius:8px;padding:7px 14px;font-size:12px;font-weight:600;font-family:" + FONT + ";cursor:pointer;align-self:flex-start;}",
    "#sprimal-gdpr-accept:hover{background:#1f2937;}",
    "#sprimal-choices{padding:2px 0 6px;display:flex;flex-direction:column;gap:9px;align-self:stretch;max-width:92%;}",
    ".sprimal-choice{background:#fff;border:1.5px solid #111827;border-radius:20px;padding:12px 16px;font-size:13px;font-family:" + FONT + ";cursor:pointer;color:#111827;font-weight:500;transition:background .12s,color .12s;white-space:normal;line-height:1.4;letter-spacing:-0.01em;text-align:left;width:100%;box-sizing:border-box;}",
    ".sprimal-choice:hover{background:#111827;color:#fff;}",
    ".sprimal-choice-ai{border:1.5px dashed #d1d5db;color:#6b7280;font-weight:400;}",
    ".sprimal-choice-ai:hover{background:#f1f5f9;color:#374151;border-color:#9ca3af;}",
    "#sprimal-lead-form{padding:10px 14px 8px;background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:14px;margin-top:4px;align-self:flex-start;max-width:92%;}",
    ".sprimal-lead-input{width:100%;box-sizing:border-box;border:1.5px solid #e2e8f0;border-radius:10px;padding:8px 12px;font-size:13px;font-family:" + FONT + ";outline:none;background:#fff;color:#1f2937;margin-bottom:8px;display:block;}",
    ".sprimal-lead-input:focus{border-color:#22c55e;}",
    ".sprimal-lead-submit{background:#22c55e;color:#fff;border:none;border-radius:10px;padding:9px 0;font-size:13px;font-weight:600;font-family:" + FONT + ";cursor:pointer;width:100%;transition:background .15s;margin-top:2px;}",
    ".sprimal-lead-submit:hover{background:#16a34a;}",
    ".sprimal-lead-submit:disabled{background:#d1d5db;cursor:not-allowed;}",
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
      '<div id="sprimal-gdpr">',
      '  <p>By chatting you agree to our <a href="https://www.sprimal.com/privacy" target="_blank" rel="noopener">Privacy Policy</a>. We may store your name and contact details to respond to your enquiry.</p>',
      '  <button id="sprimal-gdpr-accept">I understand, let\'s chat</button>',
      '</div>',
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

  // ── GDPR consent banner ──────────────────────────────────────────────────
  var gdprBanner     = document.getElementById("sprimal-gdpr");
  var gdprAcceptBtn  = document.getElementById("sprimal-gdpr-accept");
  var gdprKey        = "sprimal_gdpr_" + clubId;
  var gdprAccepted   = localStorage.getItem(gdprKey) === "1";

  function applyGdprState() {
    if (gdprAccepted) {
      if (gdprBanner) gdprBanner.style.display = "none";
    } else {
      if (gdprBanner) gdprBanner.style.display = "flex";
      if (input)  { input.disabled = true;  input.placeholder = "Please accept the privacy notice below…"; }
      if (sendBtn) sendBtn.disabled = true;
    }
  }

  if (gdprAcceptBtn) {
    gdprAcceptBtn.addEventListener("click", function () {
      gdprAccepted = true;
      localStorage.setItem(gdprKey, "1");
      if (gdprBanner) gdprBanner.style.display = "none";
      if (input)  { input.disabled = false; input.placeholder = "Type a message…"; input.focus(); }
      if (sendBtn) sendBtn.disabled = false;
    });
  }

  applyGdprState();

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
      scrollToBottom(100);
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
  var wfFetchDone        = false; // true once workflow fetch has returned
  var openedBeforeWfFetch = false; // true if panel opened before fetch returned (race condition guard)

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
        wfFetchDone = true;
        // Race condition fix: if the panel was already opened before this fetch returned,
        // it will have shown the plain AI greeting instead of the workflow buttons.
        // Replace with workflow now — even if the panel is currently closed (user may
        // have opened, seen the greeting, closed it, and will reopen later).
        // Guard: only replace if no user messages have been sent yet.
        if (openedBeforeWfFetch && wfSteps.length && !wfMode) {
          var hasUserMsg = messages && messages.querySelector(".sprimal-user");
          if (!hasUserMsg) {
            if (messages) messages.innerHTML = "";
            wfMode = true;
            var footer = document.getElementById("sprimal-footer");
            if (footer) footer.style.display = "none";
            showWorkflowStep(wfSteps[0]);
          }
        }
        // Fullscreen mode: auto-open now that wfSteps is ready
        if (fullscreen && !hasOpened) openPanel();
      })
      .catch(function () {
        wfFetchDone = true;
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
        if (config.assistant_name) {
          botName = config.assistant_name;
          var nameEl = document.getElementById("sprimal-header-name");
          if (nameEl) nameEl.textContent = config.assistant_name;
        }
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
        // Apply hero background photo if set
        if (config.widget_hero_image) {
          var header = document.getElementById("sprimal-header");
          if (header) {
            // Use gradient overlay + image so text stays readable
            header.style.background = "linear-gradient(rgba(0,0,0,0.55),rgba(0,0,0,0.55)), url(" + config.widget_hero_image + ") center/cover no-repeat";
          }
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

  function escapeHtml(str) {
    return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  // Inline SVG icon library — no CDN, no font loading, renders instantly
  var ICON_SVG = {
    'calendar':       '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    'map-pin':        '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    'trophy':         '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
    'users':          '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    'school':         '<path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>',
    'message-circle': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    'star':           '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    'phone':          '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13 19.79 19.79 0 0 1 1.62 4.35 2 2 0 0 1 3.61 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9a16 16 0 0 0 6.09 6.09l.89-.89a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>',
    'clock':          '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    'info-circle':    '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    'mail':           '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
    'id-card':        '<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="12" r="2"/><path d="M15 9h3M15 12h3M15 15h3"/>',
    'credit-card':    '<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
    'bell':           '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    'camera':         '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
    'dumbbell':       '<path d="M2 12h1M21 12h1M6 8v8M18 8v8M2 9h4v6H2zM18 9h4v6h-4z"/>',
    'pool':           '<path d="M2 12h20M7 4l5 8 5-8"/><path d="M2 17c1.5 2 3 2 4.5 0s3-2 4.5 0 3 2 4.5 0 3-2 4.5 0"/>',
    'building':       '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M12 6h.01M12 10h.01M8 10h.01M16 10h.01M12 14h.01M8 14h.01M16 14h.01"/>',
  };

  function makeIconSvg(name) {
    var paths = ICON_SVG[name];
    if (!paths) return '';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0;">' + paths + '</svg>';
  }

  // Social media platform detection + circular button renderer
  var SOCIAL_PLATFORMS = {
    instagram: { color: '#E1306C', icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98C.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>' },
    twitter:   { color: '#000000', icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="white"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.259 5.632L18.244 2.25zM17.083 20.003h1.834L7.084 4.126H5.117z"/></svg>' },
    facebook:  { color: '#1877F2', icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>' },
    linkedin:  { color: '#0A66C2', icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>' },
    youtube:   { color: '#FF0000', icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>' },
    tiktok:    { color: '#010101', icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.34 6.34 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.86a8.27 8.27 0 004.84 1.54V6.95a4.85 4.85 0 01-1.07-.26z"/></svg>' },
    google:    { color: '#ffffff', icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>' },
  };

  function getSocialPlatform(url) {
    if (!url) return null;
    var u = url.toLowerCase();
    if (u.indexOf('instagram.com') !== -1) return 'instagram';
    if (u.indexOf('twitter.com') !== -1 || u.indexOf('x.com/') !== -1) return 'twitter';
    if (u.indexOf('facebook.com') !== -1 || u.indexOf('fb.com') !== -1) return 'facebook';
    if (u.indexOf('linkedin.com') !== -1) return 'linkedin';
    if (u.indexOf('youtube.com') !== -1 || u.indexOf('youtu.be') !== -1) return 'youtube';
    if (u.indexOf('tiktok.com') !== -1) return 'tiktok';
    if (u.indexOf('search.google.com/local/writereview') !== -1 || u.indexOf('g.page/r/') !== -1 || u.indexOf('google.com/maps') !== -1) return 'google';
    return null;
  }

  // Emoji → icon name (keys must match ICON_SVG)
  var EMOJI_ICON = {
    '🎾':'trophy','🏆':'trophy','📅':'calendar','🗓':'calendar','📍':'map-pin',
    '🏫':'school','🎓':'school','💬':'message-circle','❓':'message-circle','⭐':'star',
    '🌟':'star','📞':'phone','☎':'phone','📱':'phone','🕐':'clock','⏰':'clock',
    'ℹ':'info-circle','📧':'mail','✉':'mail','🏠':'building','🏡':'building',
    '💳':'credit-card','💰':'credit-card','🏋':'dumbbell','💪':'dumbbell',
    '⛳':'trophy','🎟':'calendar','🎫':'calendar','👥':'users','👤':'users',
    '🏛':'building','🏢':'building','🏟':'building','📸':'camera','📷':'camera',
    '🔔':'bell','📣':'bell','📌':'map-pin','🚗':'map-pin','🚌':'map-pin',
    '🏅':'trophy','🥇':'trophy','🎉':'star','🏵':'trophy','🤝':'users',
    '⚽':'trophy','🏊':'pool','🚴':'dumbbell','🧘':'dumbbell','🏃':'dumbbell',
  };

  var LABEL_ICON = [
    [/member|join|registr|subscri|annual fee/i,         'id-card'],
    [/coach|camp|lesson|class|train|junior|youth/i,     'school'],
    [/court|book|availab|reserv|slot|tee time/i,        'calendar'],
    [/event|league|tournam|competi|match|fixture|open week|open day/i, 'trophy'],
    [/find|location|address|direct|map|where|parking/i, 'map-pin'],
    [/sponsor|partner/i,                                'star'],
    [/contact|phone|call|reach/i,                       'phone'],
    [/email|message|enquir/i,                           'mail'],
    [/hour|opening time|when.*open/i,                   'clock'],
    [/about|history|club info/i,                        'info-circle'],
    [/price|cost|pay|fee|tariff/i,                      'credit-card'],
    [/news|update|announcement|notice/i,                'bell'],
    [/photo|gallery|image/i,                            'camera'],
    [/swim|pool/i,                                      'pool'],
    [/gym|fitness|workout/i,                            'dumbbell'],
    [/follow|social|instagram|facebook|twitter/i,       'users'],
    [/review|feedback|rate us|google/i,                 'star'],
    [/something else|other|more|question|help/i,        'message-circle'],
    [/building|venue|facility/i,                        'building'],
  ];

  function getTablerIcon(label) {
    if (!label) return '';
    var iconName = '';
    var cp = label.codePointAt(0);
    if (cp && cp > 127) {
      iconName = EMOJI_ICON[String.fromCodePoint(cp)] || '';
    }
    if (!iconName) {
      var clean = stripLeadingEmoji(label);
      for (var k = 0; k < LABEL_ICON.length; k++) {
        if (LABEL_ICON[k][0].test(clean)) { iconName = LABEL_ICON[k][1]; break; }
      }
    }
    return makeIconSvg(iconName);
  }

  function stripLeadingEmoji(label) {
    if (!label) return label;
    return label.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]️?⃣?\s*/u, '').trim();
  }

  function getPlatformLogo(actionType, actionValue) {
    if (actionType !== "url" || !actionValue) return "";
    if (actionValue.indexOf("google.com/maps") !== -1 || actionValue.indexOf("maps.google.com") !== -1) {
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" style="flex-shrink:0"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>';
    }
    if (actionValue.indexOf("tripadvisor") !== -1) {
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" style="flex-shrink:0"><circle cx="12" cy="12" r="12" fill="#34E0A1"/><circle cx="8" cy="12" r="3" fill="white"/><circle cx="16" cy="12" r="3" fill="white"/><circle cx="8" cy="12" r="1.4" fill="#161616"/><circle cx="16" cy="12" r="1.4" fill="#161616"/><path d="M5 8.5C6.2 7 7.8 6 10 5.5L12 4l2 1.5c2.2.5 3.8 1.5 5 3" stroke="#161616" stroke-width="1" fill="none" stroke-linecap="round"/></svg>';
    }
    return "";
  }

  // Render bot reply text: supports **bold**, [label](url) links, bullet lines, and line breaks.
  // Input is plain text (HTML already stripped) — no innerHTML, no XSS risk.
  function renderBotText(container, raw) {
    var text = stripHtml(raw);
    var lines = text.split(/\n/);
    var ul = null; // active <ul> for consecutive bullet lines
    lines.forEach(function (line) {
      var isBullet = /^[-•]\s+/.test(line);
      if (isBullet) {
        if (!ul) { ul = document.createElement("ul"); ul.style.cssText = "margin:6px 0 6px 16px;padding:0;"; container.appendChild(ul); }
        var li = document.createElement("li");
        li.style.cssText = "margin:2px 0;";
        renderInline(li, line.replace(/^[-•]\s+/, ""));
        ul.appendChild(li);
      } else {
        ul = null;
        if (container.hasChildNodes()) container.appendChild(document.createElement("br"));
        renderInline(container, line);
      }
    });
  }

  // Render inline markdown tokens: **bold** and [label](url)
  function renderInline(container, line) {
    var tokenRe = /(\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)]+\))/g;
    var tokens = line.split(tokenRe);
    tokens.forEach(function (token) {
      var boldM = token.match(/^\*\*([^*]+)\*\*$/);
      var linkM = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
      if (boldM) {
        var strong = document.createElement("strong");
        strong.textContent = boldM[1];
        container.appendChild(strong);
      } else if (linkM) {
        var a = document.createElement("a");
        a.href = linkM[2];
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = linkM[1];
        a.style.cssText = "color:#2563eb;font-weight:600;text-decoration:underline;";
        container.appendChild(a);
      } else {
        container.appendChild(document.createTextNode(token));
      }
    });
  }

  function addMsg(text, sender) {
    var div = document.createElement("div");
    div.className = "sprimal-msg sprimal-" + sender;
    if (sender === "bot") {
      renderBotText(div, text);
    } else {
      div.textContent = stripHtml(text);
    }
    messages.appendChild(div);
    scrollToBottom(100);
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
        renderBotText(div, part);
      }
    });
    messages.appendChild(div);
    scrollToBottom(100);
    saveHistory();
    return div;
  }

  function showTyping() {
    var el = document.createElement("div");
    el.className = "sprimal-msg sprimal-bot sprimal-typing";
    el.id = "sprimal-typing";
    el.innerHTML = '<div class="sprimal-dot"></div><div class="sprimal-dot"></div><div class="sprimal-dot"></div>';
    messages.appendChild(el);
    scrollToBottom(100);
  }

  function scrollToBottom(delay) {
    setTimeout(function() {
      var lastEl = messages.lastElementChild;
      if (!lastEl) return;
      // Keep the latest content centred in the visible area
      lastEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }, delay || 0);
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
      messages.innerHTML = "";
      wfSteps = wfFlowMap[rootFlowId];
      wfMode = true;
      var footer = document.getElementById("sprimal-footer");
      if (footer) footer.style.display = "none";
      showWorkflowStep(wfSteps[0]);
    });
    container.appendChild(menuBtn);
    messages.appendChild(container);
    scrollToBottom(100);
  }

  // Remove the back-to-menu button (called when user sends a new message)
  function clearBackToMenu() {
    var el = document.getElementById("sprimal-back-menu");
    if (el) el.parentNode.removeChild(el);
  }

  // Show contact options after an unanswered question — no lead form, just direct contact
  function showFallbackContact(phone, email) {
    var existing = document.getElementById("sprimal-back-menu");
    if (existing) existing.parentNode.removeChild(existing);

    var container = document.createElement("div");
    container.id = "sprimal-back-menu";
    container.style.cssText = "padding:4px 0 6px;align-self:flex-start;display:flex;flex-direction:column;gap:6px;";

    if (phone) {
      var callBtn = document.createElement("button");
      callBtn.className = "sprimal-choice sprimal-choice-ai";
      callBtn.textContent = "📞 " + phone;
      callBtn.addEventListener("click", function () { window.open("tel:" + phone.replace(/\s/g, "")); });
      container.appendChild(callBtn);
    }

    if (rootFlowId && wfFlowMap[rootFlowId]) {
      var menuBtn = document.createElement("button");
      menuBtn.className = "sprimal-choice sprimal-choice-ai";
      menuBtn.textContent = "↩ Back to main menu";
      menuBtn.addEventListener("click", function () {
        messages.innerHTML = "";
        wfSteps = wfFlowMap[rootFlowId]; wfMode = true;
        var footer = document.getElementById("sprimal-footer");
        if (footer) footer.style.display = "none";
        showWorkflowStep(wfSteps[0]);
      });
      container.appendChild(menuBtn);
    }

    messages.appendChild(container);
    scrollToBottom(100);
  }

  // Show "Leave a message" + optional "Call us" after a generic fallback reply
  function showLeadCapturePrompt(phone, question) {
    var existing = document.getElementById("sprimal-back-menu");
    if (existing) existing.parentNode.removeChild(existing);

    var container = document.createElement("div");
    container.id = "sprimal-back-menu";
    container.style.cssText = "padding:4px 0 6px;align-self:flex-start;display:flex;flex-direction:column;gap:6px;";

    var leaveBtn = document.createElement("button");
    leaveBtn.className = "sprimal-choice";
    leaveBtn.textContent = "✉️ Leave a message for the team";
    leaveBtn.addEventListener("click", function () {
      container.parentNode && container.parentNode.removeChild(container);
      // Trigger the collect_lead form inline — same UX as workflow collect_lead
      addMsg("No problem! Just leave your details and the team will get back to you:", "bot");
      var formEl = document.createElement("div");
      formEl.id = "sprimal-lead-form";
      var nameInput = document.createElement("input");
      nameInput.type = "text"; nameInput.placeholder = "Your name (optional)"; nameInput.className = "sprimal-lead-input";
      var emailInput = document.createElement("input");
      emailInput.type = "email"; emailInput.placeholder = "Your email address *"; emailInput.className = "sprimal-lead-input";
      var submitBtn = document.createElement("button");
      submitBtn.textContent = "Send my details →"; submitBtn.className = "sprimal-lead-submit";
      submitBtn.addEventListener("click", function () {
        var leadName  = nameInput.value.trim();
        var leadEmail = emailInput.value.trim();
        if (!leadEmail || !leadEmail.includes("@")) { emailInput.style.borderColor = "#ef4444"; emailInput.focus(); return; }
        submitBtn.disabled = true; submitBtn.textContent = "Sending…";
        fetch(BACKEND + "/api/chat/lead", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clubId: clubId, name: leadName, email: leadEmail, source: "fallback", message: question || null })
        }).then(function (r) { return r.json(); }).then(function () {
          if (formEl.parentNode) formEl.parentNode.removeChild(formEl);
          addMsg("✅ Thanks" + (leadName ? " " + leadName : "") + "! The team will be in touch soon.", "bot");
          showBackToMenu();
        }).catch(function () {
          submitBtn.disabled = false; submitBtn.textContent = "Send my details →";
          addMsg("Sorry, something went wrong. Please try again.", "bot");
        });
      });
      formEl.appendChild(nameInput); formEl.appendChild(emailInput); formEl.appendChild(submitBtn);
      messages.appendChild(formEl);
      scrollToBottom(100);
      setTimeout(function () { nameInput.focus(); }, 300);
    });
    container.appendChild(leaveBtn);

    if (phone) {
      var callBtn = document.createElement("button");
      callBtn.className = "sprimal-choice sprimal-choice-ai";
      callBtn.textContent = "📞 Call us: " + phone;
      callBtn.addEventListener("click", function () { window.open("tel:" + phone.replace(/\s/g, "")); });
      container.appendChild(callBtn);
    }

    if (rootFlowId && wfFlowMap[rootFlowId]) {
      var menuBtn = document.createElement("button");
      menuBtn.className = "sprimal-choice sprimal-choice-ai";
      menuBtn.textContent = "↩ Back to main menu";
      menuBtn.addEventListener("click", function () {
        messages.innerHTML = "";
        wfSteps = wfFlowMap[rootFlowId]; wfMode = true;
        var footer = document.getElementById("sprimal-footer");
        if (footer) footer.style.display = "none";
        showWorkflowStep(wfSteps[0]);
      });
      container.appendChild(menuBtn);
    }

    messages.appendChild(container);
    scrollToBottom(100);
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

    // Split choices by render type
    var socialChoices = choices.filter(function (ch) { return !ch.is_logo && ch.action_type === 'url' && getSocialPlatform(ch.action_value); });
    var logoChoices   = choices.filter(function (ch) { return ch.is_logo && ch.logo_url; });
    var buttonChoices = choices.filter(function (ch) { return !ch.is_logo && !(ch.action_type === 'url' && getSocialPlatform(ch.action_value)); });

    // Render social media platforms as compact circular icon row
    if (socialChoices.length) {
      var socialRow = document.createElement('div');
      socialRow.style.cssText = 'display:flex;gap:12px;padding:4px 0 10px;flex-wrap:wrap;align-self:flex-start;';
      socialChoices.forEach(function (ch) {
        var platform = getSocialPlatform(ch.action_value);
        var pd = SOCIAL_PLATFORMS[platform];
        if (!pd) return;
        var a = document.createElement('a');
        a.href = ch.action_value;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = ch.label || platform;
        var border = platform === 'google' ? ';border:1.5px solid #e2e8f0' : '';
        a.style.cssText = 'width:48px;height:48px;border-radius:50%;background:' + pd.color + ';display:flex;align-items:center;justify-content:center;text-decoration:none;flex-shrink:0;transition:opacity 0.15s;box-shadow:0 2px 6px rgba(0,0,0,0.15)' + border + ';';
        a.onmouseover = function () { this.style.opacity = '0.82'; };
        a.onmouseout  = function () { this.style.opacity = '1'; };
        a.innerHTML = pd.icon;
        socialRow.appendChild(a);
      });
      container.appendChild(socialRow);
    }

    // Render sponsor logo tiles as a grid card
    if (logoChoices.length) {
      var grid = document.createElement("div");
      grid.style.cssText = "display:flex;flex-wrap:wrap;gap:10px;padding:4px 0 8px;align-self:stretch;max-width:92%;";
      logoChoices.forEach(function (ch) {
        var tile = document.createElement("a");
        tile.href = ch.action_value || "#";
        if (ch.action_value) tile.target = "_blank";
        tile.rel = "noopener noreferrer";
        tile.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:8px;padding:14px 10px;background:#fff;border:1.5px solid #e2e8f0;border-radius:12px;text-decoration:none;cursor:pointer;flex:1;min-width:90px;max-width:130px;transition:box-shadow 0.15s;";
        tile.onmouseover = function () { this.style.boxShadow = "0 2px 8px rgba(0,0,0,0.10)"; this.style.borderColor = "#2563eb"; };
        tile.onmouseout  = function () { this.style.boxShadow = ""; this.style.borderColor = "#e2e8f0"; };
        var img = document.createElement("img");
        img.src = ch.logo_url;
        img.alt = ch.label || "";
        img.style.cssText = "width:90px;height:50px;object-fit:contain;";
        var name = document.createElement("span");
        name.textContent = ch.label || "";
        name.style.cssText = "font-size:11px;color:#374151;text-align:center;line-height:1.3;font-weight:600;font-family:inherit;";
        tile.appendChild(img);
        tile.appendChild(name);
        grid.appendChild(tile);
      });
      container.appendChild(grid);
    }

    // Render regular buttons — show first VISIBLE_LIMIT, collapse the rest behind "More options"
    var VISIBLE_LIMIT = 5;

    function makeBtnEl(ch) {
      var btn = document.createElement("button");
      btn.className = "sprimal-choice";
      var platformLogo = getPlatformLogo(ch.action_type, ch.action_value);
      var tablerIcon   = !platformLogo ? getTablerIcon(ch.label) : '';
      if (platformLogo || tablerIcon) {
        btn.style.display = "inline-flex";
        btn.style.alignItems = "center";
        btn.style.gap = "10px";
        var iconHtml  = platformLogo || tablerIcon;
        var labelText = tablerIcon ? stripLeadingEmoji(ch.label) : ch.label;
        btn.innerHTML = iconHtml + '<span>' + escapeHtml(labelText) + '</span>';
      } else {
        btn.textContent = ch.label;
      }
      allBtns.push(btn);
      btn.addEventListener("click", function () {
        selectAndProceed(btn, allBtns, function () { handleChoice(ch); });
      });
      return btn;
    }

    var visibleChoices = buttonChoices.slice(0, VISIBLE_LIMIT);
    var hiddenChoices  = buttonChoices.slice(VISIBLE_LIMIT);

    visibleChoices.forEach(function (ch) {
      container.appendChild(makeBtnEl(ch));
    });

    // Only add AI fallback button if no configured choice already handles it
    var hasAiFallback = choices.some(function (ch) { return ch.action_type === "ai_fallback"; });
    var aiBtn = null;
    if (!hasAiFallback) {
      aiBtn = document.createElement("button");
      aiBtn.className = "sprimal-choice sprimal-choice-ai";
      aiBtn.style.display = "inline-flex"; aiBtn.style.alignItems = "center"; aiBtn.style.gap = "10px";
      aiBtn.innerHTML = makeIconSvg('message-circle') + '<span>Ask something else</span>';
      allBtns.push(aiBtn);
      aiBtn.addEventListener("click", function () {
        selectAndProceed(aiBtn, allBtns, function () { clearChoices(); enableTextInput(); });
      });
    }

    if (hiddenChoices.length) {
      var moreBtn = document.createElement("button");
      moreBtn.className = "sprimal-choice sprimal-choice-ai";
      moreBtn.style.display = "inline-flex"; moreBtn.style.alignItems = "center"; moreBtn.style.gap = "10px";
      moreBtn.innerHTML = makeIconSvg('chevrons-down') + '<span>More options</span>';
      moreBtn.addEventListener("click", function () {
        container.removeChild(moreBtn);
        hiddenChoices.forEach(function (ch) {
          container.appendChild(makeBtnEl(ch));
        });
        if (aiBtn) container.appendChild(aiBtn);
        scrollToBottom(80);
      });
      container.appendChild(moreBtn);
    } else {
      if (aiBtn) container.appendChild(aiBtn);
    }

    // Back to main menu — show on every step except the root menu's own first step
    var rootSteps = rootFlowId && wfFlowMap[rootFlowId];
    var isRootFirstStep = rootSteps && wfSteps === rootSteps && step === rootSteps[0];
    if (rootSteps && !isRootFirstStep) {
      var backBtn = document.createElement("button");
      backBtn.className = "sprimal-choice sprimal-choice-ai";
      backBtn.textContent = "↩ Back to main menu";
      allBtns.push(backBtn);
      backBtn.addEventListener("click", function () {
        selectAndProceed(backBtn, allBtns, function () {
          clearChoices();
          messages.innerHTML = "";
          wfSteps = rootSteps;
          wfMode  = true;
          var footer = document.getElementById("sprimal-footer");
          if (footer) footer.style.display = "none";
          showWorkflowStep(rootSteps[0]);
        });
      });
      container.appendChild(backBtn);
    }

    // Append inside the scrollable messages area — flows inline like AOM
    messages.appendChild(container);
    scrollToBottom(100);
  }

  // Handle a button press in the workflow
  function handleChoice(choice) {
    addMsg(stripLeadingEmoji(choice.label), "user");  // echo the user's selection
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
        restartBtn.textContent = "↩ Back to main menu";
        restartBtn.addEventListener("click", function () {
          clearChoices();
          if (rootFlowId && wfFlowMap[rootFlowId]) {
            messages.innerHTML = "";
            wfSteps = wfFlowMap[rootFlowId];
            wfMode  = true;
            var footer = document.getElementById("sprimal-footer");
            if (footer) footer.style.display = "none";
            showWorkflowStep(wfSteps[0]);
          } else if (wfSteps.length) {
            showWorkflowStep(wfSteps[0]);
          }
        });
        container.appendChild(restartBtn);
        var aiBtn2 = document.createElement("button");
        aiBtn2.className = "sprimal-choice sprimal-choice-ai";
        aiBtn2.style.display = "inline-flex"; aiBtn2.style.alignItems = "center"; aiBtn2.style.gap = "10px";
        aiBtn2.innerHTML = makeIconSvg('message-circle') + '<span>Ask something else</span>';
        aiBtn2.addEventListener("click", function () { clearChoices(); enableTextInput(); });
        container.appendChild(aiBtn2);
        messages.appendChild(container);
        scrollToBottom(350);
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
            messages.innerHTML = "";
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
        scrollToBottom(350);
      }, 300);

    } else if (type === "switch_flow") {
      var targetSteps = wfFlowMap[val];
      if (targetSteps && targetSteps.length) {
        // Returning to root/main menu — clear history for a clean slate
        if (val === rootFlowId) messages.innerHTML = "";
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

    } else if (type === "collect_lead" || type === "collect_feedback") {
      var isFeedback = type === "collect_feedback";
      addMsg(isFeedback
        ? "We'd love to hear from you! Leave your details and feedback below:"
        : "Great! Just leave your details and the team will be in touch:",
        "bot");
      var formEl = document.createElement("div");
      formEl.id = "sprimal-lead-form";
      var nameInput = document.createElement("input");
      nameInput.type = "text"; nameInput.placeholder = "Your name (optional)"; nameInput.className = "sprimal-lead-input";
      var emailInput = document.createElement("input");
      emailInput.type = "email"; emailInput.placeholder = "Your email address *"; emailInput.className = "sprimal-lead-input";
      var msgInput = null;
      if (isFeedback) {
        msgInput = document.createElement("textarea");
        msgInput.placeholder = "Your feedback *";
        msgInput.className = "sprimal-lead-input";
        msgInput.rows = 3;
        msgInput.style.resize = "none";
      }
      var submitBtn = document.createElement("button");
      submitBtn.textContent = isFeedback ? "Send feedback →" : "Send my details →";
      submitBtn.className = "sprimal-lead-submit";
      submitBtn.addEventListener("click", function () {
        var leadName  = nameInput.value.trim();
        var leadEmail = emailInput.value.trim();
        var leadMsg   = msgInput ? msgInput.value.trim() : "";
        if (!leadEmail || !leadEmail.includes("@")) {
          emailInput.style.borderColor = "#ef4444"; emailInput.focus(); return;
        }
        if (isFeedback && !leadMsg) {
          msgInput.style.borderColor = "#ef4444"; msgInput.focus(); return;
        }
        submitBtn.disabled = true; submitBtn.textContent = "Sending…";
        fetch(BACKEND + "/api/chat/lead", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clubId: clubId, name: leadName, email: leadEmail, source: isFeedback ? "feedback" : (val || "widget"), message: leadMsg || undefined })
        }).then(function (r) { return r.json(); }).then(function () {
          if (formEl.parentNode) formEl.parentNode.removeChild(formEl);
          addMsg(isFeedback
            ? "✅ Thanks" + (leadName ? " " + leadName : "") + "! Your feedback means a lot to us."
            : "✅ Thanks" + (leadName ? " " + leadName : "") + "! The team will be in touch soon.",
            "bot");
          setTimeout(function () {
            var c = document.createElement("div"); c.id = "sprimal-choices";
            var backBtn = document.createElement("button");
            backBtn.className = "sprimal-choice sprimal-choice-ai"; backBtn.textContent = "↩ Back to main menu";
            backBtn.addEventListener("click", function () {
              clearChoices();
              if (rootFlowId && wfFlowMap[rootFlowId]) {
                messages.innerHTML = "";
                wfSteps = wfFlowMap[rootFlowId]; wfMode = true;
                var f = document.getElementById("sprimal-footer");
                if (f) f.style.display = "none";
                showWorkflowStep(wfSteps[0]);
              }
            });
            c.appendChild(backBtn); messages.appendChild(c); scrollToBottom(100);
          }, 300);
        }).catch(function () {
          submitBtn.disabled = false; submitBtn.textContent = isFeedback ? "Send feedback →" : "Send my details →";
          addMsg("Sorry, something went wrong. Please try again.", "bot");
        });
      });
      formEl.appendChild(nameInput);
      formEl.appendChild(emailInput);
      if (msgInput) formEl.appendChild(msgInput);
      formEl.appendChild(submitBtn);
      messages.appendChild(formEl); scrollToBottom(100);
      setTimeout(function () { nameInput.focus(); }, 300);

    } else if (type === "collect_membership_cancel" || type === "collect_membership_change") {
      startMembershipFlow(type);
    } else if (type === "collect_summer_camp" || type === "collect_junior_event") {
      startJuniorEventFlow(null);
    }
  }

  // ── Step-by-step membership flow ──────────────────────────────────────────
  var _mbrFlow = null;

  function startMembershipFlow(actionType) {
    _mbrFlow = { type: actionType, step: 0, data: {} };
    _runMbrStep();
  }

  function _mbrInlineButtons(options, onPick) {
    clearChoices();
    var c = document.createElement("div"); c.id = "sprimal-choices";
    options.forEach(function(opt) {
      var btn = document.createElement("button");
      btn.className = "sprimal-choice";
      if (opt.disabled) {
        btn.disabled = true;
        btn.style.opacity = "0.45";
        btn.style.cursor = "not-allowed";
      }
      if (opt.sublabel) {
        btn.innerHTML = '<span style="display:block">' + opt.label + '</span>'
          + '<small style="color:#6b7280;font-size:11px;font-weight:400">' + opt.sublabel + '</small>';
      } else {
        btn.textContent = opt.label;
      }
      btn.addEventListener("click", function() {
        if (opt.disabled) return;
        clearChoices();
        addMsg(opt.label, "user");
        onPick(opt.value !== undefined ? opt.value : opt.label);
      });
      c.appendChild(btn);
    });
    messages.appendChild(c); scrollToBottom(100);
  }

  function _mbrInlineInput(placeholder, onSubmit, optional) {
    clearChoices();
    var wrap = document.createElement("div");
    wrap.id = "sprimal-choices";
    wrap.style.cssText = "display:flex;flex-direction:column;gap:8px;align-self:stretch;max-width:92%;";

    var inp = document.createElement("input");
    inp.type = "text"; inp.placeholder = placeholder;
    inp.style.cssText = "border:1.5px solid #e2e8f0;border-radius:10px;padding:9px 12px;font-size:13px;font-family:" + FONT + ";outline:none;background:#fff;color:#1f2937;width:100%;box-sizing:border-box;";

    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;";

    var sendBtn = document.createElement("button");
    sendBtn.className = "sprimal-choice";
    sendBtn.style.cssText = "flex:1;border-radius:10px;padding:9px 12px;font-size:13px;font-weight:600;";
    sendBtn.textContent = "Continue →";

    var doSubmit = function() {
      var val = inp.value.trim();
      if (!val && !optional) { inp.style.borderColor = "#ef4444"; inp.focus(); return; }
      clearChoices();
      if (val) addMsg(val, "user");
      onSubmit(val);
    };
    sendBtn.addEventListener("click", doSubmit);
    inp.addEventListener("keydown", function(e) { if (e.key === "Enter") doSubmit(); });

    if (optional) {
      var skipBtn = document.createElement("button");
      skipBtn.className = "sprimal-choice sprimal-choice-ai";
      skipBtn.style.cssText = "border-radius:10px;padding:9px 12px;font-size:13px;";
      skipBtn.textContent = "Skip";
      skipBtn.addEventListener("click", function() { clearChoices(); onSubmit(""); });
      row.appendChild(sendBtn); row.appendChild(skipBtn);
    } else {
      row.appendChild(sendBtn);
    }

    wrap.appendChild(inp); wrap.appendChild(row);
    messages.appendChild(wrap); scrollToBottom(100);
    setTimeout(function() { inp.focus(); }, 200);
  }

  function _mbrSendAndVerifyOtp(email, onVerified) {
    addMsg("Sending a verification code to " + email + "…", "bot");
    fetch(BACKEND + "/api/membership-otp/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, tenantId: clubId })
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (!d.ok) { addMsg("Sorry, we couldn't send the code. Please check your email address and try again.", "bot"); return; }
      addMsg("We've sent a 6-digit code to " + email + ". Please enter it below:", "bot");
      _mbrShowOtpInput(email, onVerified);
    }).catch(function() {
      addMsg("Something went wrong sending the code. Please try again.", "bot");
    });
  }

  function _mbrShowOtpInput(email, onVerified) {
    clearChoices();
    var wrap = document.createElement("div");
    wrap.id = "sprimal-choices";
    wrap.style.cssText = "display:flex;flex-direction:column;gap:8px;align-self:stretch;max-width:92%;";

    var inp = document.createElement("input");
    inp.type = "text"; inp.placeholder = "6-digit code"; inp.maxLength = 6;
    inp.style.cssText = "border:1.5px solid #e2e8f0;border-radius:10px;padding:10px 12px;font-size:22px;font-family:" + FONT + ";outline:none;background:#fff;color:#1f2937;width:100%;box-sizing:border-box;letter-spacing:8px;text-align:center;";

    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;";

    var verifyBtn = document.createElement("button");
    verifyBtn.className = "sprimal-choice";
    verifyBtn.style.cssText = "flex:1;border-radius:10px;padding:9px 12px;font-size:13px;font-weight:600;";
    verifyBtn.textContent = "Verify →";

    var resendBtn = document.createElement("button");
    resendBtn.className = "sprimal-choice sprimal-choice-ai";
    resendBtn.style.cssText = "border-radius:10px;padding:9px 12px;font-size:12px;white-space:nowrap;";
    resendBtn.textContent = "Resend code";

    var doVerify = function() {
      var code = inp.value.replace(/\s/g, "");
      if (code.length !== 6) { inp.style.borderColor = "#ef4444"; inp.focus(); return; }
      verifyBtn.disabled = true; verifyBtn.textContent = "Verifying…";
      fetch(BACKEND + "/api/membership-otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email, code: code })
      }).then(function(r) { return r.json(); }).then(function(d) {
        if (d.ok) {
          clearChoices();
          addMsg("✓ Verified", "user");
          onVerified();
        } else {
          verifyBtn.disabled = false; verifyBtn.textContent = "Verify →";
          inp.style.borderColor = "#ef4444"; inp.value = ""; inp.focus();
          var msg = d.reason === "expired"
            ? "That code has expired. Please tap Resend to get a new one."
            : "That code doesn't match. Please try again.";
          addMsg(msg, "bot");
        }
      }).catch(function() {
        verifyBtn.disabled = false; verifyBtn.textContent = "Verify →";
        addMsg("Something went wrong. Please try again.", "bot");
      });
    };

    verifyBtn.addEventListener("click", doVerify);
    inp.addEventListener("keydown", function(e) { if (e.key === "Enter") doVerify(); });

    resendBtn.addEventListener("click", function() {
      clearChoices();
      fetch(BACKEND + "/api/membership-otp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email, tenantId: clubId })
      }).then(function() {
        addMsg("New code sent to " + email + ". Please check your inbox.", "bot");
        _mbrShowOtpInput(email, onVerified);
      });
    });

    row.appendChild(verifyBtn); row.appendChild(resendBtn);
    wrap.appendChild(inp); wrap.appendChild(row);
    messages.appendChild(wrap); scrollToBottom(100);
    setTimeout(function() { inp.focus(); }, 200);
  }

  function _runMbrStep() {
    var f = _mbrFlow;
    if (!f) return;
    var isChange = f.type === "collect_membership_change";

    if (isChange) {
      switch (f.step) {
        case 0:
          addMsg("Sure! What type of membership would you like to change to?", "bot");
          fetch(BACKEND + "/api/membership-types?tenantId=" + encodeURIComponent(clubId))
            .then(function(r) { return r.json(); })
            .then(function(d) {
              var types = d.types || [];
              if (types.length) {
                _mbrInlineButtons(types.map(function(t) { return { label: t }; }), function(val) {
                  f.data.changeTo = val; f.step++; _runMbrStep();
                });
              } else {
                _mbrInlineInput("e.g. Single, Family, Junior…", function(val) {
                  f.data.changeTo = val; f.step++; _runMbrStep();
                });
              }
            })
            .catch(function() {
              _mbrInlineInput("e.g. Single, Family, Junior…", function(val) {
                f.data.changeTo = val; f.step++; _runMbrStep();
              });
            });
          break;
        case 1:
          addMsg("When would you like the change to take effect?", "bot");
          _mbrInlineButtons([
            { label: "Immediately" },
            { label: "At next renewal" }
          ], function(val) { f.data.effectiveDate = val; f.step++; _runMbrStep(); });
          break;
        case 2:
          addMsg("What's your name?", "bot");
          _mbrInlineInput("Your name *", function(val) {
            f.data.name = val; f.step++; _runMbrStep();
          });
          break;
        case 3:
          addMsg("And your email address?", "bot");
          _mbrInlineInput("Your email address *", function(val) {
            if (!val.includes("@")) { addMsg("Please enter a valid email address.", "bot"); f.step--; f.step++; _runMbrStep(); return; }
            f.data.email = val;
            _mbrSendAndVerifyOtp(val, function() { f.step++; _runMbrStep(); });
          });
          break;
        case 4:
          addMsg("Any reason for the change? (optional)", "bot");
          _mbrInlineInput("Reason…", function(val) {
            f.data.reason = val; f.step++; _runMbrStep();
          }, true);
          break;
        case 5:
          _submitMbrFlow();
          break;
      }
    } else {
      switch (f.step) {
        case 0:
          addMsg("Sorry to hear that. When would you like your cancellation to take effect?", "bot");
          _mbrInlineButtons([
            { label: "At end of current period" },
            { label: "Immediately" }
          ], function(val) { f.data.effectiveDate = val; f.step++; _runMbrStep(); });
          break;
        case 1:
          addMsg("What's your name?", "bot");
          _mbrInlineInput("Your name *", function(val) {
            f.data.name = val; f.step++; _runMbrStep();
          });
          break;
        case 2:
          addMsg("And your email address?", "bot");
          _mbrInlineInput("Your email address *", function(val) {
            if (!val.includes("@")) { addMsg("Please enter a valid email address.", "bot"); f.step--; f.step++; _runMbrStep(); return; }
            f.data.email = val;
            _mbrSendAndVerifyOtp(val, function() { f.step++; _runMbrStep(); });
          });
          break;
        case 3:
          addMsg("Is there anything you'd like to tell us about why you're cancelling? (optional)", "bot");
          _mbrInlineInput("Reason…", function(val) {
            f.data.reason = val; f.step++; _runMbrStep();
          }, true);
          break;
        case 4:
          _submitMbrFlow();
          break;
      }
    }
  }

  function _submitMbrFlow() {
    var f = _mbrFlow;
    if (!f) return;
    var isChange = f.type === "collect_membership_change";

    addMsg("Got it — submitting your request…", "bot");

    // Map effective date label to a value the backend understands
    var effectiveDateVal = null;
    if (f.data.effectiveDate === "Immediately") {
      effectiveDateVal = new Date().toISOString().slice(0, 10);
    } else if (f.data.effectiveDate === "At next renewal" || f.data.effectiveDate === "At end of current period") {
      effectiveDateVal = null; // backend defaults to period end
    }

    fetch(BACKEND + "/api/membership-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId:      clubId,
        memberName:    f.data.name,
        memberEmail:   f.data.email,
        requestedType: isChange ? f.data.changeTo : "cancel",
        effectiveDate: effectiveDateVal,
        reason:        f.data.reason || undefined
      })
    }).then(function(r) { return r.json(); }).then(function() {
      _mbrFlow = null;
      addMsg(isChange
        ? "✅ Thanks " + f.data.name + "! Your membership change request has been submitted. The team will be in touch to confirm."
        : "✅ Thanks " + f.data.name + ". Your cancellation request has been submitted. The team will be in touch to confirm.",
        "bot");
      setTimeout(function() {
        var c = document.createElement("div"); c.id = "sprimal-choices";
        var backBtn = document.createElement("button");
        backBtn.className = "sprimal-choice sprimal-choice-ai"; backBtn.textContent = "↩ Back to main menu";
        backBtn.addEventListener("click", function() {
          clearChoices();
          if (rootFlowId && wfFlowMap[rootFlowId]) {
            messages.innerHTML = "";
            wfSteps = wfFlowMap[rootFlowId]; wfMode = true;
            var f2 = document.getElementById("sprimal-footer");
            if (f2) f2.style.display = "none";
            showWorkflowStep(wfSteps[0]);
          }
        });
        c.appendChild(backBtn); messages.appendChild(c); scrollToBottom(100);
      }, 400);
    }).catch(function() {
      addMsg("Sorry, something went wrong. Please try again.", "bot");
    });
  }
  // ── End membership flow ────────────────────────────────────────────────────

  // ── Summer camp booking flow (legacy — kept for backward compat) ──────────
  var _campFlow = null;

  function startCampFlow() {
    // Delegate to the new generic junior event flow
    startJuniorEventFlow(null);
  }
  // ── End summer camp flow (legacy stub) ────────────────────────────────────

  // ── Junior Event Booking flow (generic multi-tenant) ──────────────────────
  var _juniorFlow = null;

  function startJuniorEventFlow(preloadedEvent) {
    if (preloadedEvent) {
      _beginJuniorFlow(preloadedEvent);
      return;
    }
    // Fetch active events and pick (auto-select if only one)
    fetch(BACKEND + "/api/junior-events?tenantId=" + encodeURIComponent(clubId))
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var events = d.events || [];
        if (!events.length) {
          addMsg("There are no events available for booking at the moment. Please contact the club directly.", "bot");
          return;
        }
        if (events.length === 1) {
          _beginJuniorFlow(events[0]);
          return;
        }
        addMsg("Which event would you like to book?", "bot");
        setTimeout(function() {
          _mbrInlineButtons(events.map(function(ev) {
            return { label: ev.name + (ev.date_range ? " (" + ev.date_range + ")" : ""), value: ev.id };
          }), function(eventId) {
            var chosen = events.find(function(ev) { return ev.id === eventId; });
            if (chosen) _beginJuniorFlow(chosen);
          });
        }, 300);
      })
      .catch(function() {
        addMsg("Sorry, I couldn't load events right now. Please try again or contact the club directly.", "bot");
      });
  }

  function _beginJuniorFlow(event) {
    _juniorFlow = { event: event, step: 0, data: {} };
    var lookupType = event.member_lookup_type || "ebo";
    var needsFullName = lookupType === "ebo";
    addMsg("Happy to help you book " + event.name + "! What's your child's name?", "bot");
    _mbrInlineInput("Child's first and last name *", function(val) {
      if (needsFullName && val.trim().split(/\s+/).length < 2) {
        addMsg("Please enter both first and last name so I can check membership.", "bot");
        _beginJuniorFlow(event);
        return;
      }
      _juniorFlow.data.childName = val.trim();
      if (lookupType === "self_declare") {
        _juniorSelfDeclare(val.trim());
      } else if (lookupType === "none") {
        _juniorFlow.data.isMember = false;
        _juniorFlow.data.price = Number(event.non_member_price);
        _juniorFlow.step = 1;
        _runJuniorStep();
      } else {
        _juniorCheckMember(val.trim());
      }
    });
  }

  function _juniorSelfDeclare(childName) {
    var f = _juniorFlow;
    if (!f) return;
    var event = f.event;
    addMsg("Is " + childName + " a junior member of the club?", "bot");
    setTimeout(function() {
      _mbrInlineButtons([
        { label: "Yes, member" },
        { label: "No, non-member" }
      ], function(choice) {
        var isMember = choice === "Yes, member";
        f.data.isMember = isMember;
        f.data.price = isMember ? Number(event.member_price) : Number(event.non_member_price);
        addMsg(isMember
          ? "Great — the member rate of €" + f.data.price + " applies."
          : "No problem — the non-member rate of €" + f.data.price + " applies.", "bot");
        setTimeout(function() { f.step = 1; _runJuniorStep(); }, 300);
      });
    }, 300);
  }

  function _juniorCheckMember(childName) {
    var f = _juniorFlow;
    if (!f) return;
    var event = f.event;
    addMsg("Checking membership…", "bot");
    fetch(BACKEND + "/api/ebo/check-junior-member", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ childName: childName, tenantId: clubId })
    })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var isMember = !!d.found;
        f.data.isMember = isMember;
        f.data.price    = isMember ? Number(event.member_price) : Number(event.non_member_price);
        if (isMember) {
          addMsg("✅ " + childName + " is a club member — the member rate of €" + f.data.price + " applies.", "bot");
        } else {
          addMsg("We couldn't find " + childName + " as a junior member. The non-member rate of €" + f.data.price + " applies.", "bot");
        }
        setTimeout(function() {
          var buttons = isMember
            ? [{ label: "Continue booking" }, { label: "That's not right" }]
            : [{ label: "Continue booking" }, { label: "That's not right" }, { label: "Contact Junior Secretary" }, { label: "Join as a Member" }];
          _mbrInlineButtons(buttons, function(choice) {
            if (choice === "That's not right") {
              addMsg("No problem — what's the correct name?", "bot");
              _mbrInlineInput("Child's first and last name *", function(val) {
                f.data.childName = val.trim();
                _juniorCheckMember(val.trim());
              });
            } else if (choice === "Contact Junior Secretary") {
              addMsg("No problem — we'll flag this to the Junior Secretary to check the membership records. What's your name?", "bot");
              _mbrInlineInput("Your name *", function(parentName) {
                parentName = parentName.trim();
                addMsg("And your email address?", "bot");
                _mbrInlineInput("Your email *", function(parentEmail) {
                  parentEmail = parentEmail.trim();
                  addMsg("And your phone number? (optional — press Enter to skip)", "bot");
                  _mbrInlineInput("Phone (optional)", function(parentPhone) {
                    parentPhone = parentPhone.trim();
                    fetch(BACKEND + "/api/camp/contact-secretary", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ tenantId: clubId, childName: f.data.childName, parentName: parentName, parentEmail: parentEmail, parentPhone: parentPhone || null })
                    })
                      .then(function(r) { return r.json(); })
                      .then(function() {
                        addMsg("Done — the Junior Secretary has been notified and will follow up with you directly. In the meantime, would you like to continue the booking at the non-member rate?", "bot");
                        setTimeout(function() {
                          _mbrInlineButtons([{ label: "Continue booking" }, { label: "No thanks" }], function(c) {
                            if (c === "Continue booking") { f.step = 1; _runJuniorStep(); }
                            else { _juniorFlow = null; addMsg("No problem — feel free to come back anytime.", "bot"); enableTextInput(); }
                          });
                        }, 300);
                      })
                      .catch(function() {
                        addMsg("Sorry, I couldn't send that message right now. Please contact the club directly.", "bot");
                        enableTextInput();
                        _juniorFlow = null;
                      });
                  });
                });
              });
            } else if (choice === "Join as a Member") {
              _juniorFlow = null;
              addMsg("Happy to help with a membership application! Let's get started.", "bot");
              setTimeout(function() {
                showTyping();
                fetch(BACKEND + "/chat", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ userId: userId, conversationId: conversationId, message: "", clubId: clubId, agentTrigger: "membership_application_agent" })
                })
                  .then(function(r) { return r.json(); })
                  .then(function(data) {
                    hideTyping();
                    if (data.reply) addMsg(data.reply, "bot");
                    if (data.agentChoices && data.agentChoices.length) {
                      showAgentChoices(data.agentChoices, { multiSelect: data.multiSelect, maxSelect: data.maxSelect });
                    } else {
                      enableTextInput();
                    }
                  })
                  .catch(function() {
                    hideTyping();
                    addMsg("Sorry, I couldn't start the membership form right now. Please try again.", "bot");
                    enableTextInput();
                  });
              }, 400);
            } else {
              f.step = 1;
              _runJuniorStep();
            }
          });
        }, 300);
      })
      .catch(function() {
        f.data.isMember = false;
        f.data.price    = Number(event.non_member_price);
        addMsg("I wasn't able to check membership right now — we'll apply the non-member rate of €" + f.data.price + " and the club can adjust it if needed.", "bot");
        setTimeout(function() {
          _mbrInlineButtons([
            { label: "Continue booking" },
            { label: "Cancel" }
          ], function(choice) {
            if (choice === "Cancel") {
              addMsg("No problem — feel free to come back anytime.", "bot");
              _juniorFlow = null;
            } else {
              f.step = 1;
              _runJuniorStep();
            }
          });
        }, 300);
      });
  }

  function _runJuniorStep() {
    var f = _juniorFlow;
    if (!f) return;
    var child  = f.data.childName;
    var blocks = f.event.question_blocks || [];

    if (f.step >= 6) {
      var blockIndex = f.step - 6;
      if (blockIndex >= blocks.length) {
        _submitJuniorFlow();
        return;
      }
      _runJuniorBlock(blocks[blockIndex], function() {
        f.step++;
        _runJuniorStep();
      });
      return;
    }

    switch (f.step) {
      case 1:
        addMsg("Which session would you like to book for " + child + "?", "bot");
        // Fetch fresh availability
        fetch(BACKEND + "/api/junior-events?tenantId=" + encodeURIComponent(clubId))
          .then(function(r) { return r.json(); })
          .then(function(d) {
            var events  = d.events || [];
            var matched = events.find(function(ev) { return ev.id === f.event.id; });
            var sessions = matched ? (matched.junior_event_sessions || []) : (f.event.junior_event_sessions || []);
            var buttons = sessions.map(function(s) {
              var avail = s.available !== undefined ? s.available : (s.capacity - (s.booked || 0));
              var sublabel = avail <= 0 ? "No places remaining" :
                             avail === 1 ? "1 place left" :
                             avail + " places remaining";
              return {
                label:    s.session_name,
                value:    JSON.stringify({ id: s.id, name: s.session_name }),
                sublabel: sublabel,
                disabled: avail <= 0
              };
            });
            if (!buttons.length) {
              addMsg("There are no sessions available for this event. Please contact the club directly.", "bot");
              _juniorFlow = null; return;
            }
            _mbrInlineButtons(buttons, function(val) {
              var parsed = JSON.parse(val);
              f.data.sessionId   = parsed.id;
              f.data.sessionName = parsed.name;
              f.step++; _runJuniorStep();
            });
          })
          .catch(function() {
            addMsg("Sorry, I couldn't load session availability. Please try again.", "bot");
            _juniorFlow = null;
          });
        break;
      case 2:
        addMsg("What's your name (parent or guardian)?", "bot");
        _mbrInlineInput("Your full name *", function(val) {
          f.data.parentName = val.trim(); f.step++; _runJuniorStep();
        });
        break;
      case 3:
        addMsg("What's your email address?", "bot");
        _mbrInlineInput("Your email *", function(val) {
          if (!val.includes("@")) { addMsg("Please enter a valid email address.", "bot"); _runJuniorStep(); return; }
          f.data.parentEmail = val.trim(); f.step++; _runJuniorStep();
        });
        break;
      case 4:
        addMsg("And your phone number?", "bot");
        _mbrInlineInput("Phone number *", function(val) {
          f.data.parentPhone = val.trim(); f.step++; _runJuniorStep();
        });
        break;
      case 5:
        addMsg("What is " + child + "'s date of birth?", "bot");
        _mbrInlineInput("DD/MM/YYYY", function(val) {
          f.data.childDob = val.trim(); f.step++; _runJuniorStep();
        });
        break;
    }
  }

  function _runJuniorBlock(block, onDone) {
    var f    = _juniorFlow;
    var type = block.type;
    var key  = block.key;

    if (type === "text") {
      addMsg(block.description || block.label, "bot");
      _mbrInlineInput(block.label + " *", function(val) {
        f.data.answers = f.data.answers || {};
        f.data.answers[key] = val.trim();
        onDone();
      });
    } else if (type === "boolean") {
      addMsg(block.description || block.label, "bot");
      setTimeout(function() {
        _mbrInlineButtons([{ label: "Yes" }, { label: "No" }], function(val) {
          f.data.answers = f.data.answers || {};
          f.data.answers[key] = (val === "Yes");
          onDone();
        });
      }, 300);
    } else if (type === "acknowledge") {
      addMsg((block.description || block.label) + " — do you agree?", "bot");
      setTimeout(function() {
        _mbrInlineButtons([{ label: "I agree" }, { label: "Cancel" }], function(val) {
          if (val === "Cancel") {
            addMsg("No problem — your booking has not been submitted.", "bot");
            _juniorFlow = null; return;
          }
          f.data.answers = f.data.answers || {};
          f.data.answers[key] = true;
          onDone();
        });
      }, 300);
    } else if (type === "contact") {
      addMsg(block.description || block.label + " — name?", "bot");
      _mbrInlineInput("Contact name *", function(nameVal) {
        addMsg("And their phone number?", "bot");
        _mbrInlineInput("Contact phone *", function(phoneVal) {
          f.data.answers = f.data.answers || {};
          f.data.answers[key] = { name: nameVal.trim(), phone: phoneVal.trim() };
          onDone();
        });
      });
    } else {
      // Unknown block type — skip
      onDone();
    }
  }

  function _submitJuniorFlow() {
    var f = _juniorFlow;
    if (!f) return;
    addMsg("Submitting your booking…", "bot");
    fetch(BACKEND + "/api/junior-booking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId:    clubId,
        eventId:     f.event.id,
        sessionId:   f.data.sessionId,
        childName:   f.data.childName,
        childDob:    f.data.childDob,
        isMember:    f.data.isMember,
        price:       f.data.price,
        parentName:  f.data.parentName,
        parentEmail: f.data.parentEmail,
        parentPhone: f.data.parentPhone,
        answers:     f.data.answers || {},
        returnUrl:   (window.top || window).location.href.split("?")[0]
      })
    }).then(function(r) {
      return r.json().then(function(d) { return { status: r.status, data: d }; });
    }).then(function(res) {
      var d = res.data;
      if (res.status === 409) {
        addMsg("⚠️ " + (d.error || "This session is now full.") + " Please contact the club directly.", "bot");
        _juniorFlow = null; return;
      }
      if (d.error) { addMsg("Sorry, something went wrong: " + d.error + ". Please try again.", "bot"); return; }
      _juniorFlow = null;
      addMsg("Details saved ✅ Redirecting you to secure payment…", "bot");
      setTimeout(function() { window.top.location.href = d.url; }, 800);
    }).catch(function() {
      addMsg("Sorry, something went wrong. Please try again or contact the club directly.", "bot");
    });
  }
  // ── End junior event flow ──────────────────────────────────────────────────

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
            scrollToBottom(100);
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
          // External URL — open in new tab, leave other buttons (e.g. Back to menu) active
          if (typeof value === "string" && value.startsWith("__url__")) {
            window.open(value.slice(7), "_blank", "noopener,noreferrer");
            return;
          }
          allBtns.forEach(function (b) { b.disabled = true; b.style.opacity = "0.4"; });
          btn.style.opacity = "1";
          // Back to menu — replay root flow without a network call
          if (value === "__menu__") {
            if (rootFlowId && wfFlowMap[rootFlowId]) {
              wfSteps = wfFlowMap[rootFlowId];
              wfMode  = true;
              var footer = document.getElementById("sprimal-footer");
              if (footer) footer.style.display = "none";
              setTimeout(function () { showWorkflowStep(wfSteps[0]); }, 280);
            }
            return;
          }
          if (!secondary) { btn.style.background = brandColor; btn.style.color = "#fff"; btn.style.borderColor = brandColor; }
          setTimeout(function () { sendAgentMessage(value, label); }, 280);
        });
        container.appendChild(btn);
      });
    }

    messages.appendChild(container);
    scrollToBottom(100);
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
  var lastUserQuestion = "";

  function send() {
    var text = input.value.trim();
    if (!text) return;

    lastUserQuestion = text;
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
          if (data.unanswered) {
            showFallbackContact(data.phone || null, data.email || null);
          } else {
            showBackToMenu();
          }
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
          showWorkflowStep(wfSteps[0]); // first step bot_message already serves as greeting
        } else {
          // Fresh start — wfSteps empty (fetch still in flight or no workflows)
          // Show greeting now; if fetch returns with workflows, race condition handler will replace it
          if (!wfFetchDone) openedBeforeWfFetch = true;
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
      showWorkflowStep(wfSteps[0]); // first step bot_message already serves as greeting
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
