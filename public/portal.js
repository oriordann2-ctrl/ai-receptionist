// Portal dashboard JS — loaded as external file to avoid HTML parser issues
(function() {
  "use strict";

  var isNewSignup = false;
  var pollTimer   = null;
  var pollCount   = 0;

  function init() {
    isNewSignup = new URLSearchParams(location.search).get("new") === "1";
    if (isNewSignup) {
      var banner = document.getElementById("newBanner");
      if (banner) banner.style.display = "block";
      history.replaceState({}, "", "/portal/dashboard");
      schedulePoll();
    }

    loadPortalAnalytics();
    loadSettings();
    loadCourts();
    loadDocuments();
    loadChatUsage();
  }

  // ── Polling (for new signups while crawl runs) ────────────────────────────
  function schedulePoll() {
    var delay = pollCount < 15 ? 8000 : 20000;
    pollTimer = setTimeout(pollStatus, delay);
  }

  function pollStatus() {
    pollCount++;
    fetch("/api/portal/status")
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.docCount > 0 && data.chunkCount > 0) {
          var banner = document.getElementById("newBanner");
          if (banner) banner.style.display = "none";
          isNewSignup = false;
          loadDocuments();
        } else {
          if (pollCount < 60) schedulePoll();
        }
      })
      .catch(function() {
        if (pollCount < 60) schedulePoll();
      });
  }

  // ── Load & render documents (called after upload/delete) ──────────────────
  var _kbWebsiteData  = [];
  var _kbUploadedData = [];
  var _kbUploadedPage = 0;
  var KB_DOC_PAGE_SIZE = 6;

  function renderKbDocs() {
    var el = document.getElementById("docList");
    if (!el) return;
    var domains  = _kbWebsiteData;
    var uploaded = _kbUploadedData;
    var html = "";

    if (domains.length) {
      html += '<div class="section-label">Imported Websites</div>';
      domains.forEach(function(site) {
        var date = site.date ? new Date(site.date).toLocaleDateString("en-IE", { day:"numeric", month:"short", year:"numeric" }) : "";
        html += '<div class="website-row">'
          + '<div class="website-row-left"><div class="globe-icon">&#127760;</div><div>'
          + '<div class="website-domain">' + esc(site.domain) + '</div>'
          + '<div class="website-meta">' + site.pages + " page" + (site.pages !== 1 ? "s" : "") + " · Imported " + date + "</div>"
          + '</div></div>'
          + '<button class="btn-reimport-website" onclick="portalReimportWebsite(\'' + esc(site.domain) + '\',\'' + esc(site.sampleUrl || ("https://" + site.domain)) + '\')">🔄 Re-import</button>'
          + '<button class="btn-remove-website" onclick="portalRemoveWebsite(\'' + esc(site.domain) + '\')">Remove</button>'
          + '</div>';
      });
    }

    if (uploaded.length) {
      var start      = _kbUploadedPage * KB_DOC_PAGE_SIZE;
      var pageItems  = uploaded.slice(start, start + KB_DOC_PAGE_SIZE);
      var totalPages = Math.ceil(uploaded.length / KB_DOC_PAGE_SIZE);
      html += '<div class="section-label" style="margin-top:' + (domains.length ? "24px" : "0") + '">Uploaded Documents</div>';
      pageItems.forEach(function(doc) {
        var ext   = (doc.original_filename || "").split(".").pop().toLowerCase();
        var badge = ext === "pdf"  ? '<span class="doc-type-badge badge-pdf">PDF</span>'
                  : ext === "docx" ? '<span class="doc-type-badge badge-docx">DOCX</span>'
                  : '<span class="doc-type-badge badge-txt">TXT</span>';
        var date  = doc.uploaded_at ? new Date(doc.uploaded_at).toLocaleDateString("en-IE", { day:"numeric", month:"short", year:"numeric" }) : "";
        html += '<div class="doc-row" id="doc-' + esc(doc.id) + '">'
          + badge
          + '<div class="doc-info"><div class="doc-name">' + esc(doc.original_filename || "Untitled") + '</div>'
          + '<div class="doc-meta">Uploaded ' + date + '</div></div>'
          + '<button class="btn-delete" onclick="portalDeleteDoc(\'' + esc(doc.id) + '\',\'' + esc(doc.original_filename || "") + '\')">Delete</button>'
          + '</div>';
      });
      if (totalPages > 1) {
        var prevDis = _kbUploadedPage === 0;
        var nextDis = _kbUploadedPage >= totalPages - 1;
        html += '<div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-top:14px;padding-top:12px;border-top:1px solid #f3f4f6;">'
          + '<button onclick="kbDocPrev()" ' + (prevDis ? 'disabled ' : '') + 'style="padding:5px 14px;border-radius:7px;border:1px solid #d1d5db;background:#fff;font-size:13px;cursor:pointer;color:#374151;opacity:' + (prevDis ? '0.4' : '1') + ';">← Prev</button>'
          + '<span style="font-size:13px;color:#6b7280;">' + (_kbUploadedPage + 1) + ' / ' + totalPages + '</span>'
          + '<button onclick="kbDocNext()" ' + (nextDis ? 'disabled ' : '') + 'style="padding:5px 14px;border-radius:7px;border:1px solid #d1d5db;background:#fff;font-size:13px;cursor:pointer;color:#374151;opacity:' + (nextDis ? '0.4' : '1') + ';">Next →</button>'
          + '</div>';
      }
    }

    if (!domains.length && !uploaded.length) {
      html = '<div class="empty-state" style="margin-top:24px;">No documents yet — your website content will appear here after import.</div>';
    }

    el.innerHTML = html;
  }

  window.kbDocPrev = function() { if (_kbUploadedPage > 0) { _kbUploadedPage--; renderKbDocs(); } };
  window.kbDocNext = function() { if ((_kbUploadedPage + 1) * KB_DOC_PAGE_SIZE < _kbUploadedData.length) { _kbUploadedPage++; renderKbDocs(); } };

  function loadDocuments() {
    var el = document.getElementById("docList");
    if (!el) return;
    el.innerHTML = '<div class="empty-state" style="margin-top:24px;">Loading your documents…</div>';

    fetch("/api/portal/documents")
      .then(function(r) { return r.json(); })
      .then(function(docs) {
        var websites = docs.filter(function(d) { return d.document_type === "Website Content"; });
        var uploaded = docs.filter(function(d) { return d.document_type !== "Website Content"; });

        var domainMap = {};
        websites.forEach(function(d) {
          try {
            var pageUrl = d.stored_filename || d.storage_path || "";
            var domain = new URL(pageUrl).hostname;
            if (!domainMap[domain]) domainMap[domain] = { domain: domain, pages: 0, date: d.uploaded_at, sampleUrl: pageUrl };
            domainMap[domain].pages++;
          } catch(e) {}
        });

        _kbWebsiteData  = Object.values(domainMap);
        _kbUploadedData = uploaded;
        _kbUploadedPage = 0;
        renderKbDocs();
      })
      .catch(function() {
        if (el) el.innerHTML = '<div class="empty-state" style="margin-top:24px;">Could not load documents.</div>';
      });
  }

  // ── Upload — two-step flow ────────────────────────────────────────────────
  var _pendingUploadFile = null;

  window.portalFileChosen = function(file) {
    if (!file) return;
    _pendingUploadFile = file;
    var label = document.getElementById("fileChosenLabel");
    if (label) label.textContent = file.name;
    // Reset and reveal metadata form
    var desc     = document.getElementById("uploadDescription");
    var type     = document.getElementById("uploadDocType");
    var effDate  = document.getElementById("uploadEffectiveDate");
    var expDate  = document.getElementById("uploadExpiryDate");
    var tags     = document.getElementById("uploadTags");
    var audience = document.getElementById("uploadAudience");
    var replaces = document.getElementById("uploadReplaces");
    var jr       = document.getElementById("uploadJuniorAccess");
    if (desc)     desc.value    = "";
    if (type)     type.value    = "";
    if (effDate)  effDate.value = "";
    if (expDate)  expDate.value = "";
    if (tags)     tags.value    = "";
    if (audience) audience.value = "Everyone";
    if (replaces) { replaces.innerHTML = '<option value="">— Not replacing an existing document —</option>'; }
    if (jr)       jr.checked    = true;
    var form = document.getElementById("uploadMetadataForm");
    if (form) form.style.display = "";
    var status = document.getElementById("uploadStatus");
    if (status) { status.style.display = "none"; status.textContent = ""; }
    portalUpdateFilenamePreview();
    if (desc) desc.focus();
  };

  window.portalUpdateFilenamePreview = function() {
    var file = _pendingUploadFile;
    if (!file) return;
    var desc    = ((document.getElementById("uploadDescription") || {}).value || "").trim();
    var type    = ((document.getElementById("uploadDocType")     || {}).value || "").trim();
    var preview = document.getElementById("uploadFilenamePreview");
    var previewText = document.getElementById("uploadFilenameText");
    if (!preview || !previewText) return;
    var ext  = file.name.split(".").pop().toLowerCase();
    var safe = function(s) { return s.replace(/[\/\\:*?"<>|]/g, "").replace(/\s+/g, " ").trim(); };
    if (type && desc) {
      previewText.textContent = safe(type) + " - " + safe(desc) + "." + ext;
      preview.style.display = "";
    } else {
      preview.style.display = "none";
    }
  };

  window.portalClearUpload = function() {
    _pendingUploadFile = null;
    var fileInput = document.getElementById("fileInput");
    if (fileInput) fileInput.value = "";
    var label = document.getElementById("fileChosenLabel");
    if (label) label.textContent = "Select Document";
    ["uploadDescription","uploadDocType","uploadEffectiveDate","uploadExpiryDate","uploadTags"].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.value = "";
    });
    var audience = document.getElementById("uploadAudience");
    if (audience) audience.value = "Everyone";
    var replaces = document.getElementById("uploadReplaces");
    if (replaces) replaces.innerHTML = '<option value="">— Not replacing an existing document —</option>';
    var jr = document.getElementById("uploadJuniorAccess");
    if (jr) jr.checked = true;
    var form = document.getElementById("uploadMetadataForm");
    if (form) form.style.display = "none";
    var status = document.getElementById("uploadStatus");
    if (status) { status.style.display = "none"; status.textContent = ""; }
  };

  // Populate the "Replaces" dropdown with existing docs of the selected type
  window.portalUpdateReplaces = function() {
    var type     = ((document.getElementById("uploadDocType") || {}).value || "").trim();
    var replaces = document.getElementById("uploadReplaces");
    if (!replaces) return;
    replaces.innerHTML = '<option value="">— Not replacing an existing document —</option>';
    if (!type) return;
    fetch("/api/portal/documents?type=" + encodeURIComponent(type))
      .then(function(r) { return r.json(); })
      .then(function(docs) {
        // Exclude Website Content — those are managed by Re-crawl
        var uploaded = (docs || []).filter(function(d) { return d.document_type !== "Website Content"; });
        uploaded.forEach(function(d) {
          var opt = document.createElement("option");
          opt.value = d.id;
          opt.textContent = d.original_filename || d.description || d.id;
          replaces.appendChild(opt);
        });
      })
      .catch(function() {});
  };

  window.portalSubmitUpload = function() {
    var file     = _pendingUploadFile;
    if (!file) return;
    var desc     = ((document.getElementById("uploadDescription")    || {}).value || "").trim();
    var type     = ((document.getElementById("uploadDocType")        || {}).value || "").trim();
    var effDate  = ((document.getElementById("uploadEffectiveDate")  || {}).value || "").trim();
    var expDate  = ((document.getElementById("uploadExpiryDate")     || {}).value || "").trim();
    var tags     = ((document.getElementById("uploadTags")           || {}).value || "").trim();
    var audience = ((document.getElementById("uploadAudience")       || {}).value || "Everyone").trim();
    var replaces = ((document.getElementById("uploadReplaces")       || {}).value || "").trim();
    var junior   = !!((document.getElementById("uploadJuniorAccess") || {}).checked);
    var btn      = document.getElementById("uploadSubmitBtn");

    if (!desc) { alert("Please enter a description."); return; }
    if (!type) { alert("Please select a document type."); return; }

    var status = document.getElementById("uploadStatus");
    status.className = "upload-status loading";
    status.textContent = "Uploading and processing…";
    status.style.display = "block";
    if (btn) btn.disabled = true;

    var fd = new FormData();
    fd.append("document",              file);
    fd.append("description",           desc);
    fd.append("document_type",         type);
    fd.append("effective_date",        effDate);
    fd.append("expiry_date",           expDate);
    fd.append("tags",                  tags);
    fd.append("audience",              audience);
    fd.append("replaces_document_id",  replaces);
    fd.append("junior_accessible",     junior ? "true" : "false");

    fetch("/api/portal/upload", { method: "POST", body: fd })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (btn) btn.disabled = false;
        if (data.success) {
          status.className = "upload-status success";
          status.textContent = "✅ " + (data.document.name || file.name) + " added to your knowledge base.";
          portalClearUpload();
          loadDocuments();
        } else {
          status.className = "upload-status error";
          status.style.whiteSpace = "pre-line";
          status.textContent = "❌ " + (data.error || "Upload failed.");
        }
      })
      .catch(function() {
        if (btn) btn.disabled = false;
        status.className = "upload-status error";
        status.textContent = "❌ Upload failed. Please try again.";
      });
  };

  // ── Delete doc ────────────────────────────────────────────────────────────
  window.portalDeleteDoc = function(id, name) {
    if (!confirm("Delete \"" + name + "\"? This cannot be undone.")) return;
    var row = document.getElementById("doc-" + id);
    if (row) row.style.opacity = "0.4";
    fetch("/api/portal/documents/" + id, { method: "DELETE" })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success) { loadDocuments(); }
        else { if (row) row.style.opacity = ""; alert("Failed to delete: " + (data.error || "unknown error")); }
      });
  };

  // ── Re-import website ─────────────────────────────────────────────────────
  window.portalReimportWebsite = function(domain, sampleUrl) {
    if (!confirm("Re-import website?\n\nThis will remove the existing pages and re-scan your website from scratch — upgrading them to the latest AI format.\n\nOther websites and uploaded documents are not affected.\n\nThis takes 2–3 minutes.")) return;

    var status = document.getElementById("uploadStatus");
    status.className = "upload-status loading";
    status.textContent = "⏳ Re-importing website… this takes 2–3 minutes. You can leave this page.";
    status.style.display = "block";

    // Use /api/portal/recrawl — reads tenants.website fresh from DB so the
    // correct URL is always used even if the website field was recently updated.
    fetch("/api/portal/recrawl", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) {
          status.className = "upload-status success";
          status.textContent = "✅ Re-import started — refreshing in 30 seconds…";
          setTimeout(function() { loadDocuments(); status.style.display = "none"; }, 30000);
        } else {
          status.className = "upload-status error";
          status.textContent = "❌ " + (data.error || "Re-import failed.");
        }
      })
      .catch(function() {
        status.className = "upload-status error";
        status.textContent = "❌ Re-import failed. Please try again.";
      });
  };

  // ── Remove website ────────────────────────────────────────────────────────
  window.portalRemoveWebsite = function(domain) {
    if (!confirm("Remove all pages from " + domain + "? This cannot be undone.")) return;
    fetch("/api/portal/website", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: domain })
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success) { loadDocuments(); }
        else { alert("Failed to remove website: " + (data.error || "unknown error")); }
      });
  };

  // ── Paste Knowledge ───────────────────────────────────────────────────────
  window.portalPasteKnowledge = function() {
    var title  = (document.getElementById("pasteKbTitle")  || {}).value || "";
    var text   = (document.getElementById("pasteKbText")   || {}).value || "";
    var status = document.getElementById("pasteKbStatus");
    if (!title.trim() || !text.trim()) {
      if (status) { status.style.color = "#dc2626"; status.textContent = "Please enter both a title and some text."; }
      return;
    }
    if (status) { status.style.color = "#6b7280"; status.textContent = "Saving…"; }
    fetch("/api/portal/knowledge-documents/paste", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.trim(), text: text.trim() })
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success) {
          if (status) { status.style.color = "#16a34a"; status.textContent = "✅ Saved to knowledge base."; }
          document.getElementById("pasteKbTitle").value = "";
          document.getElementById("pasteKbText").value  = "";
          loadDocuments();
          setTimeout(function() { if (status) status.textContent = ""; }, 4000);
        } else {
          if (status) { status.style.color = "#dc2626"; status.textContent = "❌ " + (data.error || "Failed to save."); }
        }
      })
      .catch(function() {
        if (status) { status.style.color = "#dc2626"; status.textContent = "❌ Something went wrong. Please try again."; }
      });
  };

  // ── Import from Website ───────────────────────────────────────────────────
  window.portalImportWebsite = function() {
    var urlVal  = ((document.getElementById("importWebsiteUrl") || {}).value || "").trim();
    var status  = document.getElementById("importWebsiteStatus");
    var btn     = document.getElementById("importWebsiteBtn");
    if (!urlVal) {
      if (status) { status.style.color = "#dc2626"; status.textContent = "Please enter a URL."; }
      return;
    }
    if (btn) btn.disabled = true;
    if (status) { status.style.color = "#6b7280"; status.textContent = "Crawling website — this takes 2–3 minutes. You can navigate away; it will run in the background."; }
    fetch("/api/portal/import-website", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: urlVal })
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (btn) btn.disabled = false;
        if (data.success) {
          if (status) { status.style.color = "#16a34a"; status.textContent = "✅ Import started — your documents will appear below in a few minutes."; }
          document.getElementById("importWebsiteUrl").value = "";
          setTimeout(function() { loadDocuments(); }, 30000);
        } else {
          if (status) { status.style.color = "#dc2626"; status.textContent = "❌ " + (data.error || "Import failed."); }
        }
      })
      .catch(function() {
        if (btn) btn.disabled = false;
        if (status) { status.style.color = "#dc2626"; status.textContent = "❌ Something went wrong. Please try again."; }
      });
  };

  // ── Analytics ─────────────────────────────────────────────────────────────
  function loadPortalAnalytics() {
    var el = document.getElementById("analyticsContent");
    if (!el) return;

    fetch("/api/portal/analytics")
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.error) { el.innerHTML = '<p style="color:#dc2626;font-size:13px;">Could not load analytics.</p>'; return; }

        var maxBar = Math.max.apply(null, d.trend.map(function(t) { return t.count; })) || 1;

        var sparkHtml = '<div class="sparkline">'
          + d.trend.map(function(t, i) {
              var h   = Math.round((t.count / maxBar) * 60);
              var cls = i === 6 ? "spark-bar spark-today" : "spark-bar";
              return '<div class="spark-col">'
                + '<div class="spark-count">' + (t.count || "") + '</div>'
                + '<div class="spark-bar-wrap"><div class="' + cls + '" style="height:' + (t.count ? h : 3) + 'px;"></div></div>'
                + '<div class="spark-label">' + t.label + '</div>'
                + '</div>';
            }).join("")
          + '</div>';

        var maxTopic = d.topTopics.length ? d.topTopics[0].count : 1;
        var topicsHtml = d.topTopics.length
          ? d.topTopics.map(function(t) {
              var pct = Math.round((t.count / maxTopic) * 100);
              return '<div class="topic-row">'
                + '<div class="topic-name">' + esc(t.topic) + '</div>'
                + '<div class="topic-bar-bg"><div class="topic-bar-fill" style="width:' + pct + '%;"></div></div>'
                + '<div class="topic-count">' + t.count + '</div>'
                + '</div>';
            }).join("")
          : '<p style="font-size:13px;color:#9ca3af;">Not enough data yet.</p>';

        var answerRateHtml = d.answerRate !== null
          ? '<div class="analytics-section" style="margin-bottom:0;padding-bottom:0;">'
            + '<div class="analytics-section-title">Knowledge base — last 30 days</div>'
            + '<div class="stat-tiles" style="margin-top:10px;">'
            + '<div class="stat-tile"><div class="stat-value" style="color:#16a34a;">' + d.answeredCount + '</div><div class="stat-label">Answered by AI</div></div>'
            + '<div class="stat-tile"><div class="stat-value" style="color:#dc2626;">' + d.fallbackCount + '</div><div class="stat-label">Couldn\'t answer</div></div>'
            + '<div class="stat-tile"><div class="stat-value">' + d.answerRate + '%</div><div class="stat-label">Answer rate</div></div>'
            + '</div>'
            + '</div>'
          : '';

        el.innerHTML = ''
          + '<div class="stat-tiles">'
          + '<div class="stat-tile"><div class="stat-value">' + d.todayCount + '</div><div class="stat-label">Today</div></div>'
          + '<div class="stat-tile"><div class="stat-value">' + d.totalConversations + '</div><div class="stat-label">Last 30 days</div></div>'
          + '<div class="stat-tile"><div class="stat-value">' + d.avgMessages + '</div><div class="stat-label">Avg messages</div></div>'
          + '</div>'
          + '<div class="analytics-section"><div class="analytics-section-title">Conversations — last 7 days</div>' + sparkHtml + '</div>'
          + '<div class="analytics-section"><div class="analytics-section-title">Top topics</div>' + topicsHtml + '</div>'
          + answerRateHtml;
      })
      .catch(function() {
        if (el) el.innerHTML = '<p style="font-size:13px;color:#9ca3af;">Could not load analytics.</p>';
      });
  }

  // ── Test assistant ────────────────────────────────────────────────────────
  window.askAssistant = function() {
    var input = document.getElementById("testInput");
    var btn   = document.getElementById("askBtn");
    var resp  = document.getElementById("testResponse");
    var msg   = input.value.trim();

    if (!msg) {
      resp.textContent = "Please type a question first.";
      resp.style.display = "block";
      return;
    }

    btn.disabled = true;
    btn.textContent = "Asking…";
    resp.style.display = "none";

    fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "portal-test-" + window.tenantId,
        conversationId: "portal-conv-" + window.tenantId,
        message: msg,
        clubId: window.tenantId
      })
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        resp.textContent = data.reply || "No response.";
        resp.style.display = "block";
        btn.disabled = false;
        btn.textContent = "Ask";
      })
      .catch(function() {
        resp.textContent = "Could not connect to your assistant.";
        resp.style.display = "block";
        btn.disabled = false;
        btn.textContent = "Ask";
      });
  };

  // ── Copy embed ────────────────────────────────────────────────────────────
  window.copyEmbed = function() {
    var code = document.getElementById("embedCode").textContent;
    navigator.clipboard.writeText(code).then(function() {
      var btn = document.querySelector(".btn-copy");
      btn.textContent = "Copied!";
      setTimeout(function() { btn.textContent = "Copy"; }, 2000);
    });
  };

  // ── Helper ────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  }

  // ── Feature Settings ──────────────────────────────────────────────────────
  var _settings = null; // cache so toggling is instant

  function loadSettings() {
    var body = document.getElementById("settingsBody");
    if (!body) return;

    fetch("/api/portal/settings")
      .then(function(r) { return r.json(); })
      .then(function(d) {
        _settings = d;
        renderSettings(d);
        applyTrainStaffVisibility(d.train_staff_enabled);
      })
      .catch(function() {
        if (body) body.innerHTML = '<p style="font-size:13px;color:#dc2626;">Could not load settings.</p>';
      });
  }

  function loadChatUsage() {
    fetch("/api/portal/chat-usage")
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var card  = document.getElementById("chatUsageCard");
        var meter = document.getElementById("chatUsageMeter");
        if (!card || !meter) return;
        if (d.limit === null || d.used === null) return; // unlimited — hide card
        card.style.display = "block";
        var pct     = Math.min(100, Math.round((d.used / d.limit) * 100));
        var barColor = pct >= 100 ? "#dc2626" : pct >= 80 ? "#f59e0b" : "#2563eb";
        var now       = new Date();
        var nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        var resetStr  = nextReset.toLocaleDateString("en-IE", { day: "numeric", month: "long" });
        var daysLeft  = Math.ceil((nextReset - now) / (1000 * 60 * 60 * 24));
        var daysLabel = daysLeft === 1 ? "1 day" : daysLeft + " days";
        var resetNote = "Resets " + resetStr + " — " + daysLabel + " away";
        meter.innerHTML =
          '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;">'
          + '<span style="font-size:22px;font-weight:700;color:#111827;">' + d.used + ' <span style="font-size:14px;font-weight:400;color:#6b7280;">/ ' + d.limit + ' conversations</span></span>'
          + '<span style="font-size:13px;color:#6b7280;">' + pct + '%</span>'
          + '</div>'
          + '<div style="height:8px;background:#e5e7eb;border-radius:99px;overflow:hidden;margin-bottom:10px;">'
          + '<div style="height:100%;width:' + pct + '%;background:' + barColor + ';border-radius:99px;transition:width 0.4s;"></div>'
          + '</div>'
          + '<div style="font-size:12px;color:#9ca3af;">' + resetNote + '</div>';
      })
      .catch(function() {}); // silently ignore — non-critical
  }

  function renderSettings(d) {
    var body = document.getElementById("settingsBody");
    if (!body) return;
    body.innerHTML = ''
      // Assistant Name
      + '<div style="margin-bottom:20px;padding-bottom:20px;border-bottom:1px solid #f3f4f6;">'
      + '<div class="toggle-label" style="margin-bottom:4px;">Assistant Name</div>'
      + '<div class="toggle-sub" style="margin-bottom:10px;">The name shown on the chat widget and check-in page. Defaults to Maeve.</div>'
      + '<input id="assistantNameInput" type="text" placeholder="Maeve" value="' + (d.assistant_name || 'Maeve') + '" style="width:100%;border:1.5px solid #e5e7eb;border-radius:8px;padding:9px 12px;font-size:14px;font-family:inherit;outline:none;box-sizing:border-box;">'
      + '<div style="display:flex;align-items:center;gap:10px;margin-top:8px;">'
      + '<button onclick="saveAssistantName()" style="background:#111827;color:#fff;border:none;border-radius:8px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;">Save name</button>'
      + '<span id="assistantNameStatus" style="font-size:13px;color:#6b7280;"></span>'
      + '</div>'
      + '</div>'
      // Year Founded
      + '<div style="margin-bottom:20px;padding-bottom:20px;border-bottom:1px solid #f3f4f6;">'
      + '<div class="toggle-label" style="margin-bottom:4px;">Year Founded</div>'
      + '<div class="toggle-sub" style="margin-bottom:10px;">Shown on the check-in poster as "Est. YYYY". Leave blank to hide it.</div>'
      + '<input id="foundedYearInput" type="number" min="1800" max="' + new Date().getFullYear() + '" placeholder="e.g. 1893" value="' + (d.founded_year || '') + '" style="width:160px;border:1.5px solid #e5e7eb;border-radius:8px;padding:9px 12px;font-size:14px;font-family:inherit;outline:none;">'
      + '<div style="display:flex;align-items:center;gap:10px;margin-top:8px;">'
      + '<button onclick="saveFoundedYear()" style="background:#111827;color:#fff;border:none;border-radius:8px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;">Save year</button>'
      + '<span id="foundedYearStatus" style="font-size:13px;color:#6b7280;"></span>'
      + '</div>'
      + '</div>'
      // AI Assistant Description
      + '<div style="margin-bottom:20px;padding-bottom:20px;border-bottom:1px solid #f3f4f6;">'
      + '<div class="toggle-label" style="margin-bottom:4px;">AI Assistant Description</div>'
      + '<div class="toggle-sub" style="margin-bottom:10px;">Tells the assistant what your business does — makes responses more accurate and relevant to your customers.</div>'
      + '<textarea id="bizDesc" rows="2" style="width:100%;border:1.5px solid #e5e7eb;border-radius:8px;padding:10px 12px;font-size:14px;font-family:inherit;resize:vertical;outline:none;box-sizing:border-box;" placeholder="e.g. a claims solutions provider covering motor, property, and liability insurance">' + (d.business_description || '') + '</textarea>'
      + '<div style="display:flex;align-items:center;gap:10px;margin-top:8px;">'
      + '<button onclick="saveBizDesc()" style="background:#111827;color:#fff;border:none;border-radius:8px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;">Save description</button>'
      + '<span id="bizDescStatus" style="font-size:13px;color:#6b7280;"></span>'
      + '</div>'
      + '</div>'
      // AI Receptionist toggle
      + '<div class="toggle-row">'
      + '<div class="toggle-info"><div class="toggle-label">AI Receptionist</div>'
      + '<div class="toggle-sub">Turn off to disable the AI chat for your website visitors and QR code link.</div></div>'
      + '<label class="toggle-switch">'
      + '<input type="checkbox" id="tog-ai" ' + (d.ai_enabled ? 'checked' : '') + ' onchange="portalToggleSetting(\'ai_enabled\', this.checked)">'
      + '<span class="toggle-track"></span></label>'
      + '</div>'
      // Train Staff toggle
      + '<div class="toggle-row">'
      + '<div class="toggle-info"><div class="toggle-label">Train Staff on Knowledge Base</div>'
      + '<div class="toggle-sub">Lets you add staff members who can log in and query the knowledge base for training. Unlocks Flagged &amp; Approved Answers.</div></div>'
      + '<label class="toggle-switch">'
      + '<input type="checkbox" id="tog-train" ' + (d.train_staff_enabled ? 'checked' : '') + ' onchange="portalToggleSetting(\'train_staff_enabled\', this.checked)">'
      + '<span class="toggle-track"></span></label>'
      + '</div>'
      // Staff management (always rendered, show/hide via CSS)
      + '<div class="staff-section" id="staffSection" style="display:' + (d.train_staff_enabled ? 'block' : 'none') + ';">'
      + '<div class="staff-section-title">Staff Members</div>'
      + '<div id="staffList"><div style="font-size:13px;color:#9ca3af;">Loading…</div></div>'
      + '<div class="staff-add-form">'
      + '<div class="staff-add-title">Add Staff Member</div>'
      + '<div class="staff-add-fields">'
      + '<input class="staff-input" type="text" id="staffName" placeholder="Full name" />'
      + '<input class="staff-input" type="email" id="staffEmail" placeholder="Email address" />'
      + '<input class="staff-input" type="text" id="staffPass" placeholder="Password" />'
      + '<button class="btn-add-staff" onclick="portalAddStaff()">Add</button>'
      + '</div>'
      + '<div class="staff-status" id="staffStatus"></div>'
      + '</div>'
      + '</div>'
      // Social Media
      + '<div style="margin-top:24px;padding-top:20px;border-top:1px solid #f3f4f6;margin-bottom:20px;padding-bottom:20px;border-bottom:1px solid #f3f4f6;">'
      + '<div class="toggle-label" style="margin-bottom:4px;">Social Media</div>'
      + '<div class="toggle-sub" style="margin-bottom:12px;">Shown on your Sprimal website. Handles without the @ symbol.</div>'
      + '<div style="display:flex;flex-direction:column;gap:8px;">'
      + '<input id="fbUrl" type="url" placeholder="Facebook Page URL (https://facebook.com/...)" value="' + (d.facebook_url || '') + '" style="width:100%;border:1.5px solid #e5e7eb;border-radius:8px;padding:9px 12px;font-size:14px;font-family:inherit;outline:none;box-sizing:border-box;">'
      + '<input id="igHandle" type="text" placeholder="Instagram handle or URL — e.g. passagewestgaaclub" value="' + (d.instagram_handle || '') + '" style="width:100%;border:1.5px solid #e5e7eb;border-radius:8px;padding:9px 12px;font-size:14px;font-family:inherit;outline:none;box-sizing:border-box;">'
      + '<input id="twHandle" type="text" placeholder="Twitter / X handle or URL — e.g. MonkstownLTCC" value="' + (d.twitter_handle || '') + '" style="width:100%;border:1.5px solid #e5e7eb;border-radius:8px;padding:9px 12px;font-size:14px;font-family:inherit;outline:none;box-sizing:border-box;">'
      + '</div>'
      + '<div style="display:flex;align-items:center;gap:10px;margin-top:10px;">'
      + '<button onclick="saveSocialHandles()" style="background:#111827;color:#fff;border:none;border-radius:8px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;">Save</button>'
      + '<span id="socialStatus" style="font-size:13px;color:#6b7280;"></span>'
      + '</div>'
      + '</div>'
      // Club Photos
      + '<div style="margin-bottom:20px;">'
      + '<div class="toggle-label" style="margin-bottom:4px;">Club Photos</div>'
      + '<div class="toggle-sub" style="margin-bottom:12px;">Photos shown on your club website. Upload from your device, paste a URL, or re-fetch from Instagram.</div>'
      + '<div id="photoGrid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;">'
      + renderPhotoGrid(d.social_images || [])
      + '</div>'
      + '<div id="photoUrlPreview" style="margin-bottom:8px;"></div>'
      + '<div style="margin-bottom:8px;">'
      + '<label style="display:inline-flex;align-items:center;gap:8px;background:#111827;color:#fff;border:none;border-radius:8px;padding:9px 16px;font-size:13px;font-weight:600;cursor:pointer;">'
      + '📁 Upload photos from device'
      + '<input id="photoFileInput" type="file" accept="image/*" multiple style="display:none;" onchange="uploadPhotoFiles(this.files)">'
      + '</label>'
      + '<span id="photoUploadStatus" style="font-size:13px;color:#6b7280;margin-left:10px;"></span>'
      + '</div>'
      + '<div style="display:flex;gap:8px;margin-bottom:6px;">'
      + '<input id="photoUrlInput" type="url" placeholder="Or paste image URL…" oninput="previewPhotoUrl(this.value)" style="flex:1;border:1.5px solid #e5e7eb;border-radius:8px;padding:9px 12px;font-size:13px;font-family:inherit;outline:none;box-sizing:border-box;">'
      + '<button onclick="addPhotoFromUrl()" style="background:#fff;color:#374151;border:1.5px solid #e5e7eb;border-radius:8px;padding:9px 16px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;">Add</button>'
      + '</div>'
      + '<div style="display:flex;align-items:center;gap:10px;">'
      + '<button onclick="refetchInstagram()" style="background:#fff;color:#374151;border:1.5px solid #e5e7eb;border-radius:8px;padding:7px 14px;font-size:13px;font-weight:500;cursor:pointer;">↺ Refresh Social Photos</button>'
      + '<span id="photoStatus" style="font-size:13px;color:#6b7280;"></span>'
      + '</div>'
      + '</div>';

    if (d.train_staff_enabled) loadStaff();
  }

  window.portalToggleSetting = function(key, value) {
    // Optimistically update cache
    if (_settings) _settings[key] = value;

    var body = {};
    body[key] = value;
    fetch("/api/portal/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.success) throw new Error(d.error || "save failed");
        if (key === "train_staff_enabled") {
          applyTrainStaffVisibility(value);
          var staffSec = document.getElementById("staffSection");
          if (staffSec) staffSec.style.display = value ? "block" : "none";
          if (value) loadStaff();
        }
      })
      .catch(function(err) {
        // Revert toggle on failure
        var el = document.getElementById(key === "ai_enabled" ? "tog-ai" : "tog-train");
        if (el) el.checked = !value;
        alert("Could not save setting: " + err.message);
      });
  };

  function renderPhotoGrid(images) {
    // Strip logo fallback — it's the club crest, not a club photo
    images = (images || []).filter(function(u) { return !/logo_fallback/i.test(u); });
    if (!images.length) {
      return '<div style="grid-column:1/-1;font-size:13px;color:#9ca3af;padding:8px 0;">No photos yet. Upload from your device, paste a URL, or click Refresh Social Photos.</div>';
    }
    return images.map(function(url) {
      var escaped = url.replace(/'/g, "\\'");
      return '<div style="position:relative;aspect-ratio:1;border-radius:8px;overflow:hidden;background:#f3f4f6;">'
        + '<img src="' + url + '" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.opacity=\'0.2\'">'
        + '<button onclick="removePhoto(\'' + escaped + '\')" title="Remove" '
        + 'style="position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.55);color:#fff;border:none;border-radius:50%;width:22px;height:22px;font-size:13px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;">×</button>'
        + '</div>';
    }).join('');
  }

  window.saveSocialHandles = function() {
    var status = document.getElementById("socialStatus");
    var fb = ((document.getElementById("fbUrl") || {}).value || "").trim();
    var ig = ((document.getElementById("igHandle") || {}).value || "").trim().replace(/^@/, "");
    var tw = ((document.getElementById("twHandle") || {}).value || "").trim().replace(/^@/, "");
    if (status) status.textContent = "Saving…";
    fetch("/api/portal/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ facebook_url: fb, instagram_handle: ig, twitter_handle: tw })
    })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (!d.success) throw new Error(d.error || "save failed");
      if (status) { status.textContent = "Saved ✓"; setTimeout(function() { status.textContent = ""; }, 2500); }
    })
    .catch(function(err) {
      if (status) status.textContent = "Error: " + err.message;
    });
  };

  window.previewPhotoUrl = function(url) {
    var preview = document.getElementById("photoUrlPreview");
    if (!preview) return;
    url = (url || "").trim();
    if (!url) { preview.innerHTML = ""; return; }
    preview.innerHTML = '<span style="font-size:12px;color:#9ca3af;">Loading preview…</span>';
    var img = new Image();
    img.onload = function() {
      var w = img.naturalWidth, h = img.naturalHeight;
      var quality = w >= 1200 ? "High res" : w >= 600 ? "Medium res" : "Low res";
      var color = w >= 1200 ? "#15803d" : w >= 600 ? "#b45309" : "#dc2626";
      preview.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:8px;background:#f9fafb;border-radius:8px;">'
        + '<img src="' + url + '" style="height:60px;width:80px;object-fit:cover;border-radius:6px;flex-shrink:0;">'
        + '<div><div style="font-size:13px;font-weight:600;color:#111827;">' + w + ' × ' + h + ' px</div>'
        + '<div style="font-size:12px;color:' + color + ';font-weight:500;">' + quality + '</div></div></div>';
    };
    img.onerror = function() {
      preview.innerHTML = '<span style="font-size:12px;color:#dc2626;">Could not load image — check the URL</span>';
    };
    img.src = url;
  };

  window.addPhotoFromUrl = function() {
    var input = document.getElementById("photoUrlInput");
    var status = document.getElementById("photoStatus");
    var url = (input ? input.value : "").trim();
    if (!url) return;
    if (status) status.textContent = "Adding…";
    fetch("/api/portal/social-images/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url })
    })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (!d.ok) throw new Error(d.error || "failed");
      if (input) input.value = "";
      var preview = document.getElementById("photoUrlPreview");
      if (preview) preview.innerHTML = "";
      var grid = document.getElementById("photoGrid");
      if (grid) grid.innerHTML = renderPhotoGrid(d.images);
      if (status) { status.textContent = "Added ✓"; setTimeout(function() { status.textContent = ""; }, 2500); }
    })
    .catch(function(err) {
      if (status) status.textContent = "Error: " + err.message;
    });
  };

  window.uploadPhotoFiles = function(files) {
    if (!files || !files.length) return;
    var status = document.getElementById("photoUploadStatus");
    if (status) status.textContent = "Uploading " + files.length + " photo" + (files.length > 1 ? "s" : "") + "…";
    var form = new FormData();
    for (var i = 0; i < files.length; i++) form.append("photos", files[i]);
    fetch("/api/portal/social-images/upload-file", { method: "POST", body: form })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (!d.ok) throw new Error(d.error || "upload failed");
      var grid = document.getElementById("photoGrid");
      if (grid) grid.innerHTML = renderPhotoGrid(d.images);
      var input = document.getElementById("photoFileInput");
      if (input) input.value = "";
      if (status) { status.textContent = "Uploaded " + d.added.length + " photo" + (d.added.length !== 1 ? "s" : "") + " ✓"; setTimeout(function() { status.textContent = ""; }, 3000); }
    })
    .catch(function(err) {
      if (status) status.textContent = "Error: " + err.message;
    });
  };

  window.removePhoto = function(url) {
    var status = document.getElementById("photoStatus");
    if (status) status.textContent = "Removing…";
    fetch("/api/portal/social-images/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url })
    })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (!d.ok) throw new Error(d.error || "failed");
      var grid = document.getElementById("photoGrid");
      if (grid) grid.innerHTML = renderPhotoGrid(d.images);
      if (status) { status.textContent = "Removed ✓"; setTimeout(function() { status.textContent = ""; }, 2500); }
    })
    .catch(function(err) {
      if (status) status.textContent = "Error: " + err.message;
    });
  };

  window.refetchInstagram = function() {
    var status = document.getElementById("photoStatus");
    var grid   = document.getElementById("photoGrid");
    if (status) status.textContent = "Fetching photos… (this takes up to 30s)";
    fetch("/api/portal/social-images/refetch", { method: "POST" })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (!d.ok) throw new Error(d.error || "failed");
      // Poll settings every 5 s until photos update (up to 60 s)
      var before = grid ? grid.querySelectorAll("img").length : 0;
      var tries  = 0;
      var poll   = setInterval(function() {
        tries++;
        fetch("/api/portal/settings")
        .then(function(r) { return r.json(); })
        .then(function(s) {
          var imgs = s.social_images || [];
          if (grid) grid.innerHTML = renderPhotoGrid(imgs);
          if (imgs.length !== before || tries >= 12) {
            clearInterval(poll);
            if (status) { status.textContent = imgs.length > before ? "Photos updated!" : "Done — photos unchanged."; setTimeout(function() { status.textContent = ""; }, 4000); }
          }
        })
        .catch(function() { if (tries >= 12) clearInterval(poll); });
      }, 5000);
    })
    .catch(function(err) {
      if (status) status.textContent = "Error: " + err.message;
    });
  };

  window.saveBizDesc = function() {
    var val    = ((document.getElementById("bizDesc") || {}).value || "").trim();
    var status = document.getElementById("bizDescStatus");
    if (status) status.textContent = "Saving…";
    fetch("/api/portal/settings", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ business_description: val })
    })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (!d.success) throw new Error(d.error || "save failed");
      if (status) { status.textContent = "Saved ✓"; setTimeout(function() { status.textContent = ""; }, 2500); }
    })
    .catch(function(err) {
      if (status) status.textContent = "Error: " + err.message;
    });
  };

  window.saveAssistantName = function() {
    var val    = ((document.getElementById("assistantNameInput") || {}).value || "").trim() || "Maeve";
    var status = document.getElementById("assistantNameStatus");
    if (status) status.textContent = "Saving…";
    fetch("/api/portal/settings", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ assistant_name: val })
    })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (!d.success) throw new Error(d.error || "save failed");
      if (status) { status.textContent = "Saved ✓"; setTimeout(function() { status.textContent = ""; }, 2500); }
    })
    .catch(function(err) {
      if (status) status.textContent = "Error: " + err.message;
    });
  };

  window.saveFoundedYear = function() {
    var input  = document.getElementById("foundedYearInput");
    var status = document.getElementById("foundedYearStatus");
    var raw = (input || {}).value;
    var year = raw === "" ? null : parseInt(raw, 10);
    if (year !== null && (isNaN(year) || year < 1800 || year > new Date().getFullYear())) {
      if (status) status.textContent = "Enter a valid year";
      return;
    }
    if (status) status.textContent = "Saving…";
    fetch("/api/portal/settings", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ founded_year: year })
    })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (!d.success) throw new Error(d.error || "save failed");
      if (window._checkinSettings) window._checkinSettings.founded_year = year;
      if (status) { status.textContent = "Saved ✓"; setTimeout(function() { status.textContent = ""; }, 2500); }
    })
    .catch(function(err) {
      if (status) status.textContent = "Error: " + err.message;
    });
  };

  function applyTrainStaffVisibility(on) {
    var flaggedCard  = document.getElementById("flaggedCard");
    var approvedCard = document.getElementById("approvedCard");
    if (flaggedCard)  { flaggedCard.style.display  = on ? "" : "none"; }
    if (approvedCard) { approvedCard.style.display = on ? "" : "none"; }
    if (on) {
      loadFlaggedAnswers();
      loadApprovedAnswers();
    }
  }

  // ── Staff list ────────────────────────────────────────────────────────────
  function loadStaff() {
    var el = document.getElementById("staffList");
    if (!el) return;
    fetch("/api/portal/staff")
      .then(function(r) { return r.json(); })
      .then(function(staff) {
        if (!staff.length) {
          el.innerHTML = '<div style="font-size:13px;color:#9ca3af;padding:8px 0;">No staff added yet.</div>';
          return;
        }
        el.innerHTML = staff.map(function(s) {
          var initial = (s.name || "?").charAt(0).toUpperCase();
          return '<div class="staff-row">'
            + '<div class="staff-avatar">' + esc(initial) + '</div>'
            + '<div class="staff-info"><div class="staff-name">' + esc(s.name) + '</div><div class="staff-email">' + esc(s.email) + '</div></div>'
            + '<button class="btn-remove-staff" onclick="portalRemoveStaff(\'' + esc(s.id) + '\',\'' + esc(s.name) + '\')">Remove</button>'
            + '</div>';
        }).join("");
      })
      .catch(function() {
        if (el) el.innerHTML = '<div style="font-size:13px;color:#dc2626;">Could not load staff.</div>';
      });
  }

  window.portalAddStaff = function() {
    var name  = (document.getElementById("staffName")  || {}).value || "";
    var email = (document.getElementById("staffEmail") || {}).value || "";
    var pass  = (document.getElementById("staffPass")  || {}).value || "";
    var status = document.getElementById("staffStatus");

    if (!name.trim() || !email.trim() || !pass.trim()) {
      status.className = "staff-status error"; status.textContent = "All three fields are required."; status.style.display = "block";
      return;
    }
    status.className = "staff-status"; status.textContent = "Adding…"; status.style.display = "block";

    fetch("/api/portal/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), email: email.trim(), password: pass.trim() })
    })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) {
          status.className = "staff-status success"; status.textContent = "✅ " + name.trim() + " added.";
          document.getElementById("staffName").value  = "";
          document.getElementById("staffEmail").value = "";
          document.getElementById("staffPass").value  = "";
          loadStaff();
        } else {
          status.className = "staff-status error"; status.textContent = "❌ " + (d.error || "Failed to add staff member.");
        }
      })
      .catch(function() {
        status.className = "staff-status error"; status.textContent = "❌ Request failed. Please try again.";
      });
  };

  window.portalRemoveStaff = function(id, name) {
    if (!confirm("Remove " + name + "? They will no longer be able to log in.")) return;
    fetch("/api/portal/staff/" + id, { method: "DELETE" })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) { loadStaff(); }
        else { alert("Failed to remove staff: " + (d.error || "unknown error")); }
      });
  };

  // ── Flagged Answers ───────────────────────────────────────────────────────
  function loadFlaggedAnswers() {
    var body = document.getElementById("flaggedBody");
    if (!body) return;
    fetch("/api/portal/flagged-answers")
      .then(function(r) { return r.json(); })
      .then(function(items) {
        if (!items.length) {
          body.innerHTML = '<div style="text-align:center;padding:16px;font-size:14px;color:#9ca3af;">No flagged answers yet.</div>';
          return;
        }
        body.innerHTML = '<div class="answers-section">'
          + items.map(function(item) {
              return '<div class="answer-row" id="fa-' + esc(item.id) + '">'
                + '<div class="answer-q">' + esc(item.question) + '</div>'
                + '<div class="answer-a">' + esc(item.answer) + '</div>'
                + (item.feedback ? '<div class="answer-feedback">Feedback: ' + esc(item.feedback) + '</div>' : '')
                + '<div class="answer-actions">'
                + '<button class="btn-approve" onclick="portalReviewFlagged(\'' + escJs(item.id) + '\',\'' + escJs(item.question) + '\',\'' + escJs(item.answer) + '\')">✏️ Review &amp; Approve</button>'
                + '<button class="btn-dismiss" onclick="portalDismissFlagged(\'' + escJs(item.id) + '\')">Dismiss</button>'
                + '</div>'
                + '<div class="fa-edit-panel" id="fa-edit-' + esc(item.id) + '" style="display:none;margin-top:14px;border-top:1px solid #e5e7eb;padding-top:14px;">'
                + '<div style="font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Question</div>'
                + '<input type="text" id="fa-q-' + esc(item.id) + '" style="width:100%;padding:9px 11px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:14px;font-family:inherit;color:#111827;outline:none;margin-bottom:10px;" />'
                + '<div style="font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Answer</div>'
                + '<textarea id="fa-a-' + esc(item.id) + '" rows="4" style="width:100%;padding:9px 11px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:14px;font-family:inherit;color:#111827;outline:none;resize:vertical;line-height:1.55;"></textarea>'
                + '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">'
                + '<button class="btn-approve" onclick="portalSaveApproved(\'' + escJs(item.id) + '\')">✅ Save Approved Answer</button>'
                + '<button class="btn-dismiss" onclick="portalCancelReview(\'' + escJs(item.id) + '\')">Cancel</button>'
                + '</div></div>'
                + '</div>';
            }).join("")
          + '</div>';
      })
      .catch(function() {
        if (body) body.innerHTML = '<p style="font-size:13px;color:#dc2626;">Could not load flagged answers.</p>';
      });
  }

  // Open the inline edit panel, pre-fill fields, hide the action buttons
  window.portalReviewFlagged = function(id, question, answer) {
    var row      = document.getElementById("fa-" + id);
    var panel    = document.getElementById("fa-edit-" + id);
    var qInput   = document.getElementById("fa-q-" + id);
    var aInput   = document.getElementById("fa-a-" + id);
    if (!panel || !qInput || !aInput) return;
    qInput.value = question;
    aInput.value = answer;
    panel.style.display = "";
    // Hide the action buttons row (first .answer-actions inside this row)
    var actions = row ? row.querySelector(".answer-actions") : null;
    if (actions) actions.style.display = "none";
    qInput.focus();
  };

  // Cancel — hide the edit panel, restore action buttons
  window.portalCancelReview = function(id) {
    var row   = document.getElementById("fa-" + id);
    var panel = document.getElementById("fa-edit-" + id);
    if (panel) panel.style.display = "none";
    var actions = row ? row.querySelector(".answer-actions") : null;
    if (actions) actions.style.display = "";
  };

  // Save the (possibly edited) question+answer as an approved answer, then delete the flag
  window.portalSaveApproved = function(id) {
    var qInput = document.getElementById("fa-q-" + id);
    var aInput = document.getElementById("fa-a-" + id);
    if (!qInput || !aInput) return;
    var question = qInput.value.trim();
    var answer   = aInput.value.trim();
    if (!question || !answer) { alert("Please enter both a question and an answer."); return; }

    fetch("/api/portal/approved-answers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: question, answer: answer })
    })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) {
          return fetch("/api/portal/flagged-answers/" + id, { method: "DELETE" });
        }
        throw new Error(d.error || "save failed");
      })
      .then(function() {
        loadFlaggedAnswers();
        loadApprovedAnswers();
      })
      .catch(function(err) { alert("Could not save: " + err.message); });
  };

  window.portalDismissFlagged = function(id) {
    fetch("/api/portal/flagged-answers/" + id, { method: "DELETE" })
      .then(function() { loadFlaggedAnswers(); });
  };

  // ── Approved Answers ──────────────────────────────────────────────────────
  function loadApprovedAnswers() {
    var body = document.getElementById("approvedBody");
    if (!body) return;
    fetch("/api/portal/approved-answers")
      .then(function(r) { return r.json(); })
      .then(function(items) {
        if (!items.length) {
          body.innerHTML = '<div style="text-align:center;padding:16px;font-size:14px;color:#9ca3af;">No approved answers yet.</div>';
          return;
        }
        body.innerHTML = '<div class="answers-section">'
          + items.map(function(item) {
              var dateStr = item.createdAt ? new Date(item.createdAt).toLocaleDateString("en-IE", { day:"numeric", month:"short", year:"numeric" }) : "";
              return '<div class="answer-row" id="aa-' + esc(item.id) + '">'
                + '<div class="answer-q">' + esc(item.question) + '</div>'
                + '<div class="answer-a">' + esc(item.answer) + '</div>'
                + '<div class="answer-actions">'
                + '<span style="font-size:11px;color:#9ca3af;margin-right:auto;">' + esc(item.category || "General") + (dateStr ? " · " + dateStr : "") + '</span>'
                + '<button class="btn-delete-answer" onclick="portalDeleteApproved(\'' + esc(item.id) + '\')">Delete</button>'
                + '</div></div>';
            }).join("")
          + '</div>';
      })
      .catch(function() {
        if (body) body.innerHTML = '<p style="font-size:13px;color:#dc2626;">Could not load approved answers.</p>';
      });
  }

  window.portalDeleteApproved = function(id) {
    if (!confirm("Delete this approved answer?")) return;
    fetch("/api/portal/approved-answers/" + id, { method: "DELETE" })
      .then(function() { loadApprovedAnswers(); });
  };

  // ── Club Check-In ─────────────────────────────────────────────────────────
  function loadCourts() {
    var card = document.getElementById("courtsCard");
    if (!card) return;

    fetch("/api/portal/settings")
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.business_type !== "tennis_club") return;
        card.style.display = "block";
        var noshowCard = document.getElementById("noshowCard");
        if (noshowCard) noshowCard.style.display = "block";

        // Render club QR code
        var tenantId = window.tenantId;
        var settingsData = d;
        if (tenantId) {
          var checkinUrl = "https://app.sprimal.com/checkin/" + tenantId;
          var qrUrl = "https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=10&data=" + encodeURIComponent(checkinUrl);
          var el = document.getElementById("clubQr");
          if (el) {
            el.innerHTML = '<div style="display:flex;align-items:center;gap:14px;padding:14px;background:#f9fafb;border-radius:12px;">'
              + '<img src="' + qrUrl + '" alt="Check-in QR" style="width:160px;height:160px;border-radius:8px;flex-shrink:0;">'
              + '<div>'
              + '<div style="font-size:13px;font-weight:600;color:#111827;margin-bottom:4px;">Club Check-In QR</div>'
              + '<div style="font-size:12px;color:#6b7280;margin-bottom:8px;">Print and display at your club entrance</div>'
              + '<a href="' + qrUrl + '" download="checkin-qr.png" style="font-size:13px;font-weight:600;color:white;background:#1565c0;padding:6px 14px;border-radius:7px;text-decoration:none;">⬇ Download QR</a>'
              + '</div></div>'
              + '<div style="margin-top:14px;">'
              + '<div style="font-size:14px;font-weight:600;color:#374151;margin-bottom:6px;">Print Poster</div>'
              + '<div style="font-size:12px;color:#6b7280;margin-bottom:10px;">Generate an A4 print-ready poster with your club logo and QR code to display at the entrance.</div>'
              + '<button onclick="window.openPosterModal()" style="padding:9px 18px;background:#166534;color:white;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;">🖨 Generate Print Poster</button>'
              + '</div>';
          }
        }

        // Store settings for poster generator
        window._checkinSettings = settingsData;

        // Pre-fill GPS fields if already set
        if (d.checkin_lat) document.getElementById("checkinLat").value = d.checkin_lat;
        if (d.checkin_lng) document.getElementById("checkinLng").value = d.checkin_lng;
        if (d.checkin_radius_meters) document.getElementById("checkinRadius").value = d.checkin_radius_meters;

        renderCaptainDashboard();
        renderCheckinLog();

        // Auto-refresh every 30 seconds so new check-ins appear without a manual reload
        if (window._checkinRefreshInterval) clearInterval(window._checkinRefreshInterval);
        window._checkinRefreshInterval = setInterval(function() {
          renderCaptainDashboard();
          renderCheckinLog();
        }, 30 * 1000);
      });
  }

  function renderCaptainDashboard() {
    fetch("/api/portal/checkins/dashboard")
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var el = document.getElementById("captainDashboard");
        if (!el) return;
        var color = d.no_show_risk ? "#fee2e2" : d.current_checkins > 0 ? "#dcfce7" : "#f9fafb";
        var border = d.no_show_risk ? "#fca5a5" : d.current_checkins > 0 ? "#86efac" : "#e5e7eb";
        var icon = d.no_show_risk ? "🔴" : d.current_checkins > 0 ? "🟢" : "⚪";
        var label = d.no_show_risk ? "No-shows this slot" : d.current_checkins > 0 ? "Members checked in" : "No bookings this slot";
        el.innerHTML = '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:4px;">'
          + '<div style="background:' + color + ';border:1.5px solid ' + border + ';border-radius:12px;padding:16px 20px;display:flex;align-items:center;gap:12px;">'
          + '<div style="font-size:28px;">' + icon + '</div>'
          + '<div><div style="font-size:14px;font-weight:700;color:#111827;">' + label + '</div>'
          + '<div style="font-size:12px;color:#6b7280;margin-top:2px;">Current slot: ' + d.current_checkins + ' checked in / ' + d.current_bookings + ' booked</div>'
          + '<div style="font-size:12px;color:#6b7280;">Today total: ' + d.total_checkins_today + ' check-ins / ' + d.total_bookings_today + ' bookings</div>'
          + '</div></div></div>';
      })
      .catch(function() {});
  }

  function renderCheckinLog() {
    fetch("/api/portal/checkins/log")
      .then(function(r) { return r.json(); })
      .then(function(log) {
        var el = document.getElementById("checkinLog");
        if (!el) return;
        var today = new Date().toISOString().slice(0, 10);
        var todayLog = log.filter(function(c) { return c.checked_in_at.slice(0, 10) === today; });
        if (!todayLog.length) { el.innerHTML = '<div style="font-size:13px;color:#9ca3af;">No check-ins today yet.</div>'; return; }
        el.innerHTML = '<table style="width:100%;font-size:13px;border-collapse:collapse;">'
          + '<thead><tr style="color:#6b7280;text-align:left;border-bottom:1px solid #f3f4f6;">'
          + '<th style="padding:6px 8px;">Member</th><th style="padding:6px 8px;">Time</th><th style="padding:6px 8px;">GPS</th><th style="padding:6px 8px;"></th></tr></thead>'
          + '<tbody>' + todayLog.map(function(c) {
            var t = new Date(c.checked_in_at).toLocaleTimeString("en-IE", { hour: "2-digit", minute: "2-digit" });
            var gpsCell = c.inferred ? '<span style="color:#9ca3af;font-size:12px;">via booking</span>'
              : (c.gps_verified ? '✅ ' + c.gps_distance_meters + 'm' : c.gps_lat ? '⚠️ unverified' : '—');
            var actionCell = c.inferred ? '' : '<button onclick="deleteCheckin(\'' + c.id + '\')" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:12px;padding:2px 6px;" title="Remove check-in">✕</button>';
            var rowStyle = c.inferred ? 'border-bottom:1px solid #f9fafb;opacity:0.75;' : 'border-bottom:1px solid #f9fafb;';
            return '<tr style="' + rowStyle + '" id="checkin-row-' + c.id + '">'
              + '<td style="padding:6px 8px;font-weight:600;">' + c.member_name + ' <span style="color:#9ca3af;font-weight:400;">#' + c.membership_number + '</span></td>'
              + '<td style="padding:6px 8px;color:#374151;">' + t + '</td>'
              + '<td style="padding:6px 8px;">' + gpsCell + '</td>'
              + '<td style="padding:6px 8px;">' + actionCell + '</td>'
              + '</tr>';
          }).join("") + '</tbody></table>';
      })
      .catch(function() {});
  }

  // ── Print Poster Generator ──────────────────────────────────────────────────

  var _posterBg = "#166534"; // default: tennis green
  var _posterBgImage = null; // HTMLImageElement when a photo is selected

  function loadImg(url) {
    return new Promise(function(resolve) {
      var img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = function() { resolve(img); };
      img.onerror = function() { resolve(null); };
      img.src = url;
    });
  }

  function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    var words = text.split(" ");
    var line = "";
    for (var i = 0; i < words.length; i++) {
      var testLine = line + words[i] + " ";
      if (ctx.measureText(testLine).width > maxWidth && i > 0) {
        ctx.fillText(line.trim(), x, y);
        line = words[i] + " ";
        y += lineHeight;
      } else {
        line = testLine;
      }
    }
    ctx.fillText(line.trim(), x, y);
    return y;
  }

  async function renderPosterCanvas() {
    var canvas = document.getElementById("posterCanvas");
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;
    var s = W / 620; // scale factor — all values authored at 620px

    var settings = window._checkinSettings || {};
    var clubName = window.tenantName || "Your Club";
    var tenantId = window.tenantId || "";
    var checkinUrl = "https://app.sprimal.com/checkin/" + tenantId;
    var qrApiUrl = "https://api.qrserver.com/v1/create-qr-code/?size=600x600&margin=8&data=" + encodeURIComponent(checkinUrl);

    var qrImg = await loadImg(qrApiUrl);
    var logoImg = settings.logo_url ? await loadImg(settings.logo_url) : null;

    // ── 3ft: QR-only on white ──────────────────────────────────────────────
    if (_posterSize === "3ft") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);
      if (qrImg) {
        var margin = 28 * s;
        var urlBarH = 36 * s;
        var qrSize = Math.min(W, H - urlBarH) - margin * 2;
        var qrX = (W - qrSize) / 2;
        var qrY = (H - urlBarH - qrSize) / 2;
        ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);
        ctx.fillStyle = "#374151";
        ctx.font = Math.round(14 * s) + "px Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(checkinUrl, W / 2, qrY + qrSize + 26 * s);
      }
      return;
    }

    // Background
    if (_posterBgImage) {
      var bgScale = Math.max(W / _posterBgImage.width, H / _posterBgImage.height);
      var bw = _posterBgImage.width * bgScale, bh = _posterBgImage.height * bgScale;
      ctx.drawImage(_posterBgImage, (W - bw) / 2, (H - bh) / 2, bw, bh);
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = _posterBg;
      ctx.fillRect(0, 0, W, H);
    }

    var pad = 24 * s;

    // ── Top strip: logo + club name (compact) ──────────────────────────────
    var topH = 80 * s;
    ctx.fillStyle = "rgba(0,0,0,0.20)";
    ctx.fillRect(0, 0, W, topH);

    // Logo left, club name centre — or just name centred if no logo
    var nameMaxW = W - pad * 2;
    var nameFontSize = Math.round(24 * s);
    ctx.font = "bold " + nameFontSize + "px Arial, sans-serif";
    while (ctx.measureText(clubName).width > nameMaxW && nameFontSize > Math.round(12 * s)) {
      nameFontSize -= Math.max(1, Math.round(s));
      ctx.font = "bold " + nameFontSize + "px Arial, sans-serif";
    }

    if (logoImg) {
      var logoMax = 44 * s;
      var lsc = Math.min(logoMax / logoImg.width, logoMax / logoImg.height);
      var lw = logoImg.width * lsc, lh = logoImg.height * lsc;
      var logoX = pad;
      var logoY = (topH - lh) / 2;
      ctx.drawImage(logoImg, logoX, logoY, lw, lh);
      // Club name centred in remaining space
      var nameX = logoX + lw + 8 * s + (W - logoX - lw - 8 * s - pad) / 2;
      ctx.textAlign = "center";
      ctx.fillStyle = "white";
      ctx.fillText(clubName, nameX, topH / 2 + nameFontSize * 0.35);
    } else {
      ctx.textAlign = "center";
      ctx.fillStyle = "white";
      ctx.fillText(clubName, W / 2, topH / 2 + nameFontSize * 0.35);
    }

    // ── QR code (dominant) ─────────────────────────────────────────────────
    var bottomH = 110 * s;
    var qrPad = 16 * s;
    var qrSize = Math.min(H - topH - bottomH - qrPad * 2, W - pad * 2);
    var qrX = (W - qrSize) / 2;
    var qrY = topH + qrPad + (H - topH - bottomH - qrPad * 2 - qrSize) / 2;

    if (qrImg) {
      var cardPad = 10 * s;
      ctx.fillStyle = "white";
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(qrX - cardPad, qrY - cardPad, qrSize + cardPad * 2, qrSize + cardPad * 2, 12 * s);
      } else {
        ctx.rect(qrX - cardPad, qrY - cardPad, qrSize + cardPad * 2, qrSize + cardPad * 2);
      }
      ctx.fill();
      ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);
    }

    // ── Bottom strip: headline + URL ───────────────────────────────────────
    var bottomY = H - bottomH;
    ctx.fillStyle = "rgba(0,0,0,0.30)";
    ctx.fillRect(0, bottomY, W, bottomH);

    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold " + Math.round(36 * s) + "px Arial, sans-serif";
    ctx.fillText("SCAN TO CHECK IN", W / 2, bottomY + 42 * s);

    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.font = Math.round(15 * s) + "px Arial, sans-serif";
    var foundedYear = settings.founded_year;
    var footerText = foundedYear
      ? checkinUrl + "  ·  Est. " + foundedYear
      : checkinUrl;
    ctx.fillText(footerText, W / 2, bottomY + 68 * s);

    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = Math.round(11 * s) + "px Arial, sans-serif";
    ctx.fillText("Scan with your phone camera", W / 2, bottomY + 90 * s);
  }

  window.openPosterModal = function() {
    var modal = document.getElementById("posterModal");
    if (!modal) return;
    modal.style.display = "flex";

    // Populate social image thumbnails from crawled website photos
    var settings = window._checkinSettings || {};
    var thumbsEl = document.getElementById("posterSocialThumbs");
    if (thumbsEl && settings.social_images && settings.social_images.length) {
      thumbsEl.innerHTML = settings.social_images.slice(0, 4).map(function(url) {
        return '<div onclick="window.selectPosterBgImg(\'' + url.replace(/'/g,"&#39;") + '\',this)" '
          + 'style="width:72px;height:48px;border-radius:8px;background:url(\'' + url.replace(/'/g,"&#39;") + '\') center/cover;cursor:pointer;border:2px solid #e5e7eb;flex-shrink:0;display:inline-block;"></div>';
      }).join("");
    }

    // Render with default background
    renderPosterCanvas();
  };

  window.closePosterModal = function() {
    var modal = document.getElementById("posterModal");
    if (modal) modal.style.display = "none";
    _posterBgImage = null;
  };

  window.selectPosterBg = function(el, color) {
    _posterBg = color;
    _posterBgImage = null;
    // Update border highlights
    var picker = document.getElementById("posterImagePicker");
    if (picker) picker.querySelectorAll("[data-bg]").forEach(function(d) {
      d.style.border = d === el ? "3px solid #fff" : "2px solid #e5e7eb";
    });
    renderPosterCanvas();
  };

  window.selectPosterBgImg = function(url, el) {
    loadImg(url).then(function(img) {
      if (!img) return;
      _posterBgImage = img;
      // Highlight selected
      var thumbsEl = document.getElementById("posterSocialThumbs");
      if (thumbsEl) thumbsEl.querySelectorAll("div").forEach(function(d) {
        d.style.border = d === el ? "3px solid #1565c0" : "2px solid #e5e7eb";
      });
      renderPosterCanvas();
    });
  };

  window.posterUploadImage = function(input) {
    if (!input.files || !input.files[0]) return;
    var reader = new FileReader();
    reader.onload = function(e) {
      loadImg(e.target.result).then(function(img) {
        if (img) { _posterBgImage = img; renderPosterCanvas(); }
      });
    };
    reader.readAsDataURL(input.files[0]);
  };

  var _posterSize = "2ft"; // default

  window.setPosterSize = function(size, btn) {
    _posterSize = size;
    ["2ft","3ft"].forEach(function(sz) {
      var b = document.getElementById("posterSize" + sz);
      if (!b) return;
      if (sz === size) {
        b.style.background = "#166534"; b.style.color = "white"; b.style.border = "none";
      } else {
        b.style.background = "#f3f4f6"; b.style.color = "#374151"; b.style.border = "1.5px solid #e5e7eb";
      }
    });
    // Show/hide background options — not relevant for QR-only 3ft
    var bgSection = document.getElementById("posterBgSection");
    if (bgSection) bgSection.style.display = size === "3ft" ? "none" : "";
    renderPosterCanvas();
  };

  window.downloadPoster = function() {
    var canvas = document.getElementById("posterCanvas");
    if (!canvas) return;
    // 2ft×2ft at 100dpi = 2400px, 3ft×3ft = 3600px
    var printPx = _posterSize === "3ft" ? 3600 : 2400;
    var origW = canvas.width, origH = canvas.height;
    canvas.width = printPx;
    canvas.height = printPx;
    renderPosterCanvas().then(function() {
      var link = document.createElement("a");
      link.download = (window.tenantName || "club").replace(/\s+/g, "-").toLowerCase()
        + "-checkin-poster-" + _posterSize + ".png";
      link.href = canvas.toDataURL("image/png");
      link.click();
      canvas.width = origW;
      canvas.height = origH;
      renderPosterCanvas();
    });
  };

  window.showManualCheckin = function() {
    var modal = document.getElementById("manualCheckinModal");
    if (modal) { modal.style.display = "flex"; document.getElementById("manualMnum").focus(); }
  };

  window.hideManualCheckin = function() {
    var modal = document.getElementById("manualCheckinModal");
    if (modal) { modal.style.display = "none"; }
    var msg = document.getElementById("manualCheckinMsg");
    if (msg) { msg.style.display = "none"; }
    document.getElementById("manualMnum").value = "";
    document.getElementById("manualName").value = "";
  };

  window.submitManualCheckin = function() {
    var mnum = parseInt((document.getElementById("manualMnum") || {}).value || "");
    var name = ((document.getElementById("manualName") || {}).value || "").trim();
    var msgEl = document.getElementById("manualCheckinMsg");
    function showModalMsg(text, color) {
      if (msgEl) { msgEl.style.display = "block"; msgEl.style.color = color; msgEl.textContent = text; }
    }
    if (!mnum || mnum < 1) { showModalMsg("Please enter a valid membership number.", "#ef4444"); return; }
    if (!name) { showModalMsg("Please enter the member's name.", "#ef4444"); return; }
    fetch("/api/portal/checkins/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ membership_number: mnum, member_name: name })
    })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.ok) {
        window.hideManualCheckin();
        renderCheckinLog();
        renderCaptainDashboard();
      } else {
        showModalMsg(d.error || "Failed to check in.", "#ef4444");
      }
    })
    .catch(function() { showModalMsg("Network error — please try again.", "#ef4444"); });
  };

  window.deleteCheckin = function(id) {
    if (!confirm("Remove this check-in record?")) return;
    fetch("/api/portal/checkins/" + id, { method: "DELETE" })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        if (res.ok) {
          var row = document.getElementById("checkin-row-" + id);
          if (row) row.remove();
        } else {
          alert("Failed to delete: " + (res.error || "unknown error"));
        }
      })
      .catch(function() { alert("Network error — could not delete check-in."); });
  };

  window.setNoshowPeriod = function(period, btn) {
    document.querySelectorAll(".noshow-period-btn").forEach(function(b) { b.classList.remove("active"); });
    btn.classList.add("active");
    loadNoshowReport(period);
  };

  function loadNoshowReport(period) {
    var metrics = document.getElementById("noshow-metrics");
    var table = document.getElementById("noshow-table");
    if (!metrics || !table) return;
    metrics.innerHTML = '<div style="font-size:13px;color:#9ca3af;">Loading...</div>';
    table.innerHTML = "";
    fetch("/api/portal/checkins/noshow-report?period=" + period)
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.error) { metrics.innerHTML = '<div style="font-size:13px;color:#ef4444;">' + d.error + '</div>'; return; }
        var checkins = d.total_bookings - d.total_noshows;
        var rate = d.total_bookings > 0 ? Math.round(d.total_noshows / d.total_bookings * 100) : 0;
        var rateColor = rate >= 60 ? "#991b1b" : rate >= 30 ? "#92400e" : "#166534";
        metrics.innerHTML =
          '<div class="noshow-metric"><p class="noshow-metric-label">Total bookings</p><p class="noshow-metric-value">' + d.total_bookings + '</p></div>' +
          '<div class="noshow-metric"><p class="noshow-metric-label">Checked in</p><p class="noshow-metric-value" style="color:#166534;">' + checkins + '</p></div>' +
          '<div class="noshow-metric"><p class="noshow-metric-label">No-shows</p><p class="noshow-metric-value" style="color:#991b1b;">' + d.total_noshows + '</p></div>' +
          '<div class="noshow-metric"><p class="noshow-metric-label">No-show rate</p><p class="noshow-metric-value" style="color:' + rateColor + ';">' + rate + '%</p></div>';

        if (!d.members || !d.members.length) {
          table.innerHTML = '<div style="font-size:13px;color:#9ca3af;">No booking data for this period.</div>';
          return;
        }
        var PAGE_SIZE = 8;
        var currentPage = 0;
        var members = d.members;

        function renderPage() {
          var start = currentPage * PAGE_SIZE;
          var pageMembers = members.slice(start, start + PAGE_SIZE);
          var totalPages = Math.ceil(members.length / PAGE_SIZE);
          window.toggleNoshowDetail = function(id) {
            var r = document.getElementById(id);
            if (r) r.style.display = r.style.display === "none" ? "table-row" : "none";
          };
          var rows = pageMembers.map(function(m, i) {
            var rank = start + i + 1;
            var badgeClass = m.rate >= 60 ? "noshow-badge-red" : m.rate >= 30 ? "noshow-badge-amber" : "noshow-badge-green";
            var barColor = m.rate >= 60 ? "#ef4444" : m.rate >= 30 ? "#f59e0b" : "#22c55e";
            var detailId = "ns-detail-" + rank;
            var hasNoshows = m.noshows > 0;
            var times = (m.noshow_times || []).map(function(t) {
              var d = new Date(t);
              if (isNaN(d)) return t;
              return d.toLocaleDateString("en-IE", { weekday:"short", day:"numeric", month:"short" }) + " at " +
                     d.toLocaleTimeString("en-IE", { hour:"2-digit", minute:"2-digit", hour12:false });
            });
            var detailRow = hasNoshows
              ? '<tr id="' + detailId + '" style="display:none;background:#fafafa;">' +
                  '<td></td><td colspan="4" style="padding:4px 8px 10px;">' +
                  '<div style="font-size:11px;color:#9ca3af;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.05em;">No-show dates</div>' +
                  '<div style="display:flex;flex-wrap:wrap;gap:5px;">' +
                  times.map(function(t) { return '<span style="font-size:12px;background:#fee2e2;color:#991b1b;padding:3px 9px;border-radius:20px;">' + t + '</span>'; }).join("") +
                  '</div></td></tr>'
              : '';
            var nameStyle = hasNoshows
              ? 'font-size:13px;font-weight:600;color:#1d4ed8;cursor:pointer;'
              : 'font-size:13px;font-weight:600;color:#111827;';
            var nameOnClick = hasNoshows ? ' onclick="toggleNoshowDetail(\'' + detailId + '\')"' : '';
            return '<tr style="border-bottom:1px solid #f3f4f6;">' +
              '<td style="padding:7px 6px;font-size:12px;color:#9ca3af;width:24px;">' + rank + '</td>' +
              '<td style="padding:7px 6px;">' +
                '<div style="' + nameStyle + '"' + nameOnClick + '>' + m.name + (hasNoshows ? ' <span style="font-size:10px;">▾</span>' : '') + '</div>' +
                '<div style="height:4px;background:#f3f4f6;border-radius:2px;margin-top:4px;"><div style="height:4px;width:' + m.rate + '%;background:' + barColor + ';border-radius:2px;"></div></div>' +
              '</td>' +
              '<td style="padding:7px 6px;font-size:13px;color:#6b7280;text-align:right;">' + m.booked + '</td>' +
              '<td style="padding:7px 6px;font-size:13px;font-weight:600;color:#111827;text-align:right;">' + m.noshows + '</td>' +
              '<td style="padding:7px 6px;text-align:right;"><span class="noshow-badge ' + badgeClass + '">' + m.rate + '%</span></td>' +
              '</tr>' + detailRow;
          }).join("");
          var pagination = totalPages > 1
            ? '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 4px 2px;">' +
                '<button onclick="noshowPrev()" ' + (currentPage === 0 ? 'disabled' : '') + ' style="font-size:12px;padding:4px 12px;border:1.5px solid #e5e7eb;border-radius:6px;background:white;color:#374151;cursor:pointer;font-family:inherit;opacity:' + (currentPage === 0 ? '0.4' : '1') + ';">← Prev</button>' +
                '<span style="font-size:12px;color:#9ca3af;">' + (currentPage + 1) + ' / ' + totalPages + '</span>' +
                '<button onclick="noshowNext()" ' + (currentPage >= totalPages - 1 ? 'disabled' : '') + ' style="font-size:12px;padding:4px 12px;border:1.5px solid #e5e7eb;border-radius:6px;background:white;color:#374151;cursor:pointer;font-family:inherit;opacity:' + (currentPage >= totalPages - 1 ? '0.4' : '1') + ';">Next →</button>' +
              '</div>'
            : '';
          table.innerHTML = '<table style="width:100%;border-collapse:collapse;">' +
            '<thead><tr style="border-bottom:1.5px solid #e5e7eb;">' +
            '<th style="padding:5px 6px;font-size:11px;color:#9ca3af;font-weight:500;text-align:left;width:24px;"></th>' +
            '<th style="padding:5px 6px;font-size:11px;color:#9ca3af;font-weight:500;text-align:left;">Member</th>' +
            '<th style="padding:5px 6px;font-size:11px;color:#9ca3af;font-weight:500;text-align:right;">Booked</th>' +
            '<th style="padding:5px 6px;font-size:11px;color:#9ca3af;font-weight:500;text-align:right;">No-shows</th>' +
            '<th style="padding:5px 6px;font-size:11px;color:#9ca3af;font-weight:500;text-align:right;">Rate</th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table>' + pagination;
        }

        window.noshowPrev = function() { if (currentPage > 0) { currentPage--; renderPage(); } };
        window.noshowNext = function() { if ((currentPage + 1) * PAGE_SIZE < members.length) { currentPage++; renderPage(); } };
        renderPage();
      })
      .catch(function() { metrics.innerHTML = '<div style="font-size:13px;color:#ef4444;">Could not load report.</div>'; });
  }

  loadNoshowReport("day");

  window.calibrateGps = function() {
    var msg = document.getElementById("gpsCalibMsg");
    if (msg) { msg.style.display = "inline"; msg.textContent = "Calculating…"; }
    fetch("/api/portal/checkins/gps-centroid")
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.lat || !d.lng) {
          if (msg) msg.textContent = "No GPS check-in data yet.";
          return;
        }
        document.getElementById("checkinLat").value = d.lat;
        document.getElementById("checkinLng").value = d.lng;
        if (msg) msg.textContent = "Prefilled from " + d.count + " check-in" + (d.count !== 1 ? "s" : "") + " — review and save.";
      })
      .catch(function() { if (msg) msg.textContent = "Could not load data."; });
  };

  window.saveGps = function() {
    var latVal = document.getElementById("checkinLat").value.trim();
    var lngVal = document.getElementById("checkinLng").value.trim();
    var radius = parseInt(document.getElementById("checkinRadius").value) || 150;
    var lat = latVal ? parseFloat(latVal) : null;
    var lng = lngVal ? parseFloat(lngVal) : null;
    if ((latVal && isNaN(lat)) || (lngVal && isNaN(lng))) { alert("Please enter valid coordinates."); return; }
    fetch("/api/portal/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ checkin_lat: lat, checkin_lng: lng, checkin_radius_meters: radius }) })
      .then(function() {
        var msg = document.getElementById("gpsSaveMsg");
        if (msg) { msg.style.display = "inline"; setTimeout(function() { msg.style.display = "none"; }, 3000); }
      });
  };

  // ── JS-escape helper for onclick string attrs ─────────────────────────────
  function escJs(s) {
    return String(s || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "");
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
