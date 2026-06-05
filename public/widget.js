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
  var clubId   = (scriptTag && scriptTag.getAttribute("data-club-id"))   || "aom";
  var botName  = (scriptTag && scriptTag.getAttribute("data-bot-name"))  || "Maeve";
  var clubName = (scriptTag && scriptTag.getAttribute("data-club-name")) || "At Once Mortgages";

  // ── Session IDs ──────────────────────────────────────────────────────────
  var userId = "user-" + Math.random().toString(36).slice(2, 10);
  var conversationId = sessionStorage.getItem("sprimal_conv_" + clubId);
  if (!conversationId) {
    conversationId = "conv-" + Date.now();
    sessionStorage.setItem("sprimal_conv_" + clubId, conversationId);
  }

  // ── Styles ───────────────────────────────────────────────────────────────
  var style = document.createElement("style");
  style.textContent = [
    "#sprimal-btn{position:fixed;bottom:24px;right:24px;z-index:99999;width:56px;height:56px;border-radius:50%;background:#111827;border:none;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;transition:transform .2s;}",
    "#sprimal-btn:hover{transform:scale(1.08);}",
    "#sprimal-btn svg{width:26px;height:26px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}",
    "#sprimal-badge{position:absolute;top:-4px;right:-4px;background:#ef4444;color:#fff;font-size:11px;font-weight:700;width:18px;height:18px;border-radius:50%;display:none;align-items:center;justify-content:center;font-family:Arial,sans-serif;}",
    "#sprimal-panel{position:fixed;bottom:92px;right:24px;z-index:99998;width:360px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.18);display:flex;flex-direction:column;overflow:hidden;transition:opacity .2s,transform .2s;}",
    "#sprimal-panel.sprimal-hidden{opacity:0;transform:translateY(12px);pointer-events:none;}",
    "#sprimal-header{background:#111827;color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}",
    "#sprimal-header-left{display:flex;align-items:center;gap:10px;}",
    "#sprimal-avatar{width:38px;height:38px;border-radius:50%;background:#374151;overflow:hidden;display:flex;align-items:center;justify-content:center;flex-shrink:0;}",
    "#sprimal-avatar img{width:100%;height:100%;object-fit:cover;}",
    "#sprimal-header-info{display:flex;flex-direction:column;}",
    "#sprimal-header-name{font-size:15px;font-weight:700;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}",
    "#sprimal-header-sub{font-size:12px;color:#93c5fd;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin-top:1px;}",
    "#sprimal-header-right{display:flex;align-items:center;gap:10px;}",
    "#sprimal-online-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;flex-shrink:0;}",
    "#sprimal-close{background:rgba(255,255,255,0.12);border:none;border-radius:50%;cursor:pointer;color:#e2e8f0;font-size:16px;line-height:1;width:28px;height:28px;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s;flex-shrink:0;}",
    "#sprimal-close:hover{background:rgba(255,255,255,0.22);color:#fff;}",
    "#sprimal-messages{flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:10px;background:#f0f4ff;}",
    ".sprimal-msg{max-width:82%;padding:10px 14px;border-radius:18px;font-size:14px;line-height:1.5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;word-wrap:break-word;white-space:pre-wrap;}",
    ".sprimal-bot{background:#fff;color:#111827;align-self:flex-start;border-bottom-left-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,0.08);}",
    ".sprimal-user{background:#1e40af;color:#fff;align-self:flex-end;border-bottom-right-radius:4px;}",
    ".sprimal-typing{display:flex;gap:4px;padding:12px 14px;align-items:center;background:#fff;border-radius:18px;border-bottom-left-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,0.08);}",
    ".sprimal-dot{width:7px;height:7px;border-radius:50%;background:#93c5fd;animation:sprimal-bounce .9s infinite ease-in-out;}",
    ".sprimal-dot:nth-child(2){animation-delay:.15s;}",
    ".sprimal-dot:nth-child(3){animation-delay:.3s;}",
    "@keyframes sprimal-bounce{0%,80%,100%{transform:translateY(0);}40%{transform:translateY(-6px);}}",
    "#sprimal-footer{padding:10px 12px;border-top:1px solid #dbeafe;background:#fff;display:flex;gap:8px;align-items:center;flex-shrink:0;}",
    "#sprimal-input{flex:1;border:1.5px solid #bfdbfe;border-radius:22px;padding:9px 16px;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;outline:none;resize:none;transition:border-color .15s;}",
    "#sprimal-input:focus{border-color:#111827;}",
    "#sprimal-send{width:38px;height:38px;flex-shrink:0;background:#111827;color:#fff;border:none;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s;padding:0;}",
    "#sprimal-send:hover{background:#1f2937;}",
    "#sprimal-send:disabled{background:#bfdbfe;cursor:not-allowed;}",
    "#sprimal-choices{padding:8px 12px 10px;display:flex;flex-wrap:wrap;gap:8px;border-top:1px solid #dbeafe;background:#fff;flex-shrink:0;}",
    ".sprimal-choice{background:#fff;border:1.5px solid #111827;border-radius:20px;padding:8px 18px;font-size:13px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;cursor:pointer;color:#111827;font-weight:500;transition:background .12s,color .12s;white-space:nowrap;line-height:1.3;}",
    ".sprimal-choice:hover{background:#111827;color:#fff;}",
    ".sprimal-choice-ai{border:1.5px dashed #d1d5db;color:#6b7280;font-weight:400;}",
    ".sprimal-choice-ai:hover{background:#f1f5f9;color:#374151;}",
    "@media(max-width:640px){#sprimal-panel{width:100vw;max-width:100vw;right:0;left:0;bottom:0;height:75vh;max-height:75vh;border-radius:20px 20px 0 0;}#sprimal-panel.sprimal-hidden{transform:translateY(100%);}#sprimal-btn{bottom:88px;right:16px;}}",
  ].join("");
  document.head.appendChild(style);

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

  // ── Workflow state ────────────────────────────────────────────────────────
  var wfSteps   = [];  // sorted steps for the currently-active flow
  var wfFlowMap = {};  // { flowId: sortedSteps[] } — all flows pre-fetched for switch_flow
  var wfMode    = false;
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
        }
      })
      .catch(function () { /* silently ignore */ });
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

  // Render a workflow step: bot message + choice buttons
  function showWorkflowStep(step) {
    if (!step) return;
    addMsg(step.bot_message, "bot");

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

    // Insert between #sprimal-messages and #sprimal-footer
    var footer = document.getElementById("sprimal-footer");
    if (footer) {
      panel.insertBefore(container, footer);
    } else {
      panel.appendChild(container);
    }
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
        var footer2 = document.getElementById("sprimal-footer");
        if (footer2) panel.insertBefore(container, footer2); else panel.appendChild(container);
        messages.scrollTop = messages.scrollHeight;
      }, 300);

    } else if (type === "url") {
      if (val) window.open(val, "_blank");
      addMsg("Opening that page for you…", "bot");
      setTimeout(function () {
        if (wfSteps.length) showWorkflowStep(wfSteps[0]);
      }, 800);

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
    }
  }

  // ── Send message ─────────────────────────────────────────────────────────
  function send() {
    var text = input.value.trim();
    if (!text) return;

    addMsg(text, "user");
    input.value = "";
    sendBtn.disabled = true;
    showTyping();

    fetch(BACKEND + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: userId, conversationId: conversationId, message: text, clubId: clubId })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        hideTyping();
        addMsg(data.reply || "Sorry, something went wrong.", "bot");
        sendBtn.disabled = false;
        input.focus();
      })
      .catch(function () {
        hideTyping();
        addMsg("Sorry, I couldn't connect. Please try again.", "bot");
        sendBtn.disabled = false;
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
        if (wfSteps.length) {
          // Workflow mode: hide footer text input, show button menu
          wfMode = true;
          var footer = document.getElementById("sprimal-footer");
          if (footer) footer.style.display = "none";
          addMsg("Hi there 👋 I'm " + botName + ", your " + clubName + " assistant.", "bot");
          showWorkflowStep(wfSteps[0]);
        } else {
          // Standard AI mode: show greeting + text input
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
  setTimeout(function () {
    if (!hasOpened) showBadge();
  }, 5000);

})();
