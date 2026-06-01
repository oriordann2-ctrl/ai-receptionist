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

    var input = document.getElementById("testInput");
    if (input) {
      input.addEventListener("keypress", function(e) {
        if (e.key === "Enter") askAssistant();
      });
    }
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

  // ── Boot ──────────────────────────────────────────────────────────────────
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
