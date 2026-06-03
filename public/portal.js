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

        var html = "";
        var domains = Object.values(domainMap);

        if (domains.length) {
          html += '<div class="section-label">Imported Websites</div>';
          domains.forEach(function(site) {
            var date = site.date ? new Date(site.date).toLocaleDateString("en-IE", { day:"numeric", month:"short", year:"numeric" }) : "";
            html += '<div class="website-row">'
              + '<div class="website-row-left"><div class="globe-icon">&#127760;</div><div>'
              + '<div class="website-domain">' + esc(site.domain) + '</div>'
              + '<div class="website-meta">' + site.pages + " page" + (site.pages !== 1 ? "s" : "") + " · Imported " + date + "</div>"
              + '</div></div>'
              + '<button class="btn-reimport-website" onclick="portalReimportWebsite(\'' + esc(site.domain) + '\',\'' + esc(site.sampleUrl || ("https://" + site.domain)) + '\')">Re-import</button>'
              + '<button class="btn-remove-website" onclick="portalRemoveWebsite(\'' + esc(site.domain) + '\')">Remove</button>'
              + '</div>';
          });
        }

        if (uploaded.length) {
          html += '<div class="section-label" style="margin-top:' + (domains.length ? "24px" : "0") + '">Uploaded Documents</div>';
          uploaded.forEach(function(doc) {
            var ext = (doc.original_filename || "").split(".").pop().toLowerCase();
            var badge = ext === "pdf"  ? '<span class="doc-type-badge badge-pdf">PDF</span>'
                      : ext === "docx" ? '<span class="doc-type-badge badge-docx">DOCX</span>'
                      : '<span class="doc-type-badge badge-txt">TXT</span>';
            var date = doc.uploaded_at ? new Date(doc.uploaded_at).toLocaleDateString("en-IE", { day:"numeric", month:"short", year:"numeric" }) : "";
            html += '<div class="doc-row" id="doc-' + esc(doc.id) + '">'
              + badge
              + '<div class="doc-info"><div class="doc-name">' + esc(doc.original_filename || "Untitled") + '</div>'
              + '<div class="doc-meta">Uploaded ' + date + '</div></div>'
              + '<button class="btn-delete" onclick="portalDeleteDoc(\'' + esc(doc.id) + '\',\'' + esc(doc.original_filename || "") + '\')">Delete</button>'
              + '</div>';
          });
        }

        if (!domains.length && !uploaded.length) {
          html = '<div class="empty-state" style="margin-top:24px;">No documents yet — your website content will appear here after import.</div>';
        }

        el.innerHTML = html;
      })
      .catch(function() {
        if (el) el.innerHTML = '<div class="empty-state" style="margin-top:24px;">Could not load documents.</div>';
      });
  }

  // ── Upload ────────────────────────────────────────────────────────────────
  window.uploadFile = function(file) {
    if (!file) return;
    var status = document.getElementById("uploadStatus");
    status.className = "upload-status loading";
    status.textContent = "Uploading and processing…";
    status.style.display = "block";

    var fd = new FormData();
    fd.append("document", file);

    fetch("/api/portal/upload", { method: "POST", body: fd })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success) {
          status.className = "upload-status success";
          status.textContent = "✅ " + file.name + " added to your knowledge base.";
          document.getElementById("fileInput").value = "";
          loadDocuments();
        } else {
          status.className = "upload-status error";
          status.textContent = "❌ " + (data.error || "Upload failed.");
        }
      })
      .catch(function() {
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
    if (!confirm("Re-import all pages from " + domain + "? This will add any new pages and may take 2–3 minutes.")) return;

    // Derive root URL from sampleUrl
    var rootUrl;
    try { rootUrl = new URL(sampleUrl).origin; } catch(e) { rootUrl = "https://" + domain; }

    var status = document.getElementById("uploadStatus");
    status.className = "upload-status loading";
    status.textContent = "⏳ Re-importing " + domain + "… this takes 2–3 minutes. You can leave this page.";
    status.style.display = "block";

    fetch("/api/portal/import-website", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: rootUrl })
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success) {
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

        el.innerHTML = ''
          + '<div class="stat-tiles">'
          + '<div class="stat-tile"><div class="stat-value">' + d.todayCount + '</div><div class="stat-label">Today</div></div>'
          + '<div class="stat-tile"><div class="stat-value">' + d.totalConversations + '</div><div class="stat-label">Last 30 days</div></div>'
          + '<div class="stat-tile"><div class="stat-value">' + d.avgMessages + '</div><div class="stat-label">Avg messages</div></div>'
          + '</div>'
          + '<div class="analytics-section"><div class="analytics-section-title">Conversations — last 7 days</div>' + sparkHtml + '</div>'
          + '<div class="analytics-section" style="margin-bottom:0;"><div class="analytics-section-title">Top topics</div>' + topicsHtml + '</div>';
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

  function renderSettings(d) {
    var body = document.getElementById("settingsBody");
    if (!body) return;
    body.innerHTML = ''
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
                + '<button class="btn-approve" onclick="portalApproveFlagged(\'' + esc(item.id) + '\',\'' + escJs(item.question) + '\',\'' + escJs(item.answer) + '\')">✅ Approve &amp; save</button>'
                + '<button class="btn-dismiss" onclick="portalDismissFlagged(\'' + esc(item.id) + '\')">Dismiss</button>'
                + '</div></div>';
            }).join("")
          + '</div>';
      })
      .catch(function() {
        if (body) body.innerHTML = '<p style="font-size:13px;color:#dc2626;">Could not load flagged answers.</p>';
      });
  }

  window.portalApproveFlagged = function(id, question, answer) {
    // Save as approved, then dismiss the flag
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
      .catch(function(err) { alert("Could not approve: " + err.message); });
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
