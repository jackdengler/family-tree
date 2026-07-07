/* Dengler Family Tree — vanilla JS.
   The family data ships ENCRYPTED (window.FAMILY_DATA_ENC). Nothing identifying
   is rendered until the visitor unlocks the archive with the passphrase. After a
   successful AES-GCM decryption, init(data) builds the tree, modal and search. */
(function () {
  "use strict";

  /* ===================================================================
     Module state (populated by init once decrypted)
     =================================================================== */
  var DATA = null;
  var people = {};
  var sources = {};
  var treeNodeIds = {};      // ids that appear as blood-ancestor tree nodes
  var childrenIndex = {};    // personId -> [ids of people whose parents[] contains it]
  var searchIndex = [];
  var nodeCardById = {};
  var initialized = false;

  /* ===================================================================
     Small utilities
     =================================================================== */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  function yearOf(dateStr) {
    if (!dateStr) return null;
    var m = String(dateStr).match(/^(\d{4})/);
    return m ? m[1] : null;
  }
  function precisionYear(evt) {
    if (!evt) return null;
    var y = yearOf(evt.date);
    if (!y) return evt.precision === "unknown" ? "?" : null;
    switch (evt.precision) {
      case "circa": return "c. " + y;
      case "before": return "bef. " + y;
      case "after": return "aft. " + y;
      default: return y;
    }
  }
  function precisionDate(evt) {
    if (!evt) return null;
    if (!evt.date) return evt.precision === "unknown" ? "Unknown" : null;
    var out = evt.date;
    var m = String(evt.date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      var months = ["January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"];
      out = parseInt(m[3], 10) + " " + months[parseInt(m[2], 10) - 1] + " " + m[1];
    }
    switch (evt.precision) {
      case "circa": return "c. " + out;
      case "before": return "before " + out;
      case "after": return "after " + out;
      default: return out;
    }
  }
  function fullName(p) {
    var n = p.name || {};
    return [n.first, n.middle, n.last].filter(Boolean).join(" ") || "Unknown";
  }
  function displayName(p) {
    var n = p.name || {};
    var out = [n.first];
    if (n.nickname) out.push("“" + n.nickname + "”");
    if (n.middle && !n.nickname) out.push(n.middle);
    out.push(n.last);
    return out.filter(Boolean).join(" ");
  }
  function lifespanText(p) {
    if (p.living) return "Living";
    var b = precisionYear(p.birth);
    var d = precisionYear(p.death);
    if (b && d) return b + "–" + d;
    if (b) return "b. " + b;
    if (d) return "d. " + d;
    return "Dates unknown";
  }
  function sourceCount(p) {
    var ids = {};
    (p.sourceIds || []).forEach(function (s) { ids[s] = 1; });
    if (p.birth && p.birth.sourceIds) p.birth.sourceIds.forEach(function (s) { ids[s] = 1; });
    if (p.death && p.death.sourceIds) p.death.sourceIds.forEach(function (s) { ids[s] = 1; });
    (p.spouses || []).forEach(function (sp) {
      if (sp.marriage && sp.marriage.sourceIds) sp.marriage.sourceIds.forEach(function (s) { ids[s] = 1; });
    });
    return Object.keys(ids).length;
  }
  function hasUncertainty(p) {
    return (p.uncertainties && p.uncertainties.length > 0) || p.uncertain === true;
  }
  function searchTerms(p) {
    var n = p.name || {};
    return [n.first, n.middle, n.last, n.maidenName, n.nickname]
      .filter(Boolean).join(" ").toLowerCase();
  }

  /* ===================================================================
     Tree rendering
     =================================================================== */
  var uid = 0;

  function collectTreeNodeIds(rootId) {
    var ids = {};
    (function walk(id) {
      var p = people[id];
      if (!p || ids[id]) return;
      ids[id] = true;
      (p.parents || []).forEach(walk);
    })(rootId);
    return ids;
  }

  function buildChildrenIndex() {
    var idx = {};
    Object.keys(people).forEach(function (id) {
      (people[id].parents || []).forEach(function (pid) {
        if (!idx[pid]) idx[pid] = [];
        idx[pid].push(id);
      });
    });
    return idx;
  }

  function getChildren(personId) {
    return (childrenIndex[personId] || []).filter(function (id) { return people[id]; });
  }

  function getSiblings(p) {
    var seen = {};
    var sibs = [];
    (p.parents || []).forEach(function (pid) {
      getChildren(pid).forEach(function (cid) {
        if (cid !== p.id && !seen[cid]) { seen[cid] = 1; sibs.push(cid); }
      });
    });
    return sibs;
  }

  function makeSpouseChip(spouseRef) {
    var sp = people[spouseRef.personId];
    if (!sp) return null;
    // Skip spouses who are themselves blood-ancestor tree nodes (co-parents):
    // they already appear as their own column, so a chip would be redundant.
    if (treeNodeIds[sp.id]) return null;

    var chip = el("button", "spouse-chip");
    chip.type = "button";
    chip.setAttribute("aria-label", "Spouse: " + fullName(sp) + ". Open details.");
    chip.appendChild(el("span", "chip-ring", "⚭"));
    chip.appendChild(el("span", "chip-name", displayName(sp)));
    chip.addEventListener("click", function (e) {
      e.stopPropagation();
      openModal(sp.id, chip);
    });
    searchIndex.push({ id: sp.id, terms: searchTerms(sp), type: "spouse", chip: chip });
    return chip;
  }

  function makePersonCard(p) {
    var card = el("button", "person-card");
    card.type = "button";
    card.setAttribute("data-person", p.id);
    if (p.living) card.classList.add("is-living");
    if (hasUncertainty(p)) card.classList.add("is-uncertain");
    if (p.uncertain === true) card.classList.add("is-placeholder");
    card.setAttribute("aria-label", fullName(p) + ", " + p.relation + ". Open details.");

    var inner = el("span", "card-inner");
    var nameRow = el("span", "card-name-row");
    nameRow.appendChild(el("span", "card-name", displayName(p)));
    if (p.uncertain === true) {
      var q = el("span", "card-qmark", "?");
      q.setAttribute("aria-hidden", "true");
      nameRow.appendChild(q);
    }
    inner.appendChild(nameRow);
    inner.appendChild(el("span", "card-relation", p.relation || ""));

    var metaRow = el("span", "card-meta");
    var life = el("span", "card-life");
    if (p.living) { life.classList.add("living-badge"); life.textContent = "Living"; }
    else { life.textContent = lifespanText(p); }
    metaRow.appendChild(life);
    var sc = sourceCount(p);
    if (sc > 0) metaRow.appendChild(el("span", "card-sources", "sources: " + sc));

    // Collateral children of this ancestor (children who are not on the direct
    // line, so they have no tree node): a subtle chip that jumps to the
    // person's modal Family section.
    var extraKids = getChildren(p.id).filter(function (cid) { return !treeNodeIds[cid]; });
    if (extraKids.length > 0) {
      var moreChip = el("span", "card-more-children",
        "+" + extraKids.length + " more " + (extraKids.length === 1 ? "child" : "children"));
      moreChip.addEventListener("click", function (e) {
        e.stopPropagation();
        openModal(p.id, card, { scrollToFamily: true });
      });
      metaRow.appendChild(moreChip);
    }
    inner.appendChild(metaRow);

    card.appendChild(inner);
    card.addEventListener("click", function () { openModal(p.id, card); });
    nodeCardById[p.id] = card;
    return card;
  }

  function buildNode(personId, ancestorToggles) {
    var p = people[personId];
    if (!p) return null;

    var node = el("div", "tree-node");
    var parents = (p.parents || []).filter(function (id) { return people[id]; });
    var toggleBtn = null;

    if (parents.length > 0) {
      var ancestorsId = "anc-" + (++uid);
      var collapser = el("div", "tree-ancestors-collapser");
      collapser.id = ancestorsId;
      var ancestorsRow = el("div", "tree-ancestors");

      toggleBtn = el("button", "branch-toggle");
      toggleBtn.type = "button";
      toggleBtn.setAttribute("aria-expanded", "true");
      toggleBtn.setAttribute("aria-controls", ancestorsId);
      toggleBtn.setAttribute("aria-label", "Collapse ancestors of " + fullName(p));
      toggleBtn.innerHTML = '<span class="chev" aria-hidden="true"></span>';

      var childToggles = ancestorToggles.concat([toggleBtn]);
      parents.forEach(function (pid) {
        var childNode = buildNode(pid, childToggles);
        if (childNode) ancestorsRow.appendChild(childNode);
      });
      collapser.appendChild(ancestorsRow);

      toggleBtn.addEventListener("click", function () {
        var expanded = toggleBtn.getAttribute("aria-expanded") === "true";
        setExpanded(toggleBtn, collapser, !expanded, p);
      });

      node.appendChild(collapser);
      node.appendChild(toggleBtn);
    } else {
      var endcap = el("div", "tree-endcap");
      endcap.innerHTML = '<span class="endcap-fleuron" aria-hidden="true">❧</span>' +
        '<span class="endcap-text">line continues beyond records…</span>';
      node.appendChild(endcap);
    }

    var cardWrap = el("div", "tree-card-wrap");
    var cardChips = el("div", "card-and-chips");
    cardChips.appendChild(makePersonCard(p));
    (p.spouses || []).forEach(function (sp) {
      var chip = makeSpouseChip(sp);
      if (chip) cardChips.appendChild(chip);
    });
    cardWrap.appendChild(cardChips);
    node.appendChild(cardWrap);

    searchIndex.push({
      id: p.id, terms: searchTerms(p), type: "node",
      card: nodeCardById[p.id], toggles: ancestorToggles.slice()
    });
    return node;
  }

  function setExpanded(toggleBtn, collapser, expand, p) {
    toggleBtn.setAttribute("aria-expanded", expand ? "true" : "false");
    toggleBtn.setAttribute("aria-label",
      (expand ? "Collapse" : "Expand") + " ancestors of " + fullName(p));
    collapser.classList.toggle("is-collapsed", !expand);
  }
  function expandToggle(toggleBtn) {
    if (toggleBtn && toggleBtn.getAttribute("aria-expanded") !== "true") toggleBtn.click();
  }

  /* ===================================================================
     Modal
     =================================================================== */
  var dialog = document.getElementById("person-dialog");
  var dialogBody = document.getElementById("dialog-body");
  var lastFocused = null;

  function sourceLink(id) {
    var s = sources[id];
    if (!s) return null;
    var li = el("li", "source-item");
    var a = el("a", "source-link", s.label || id);
    a.href = s.url || "#";
    a.target = "_blank";
    a.rel = "noopener";
    li.appendChild(a);
    if (s.detail) li.appendChild(el("span", "source-detail", s.detail));
    return li;
  }

  // A clickable family-member link inside the modal: navigates the open modal
  // to that person (content replaced; the original trigger keeps focus-return).
  function familyLink(personId) {
    var fp = people[personId];
    if (!fp) return null;
    var btn = el("button", "family-link");
    btn.type = "button";
    btn.setAttribute("aria-label", "View details for " + fullName(fp));
    btn.appendChild(el("span", "family-link-name", displayName(fp)));
    btn.appendChild(el("span", "family-link-meta",
      fp.living ? "Living" : lifespanText(fp)));
    btn.addEventListener("click", function () {
      openModal(fp.id); // dialog already open: lastFocused is preserved
    });
    return btn;
  }

  function familyGroup(label, ids) {
    if (!ids || !ids.length) return null;
    var group = el("div", "family-group");
    group.appendChild(el("h4", "family-group-label", label));
    var row = el("div", "family-group-links");
    ids.forEach(function (id) {
      var link = familyLink(id);
      if (link) row.appendChild(link);
    });
    if (!row.children.length) return null;
    group.appendChild(row);
    return group;
  }

  function buildFamilySection(p) {
    var section = el("section", "modal-family");
    section.appendChild(el("h3", "modal-subhead", "Family"));
    var groups = [
      familyGroup("Parents", (p.parents || []).filter(function (id) { return people[id]; })),
      familyGroup(p.spouses && p.spouses.length > 1 ? "Spouses" : "Spouse",
        (p.spouses || []).map(function (sp) { return sp.personId; }).filter(function (id) { return people[id]; })),
      familyGroup("Children", getChildren(p.id)),
      familyGroup("Siblings", getSiblings(p))
    ].filter(Boolean);
    if (!groups.length) return null;
    groups.forEach(function (g) { section.appendChild(g); });
    return section;
  }

  function buildModal(p) {
    dialogBody.innerHTML = "";
    var header = el("header", "modal-header");
    header.appendChild(el("h2", "modal-name", fullName(p)));
    if (p.name && p.name.nickname) header.appendChild(el("p", "modal-nickname", "known as “" + p.name.nickname + "”"));
    if (p.name && p.name.maidenName) header.appendChild(el("p", "modal-maiden", "née " + p.name.maidenName));
    header.appendChild(el("p", "modal-relation", p.relation || ""));
    dialogBody.appendChild(header);

    if (p.living) {
      var badge = el("p", "modal-living");
      badge.appendChild(el("span", "living-badge", "Living"));
      badge.appendChild(el("span", "modal-living-note",
        "Details for living relatives are withheld for privacy."));
      dialogBody.appendChild(badge);
      return;
    }

    var dl = el("dl", "modal-facts");
    function addFact(term, value) {
      if (!value) return;
      dl.appendChild(el("dt", "fact-term", term));
      dl.appendChild(el("dd", "fact-value", value));
    }
    var birth = precisionDate(p.birth);
    if (birth) addFact("Born", birth + (p.birth && p.birth.place ? " · " + p.birth.place : ""));
    else if (p.birth && p.birth.place) addFact("Born", p.birth.place);
    var death = precisionDate(p.death);
    if (death) addFact("Died", death + (p.death && p.death.place ? " · " + p.death.place : ""));
    else if (p.death && p.death.place) addFact("Died", p.death.place);
    addFact("Occupation", p.occupation);

    if (p.spouses && p.spouses.length) {
      var spouseNames = p.spouses.map(function (sp) {
        var s = people[sp.personId];
        var label = s ? fullName(s) : "(unknown)";
        if (sp.marriage) {
          var my = precisionDate(sp.marriage);
          if (my) label += " (m. " + my + (sp.marriage.place ? ", " + sp.marriage.place : "") + ")";
        }
        return label;
      }).join("; ");
      addFact(p.spouses.length > 1 ? "Marriages" : "Marriage", spouseNames);
    }
    if (dl.children.length) dialogBody.appendChild(dl);

    if (p.story) {
      var story = el("section", "modal-story");
      story.appendChild(el("h3", "modal-subhead", "Story"));
      story.appendChild(el("p", "modal-story-text", p.story));
      dialogBody.appendChild(story);
    }
    if (p.uncertainties && p.uncertainties.length) {
      var unc = el("section", "modal-uncertain");
      unc.appendChild(el("h3", "modal-subhead", "Uncertainties"));
      var ul = el("ul", "uncertain-list");
      p.uncertainties.forEach(function (u) { ul.appendChild(el("li", null, u)); });
      unc.appendChild(ul);
      dialogBody.appendChild(unc);
    }

    var family = buildFamilySection(p);
    if (family) dialogBody.appendChild(family);

    var srcIds = [], seen = {};
    function pushSrc(arr) { (arr || []).forEach(function (id) { if (!seen[id]) { seen[id] = 1; srcIds.push(id); } }); }
    pushSrc(p.sourceIds);
    if (p.birth) pushSrc(p.birth.sourceIds);
    if (p.death) pushSrc(p.death.sourceIds);
    (p.spouses || []).forEach(function (sp) { if (sp.marriage) pushSrc(sp.marriage.sourceIds); });

    if (srcIds.length) {
      var srcSection = el("section", "modal-sources");
      srcSection.appendChild(el("h3", "modal-subhead", "Sources"));
      var list = el("ul", "source-list");
      srcIds.forEach(function (id) { var li = sourceLink(id); if (li) list.appendChild(li); });
      srcSection.appendChild(list);
      dialogBody.appendChild(srcSection);
    }
  }

  function openModal(personId, triggerEl, opts) {
    var p = people[personId];
    if (!p) return;
    // Modal-to-modal navigation (dialog already open) keeps the ORIGINAL
    // trigger so focus returns to the tree/search after the whole excursion.
    if (!dialog.open) {
      lastFocused = triggerEl || document.activeElement;
    }
    buildModal(p);
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    var closeBtn = dialog.querySelector(".modal-close");
    if (closeBtn) closeBtn.focus();
    if (opts && opts.scrollToFamily) {
      var fam = dialogBody.querySelector(".modal-family");
      if (fam) {
        window.requestAnimationFrame(function () {
          fam.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
        });
      }
    } else {
      dialogBody.scrollTop = 0;
    }
  }
  function closeModal() { if (dialog.open) dialog.close(); }

  if (dialog) {
    var mClose = dialog.querySelector(".modal-close");
    if (mClose) mClose.addEventListener("click", closeModal);
    dialog.addEventListener("click", function (e) { if (e.target === dialog) closeModal(); });
    dialog.addEventListener("close", function () {
      if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
    });
  }

  /* ===================================================================
     Reveal / pulse
     =================================================================== */
  function pulse(node) {
    if (!node) return;
    node.classList.remove("pulse-gold");
    void node.offsetWidth;
    node.classList.add("pulse-gold");
    window.setTimeout(function () { node.classList.remove("pulse-gold"); }, 2400);
  }
  function revealEntry(entry) {
    // Collateral relatives (no tree node, no chip): open their modal directly.
    if (entry.type === "modal") {
      openModal(entry.id, searchInput);
      return;
    }
    if (entry.toggles) entry.toggles.forEach(expandToggle);
    var target;
    if (entry.type === "spouse") {
      target = entry.chip;
      var wrap = entry.chip.closest(".card-and-chips");
      var hostCard = wrap ? wrap.querySelector(".person-card") : null;
      if (hostCard) {
        var hostId = hostCard.getAttribute("data-person");
        var hostEntry = searchIndex.find(function (e) { return e.type === "node" && e.id === hostId; });
        if (hostEntry && hostEntry.toggles) hostEntry.toggles.forEach(expandToggle);
      }
    } else {
      target = entry.card;
    }
    if (!target) return;
    window.requestAnimationFrame(function () {
      window.setTimeout(function () {
        target.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center", inline: "center" });
        pulse(target);
      }, 60);
    });
  }

  /* ===================================================================
     Search (wired only after unlock, inside init)
     =================================================================== */
  var searchInput = document.getElementById("search-input");
  var searchResults = document.getElementById("search-results");
  var activeIndex = -1;
  var currentResults = [];

  function clearResults() {
    searchResults.innerHTML = "";
    searchResults.hidden = true;
    activeIndex = -1;
    currentResults = [];
    searchInput.setAttribute("aria-expanded", "false");
    searchInput.removeAttribute("aria-activedescendant");
  }
  function runSearch(q) {
    q = q.trim().toLowerCase();
    if (!q) { clearResults(); return; }
    var seen = {}, matches = [];
    searchIndex.forEach(function (entry) {
      if (seen[entry.id]) return;
      if (entry.terms.indexOf(q) !== -1) { seen[entry.id] = 1; matches.push(entry); }
    });
    renderResults(matches);
  }
  function renderResults(matches) {
    searchResults.innerHTML = "";
    currentResults = matches;
    activeIndex = -1;
    if (!matches.length) {
      var none = el("li", "search-empty", "No matches");
      none.setAttribute("role", "presentation");
      searchResults.appendChild(none);
      searchResults.hidden = false;
      searchInput.setAttribute("aria-expanded", "true");
      return;
    }
    matches.forEach(function (entry, i) {
      var p = people[entry.id];
      var li = el("li", "search-option");
      li.id = "search-opt-" + i;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
      li.appendChild(el("span", "opt-name", displayName(p)));
      li.appendChild(el("span", "opt-meta", (p.relation || "") + " · " + lifespanText(p)));
      li.addEventListener("mousedown", function (e) { e.preventDefault(); selectResult(i); });
      searchResults.appendChild(li);
    });
    searchResults.hidden = false;
    searchInput.setAttribute("aria-expanded", "true");
  }
  function setActive(i) {
    var opts = searchResults.querySelectorAll(".search-option");
    opts.forEach(function (o) { o.classList.remove("active"); o.setAttribute("aria-selected", "false"); });
    if (i >= 0 && i < opts.length) {
      opts[i].classList.add("active");
      opts[i].setAttribute("aria-selected", "true");
      searchInput.setAttribute("aria-activedescendant", opts[i].id);
      opts[i].scrollIntoView({ block: "nearest" });
    }
    activeIndex = i;
  }
  function selectResult(i) {
    var entry = currentResults[i];
    if (!entry) return;
    clearResults();
    searchInput.value = "";
    revealEntry(entry);
  }
  var searchWired = false;
  function wireSearch() {
    if (searchWired || !searchInput) return;
    searchWired = true;
    var debounceTimer = null;
    searchInput.addEventListener("input", function () {
      window.clearTimeout(debounceTimer);
      var v = searchInput.value;
      debounceTimer = window.setTimeout(function () { runSearch(v); }, 180);
    });
    searchInput.addEventListener("keydown", function (e) {
      if (searchResults.hidden) { if (e.key === "ArrowDown") runSearch(searchInput.value); return; }
      var count = currentResults.length;
      if (e.key === "ArrowDown") { e.preventDefault(); if (count) setActive((activeIndex + 1) % count); }
      else if (e.key === "ArrowUp") { e.preventDefault(); if (count) setActive((activeIndex - 1 + count) % count); }
      else if (e.key === "Enter") {
        if (activeIndex >= 0) { e.preventDefault(); selectResult(activeIndex); }
        else if (count === 1) { e.preventDefault(); selectResult(0); }
      } else if (e.key === "Escape") { clearResults(); }
    });
    searchInput.addEventListener("blur", function () { window.setTimeout(clearResults, 120); });
  }

  /* ===================================================================
     Theme (available immediately, before unlock)
     =================================================================== */
  var root = document.documentElement;
  var themeToggle = document.getElementById("theme-toggle");
  function applyTheme(mode) {
    root.classList.toggle("dark", mode === "dark");
    if (themeToggle) {
      themeToggle.setAttribute("aria-pressed", mode === "dark" ? "true" : "false");
      themeToggle.setAttribute("aria-label", mode === "dark" ? "Switch to light theme" : "Switch to dark theme");
    }
  }
  function initTheme() {
    var stored = null;
    try { stored = window.localStorage.getItem("dengler-theme"); } catch (e) {}
    var mode = (stored === "dark" || stored === "light") ? stored
      : ((window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light");
    applyTheme(mode);
  }
  if (themeToggle) {
    themeToggle.addEventListener("click", function () {
      var next = root.classList.contains("dark") ? "light" : "dark";
      applyTheme(next);
      try { window.localStorage.setItem("dengler-theme", next); } catch (e) {}
    });
  }
  initTheme();

  /* ===================================================================
     Crypto (Web Crypto API, no libraries)
     =================================================================== */
  var KEY_STORE = "dengler-key";
  var enc = window.FAMILY_DATA_ENC || null;

  function b64ToBytes(b64) {
    var bin = window.atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function bytesToB64(bytes) {
    var bin = "";
    var arr = new Uint8Array(bytes);
    for (var i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return window.btoa(bin);
  }

  // Derive an extractable AES-GCM key from a passphrase via PBKDF2.
  function deriveKeyFromPass(passphrase) {
    var salt = b64ToBytes(enc.salt);
    return window.crypto.subtle.importKey(
      "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]
    ).then(function (baseKey) {
      return window.crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: salt, iterations: enc.iter, hash: "SHA-256" },
        baseKey, { name: "AES-GCM", length: 256 }, true, ["decrypt"]
      );
    });
  }
  function importRawKey(rawBytes) {
    return window.crypto.subtle.importKey(
      "raw", rawBytes, { name: "AES-GCM", length: 256 }, true, ["decrypt"]
    );
  }
  // Decrypt the payload with a CryptoKey. Rejects (DOMException) on wrong key.
  function decryptWithKey(key) {
    var iv = b64ToBytes(enc.iv);
    var ct = b64ToBytes(enc.ct);
    return window.crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, ct)
      .then(function (buf) { return JSON.parse(new TextDecoder().decode(buf)); });
  }

  /* ===================================================================
     Unlock gate
     =================================================================== */
  var PASSCODE_LENGTH = 8;   // number of digits (drives the dot count)

  var gate = document.getElementById("gate");
  var gateRemember = document.getElementById("gate-remember");
  var gateError = document.getElementById("gate-error");
  var gateCard = document.getElementById("gate-card");
  var gateDots = document.getElementById("passcode-dots");
  var keypad = document.getElementById("passcode-keypad");
  var pageFrame = document.querySelector(".page-frame");
  var lockBtn = document.getElementById("lock-btn");

  var entry = "";          // digits entered so far (never rendered as text)
  var passcodeBusy = false; // true while decrypt is in flight

  // Build the dot row from PASSCODE_LENGTH.
  function buildDots() {
    if (!gateDots) return;
    gateDots.innerHTML = "";
    for (var i = 0; i < PASSCODE_LENGTH; i++) {
      gateDots.appendChild(el("span", "passcode-dot"));
    }
  }
  function renderDots() {
    if (!gateDots) return;
    var dots = gateDots.querySelectorAll(".passcode-dot");
    for (var i = 0; i < dots.length; i++) {
      dots[i].classList.toggle("filled", i < entry.length);
    }
    gateDots.setAttribute("aria-label",
      "Passcode, " + entry.length + " of " + PASSCODE_LENGTH + " digits entered");
  }
  function resetEntry() {
    entry = "";
    renderDots();
  }

  function showError(msg) {
    gateError.textContent = msg || "Wrong passcode";
    gateError.hidden = false;
    if (!prefersReducedMotion() && gateDots) {
      gateDots.classList.remove("shake");
      void gateDots.offsetWidth;
      gateDots.classList.add("shake");
    }
  }

  function focusKeypad() {
    if (!keypad) return;
    var first = keypad.querySelector(".key[data-digit]");
    if (first) { try { first.focus(); } catch (e) {} }
  }

  function storeKey(rawB64, remember) {
    try {
      window.sessionStorage.setItem(KEY_STORE, rawB64);
      if (remember) window.localStorage.setItem(KEY_STORE, rawB64);
      else window.localStorage.removeItem(KEY_STORE);
    } catch (e) {}
  }
  function readStoredKey() {
    try {
      return window.localStorage.getItem(KEY_STORE) || window.sessionStorage.getItem(KEY_STORE);
    } catch (e) { return null; }
  }
  function clearStoredKey() {
    try {
      window.sessionStorage.removeItem(KEY_STORE);
      window.localStorage.removeItem(KEY_STORE);
    } catch (e) {}
  }

  var gateHideTimer = null;
  function revealApp(focusSearch) {
    gate.classList.add("gate-dismissed");
    window.clearTimeout(gateHideTimer);
    gateHideTimer = window.setTimeout(function () { gate.hidden = true; }, prefersReducedMotion() ? 0 : 520);
    pageFrame.hidden = false;
    if (focusSearch && searchInput) {
      window.setTimeout(function () { searchInput.focus(); }, 200);
    }
  }

  function unlockWithData(data, opts) {
    init(data);
    revealApp(opts && opts.focusSearch);
  }

  // Show the (empty) passcode gate and put focus on the keypad.
  function showGate() {
    window.clearTimeout(gateHideTimer);  // cancel any pending reveal-hide
    resetEntry();
    gateError.hidden = true;
    gate.hidden = false;
    gate.classList.remove("gate-dismissed");
    window.requestAnimationFrame(focusKeypad);
  }

  // Attempt auto-unlock from a cached raw key (session or "remembered" device).
  function tryCachedUnlock() {
    var raw = readStoredKey();
    if (!raw || !enc) { showGate(); return; }
    importRawKey(b64ToBytes(raw))
      .then(decryptWithKey)
      .then(function (data) { unlockWithData(data, { focusSearch: false }); })
      .catch(function () {
        clearStoredKey();
        showGate();
      });
  }

  // Try the entered passcode: derive key, decrypt. On success cache + unlock;
  // on the wrong code, shake the dot row, announce, and clear the dots.
  function submitPasscode() {
    if (passcodeBusy || !enc) return;
    passcodeBusy = true;
    gateError.hidden = true;
    var derivedKey;
    var code = entry;
    deriveKeyFromPass(code)
      .then(function (key) { derivedKey = key; return decryptWithKey(key); })
      .then(function (data) {
        return window.crypto.subtle.exportKey("raw", derivedKey).then(function (raw) {
          storeKey(bytesToB64(raw), gateRemember && gateRemember.checked);
          resetEntry();
          unlockWithData(data, { focusSearch: true });
        });
      })
      .catch(function () {
        // AES-GCM authentication failure => wrong passcode (DOMException).
        showError("Wrong passcode");
        window.setTimeout(function () {
          resetEntry();
          focusKeypad();
        }, prefersReducedMotion() ? 0 : 450);
      })
      .then(function () { passcodeBusy = false; });
  }

  function addDigit(d) {
    if (passcodeBusy || entry.length >= PASSCODE_LENGTH) return;
    gateError.hidden = true;
    entry += d;
    renderDots();
    if (entry.length === PASSCODE_LENGTH) {
      // Let the final dot paint before deriving (which can block briefly).
      window.setTimeout(submitPasscode, prefersReducedMotion() ? 0 : 90);
    }
  }
  function deleteDigit() {
    if (passcodeBusy || !entry.length) return;
    gateError.hidden = true;
    entry = entry.slice(0, -1);
    renderDots();
  }

  buildDots();
  renderDots();

  if (keypad) {
    keypad.addEventListener("click", function (e) {
      var btn = e.target.closest("button.key");
      if (!btn) return;
      if (btn.dataset.action === "delete") deleteDigit();
      else if (btn.dataset.digit != null) addDigit(btn.dataset.digit);
    });
  }

  // Physical keyboard support while the gate is up (digits / Backspace).
  document.addEventListener("keydown", function (e) {
    if (gate.hidden || initialized) return;
    if (e.key >= "0" && e.key <= "9") { addDigit(e.key); }
    else if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); deleteDigit(); }
  });

  if (lockBtn) {
    lockBtn.addEventListener("click", function () {
      clearStoredKey();
      // Purge every trace of the decrypted data from the DOM.
      var treeRoot = document.getElementById("tree-root");
      if (treeRoot) treeRoot.innerHTML = "";
      if (dialogBody) dialogBody.innerHTML = "";
      if (dialog && dialog.open) dialog.close();
      DATA = null; people = {}; sources = {};
      searchIndex = []; nodeCardById = {}; treeNodeIds = {}; childrenIndex = {};
      initialized = false;
      if (searchInput) searchInput.value = "";
      clearResults();
      pageFrame.hidden = true;
      showGate();
    });
  }

  /* ===================================================================
     init(data) — the single entry point once decrypted
     =================================================================== */
  function init(data) {
    DATA = data;
    people = data.people || {};
    sources = data.sources || {};
    searchIndex = [];
    nodeCardById = {};
    uid = 0;
    treeNodeIds = collectTreeNodeIds(data.root);
    childrenIndex = buildChildrenIndex();

    var titleEl = document.getElementById("tree-title");
    var subtitleEl = document.getElementById("tree-subtitle");
    if (titleEl && data.meta && data.meta.title) titleEl.textContent = data.meta.title;
    if (subtitleEl && data.meta && data.meta.subtitle) subtitleEl.textContent = data.meta.subtitle;
    var discEl = document.getElementById("footer-disclaimer");
    if (discEl && data.meta && data.meta.disclaimer) discEl.textContent = data.meta.disclaimer;

    var treeRoot = document.getElementById("tree-root");
    if (treeRoot) {
      treeRoot.innerHTML = "";
      var rootNode = buildNode(data.root, []);
      if (rootNode) { rootNode.classList.add("is-root"); treeRoot.appendChild(rootNode); }

      // Index EVERYONE else (collateral relatives — uncles, aunts, cousins —
      // who have no tree node or chip) so search can still find them; selecting
      // one opens their modal directly.
      var indexed = {};
      searchIndex.forEach(function (e) { indexed[e.id] = 1; });
      Object.keys(people).forEach(function (id) {
        if (!indexed[id]) {
          searchIndex.push({ id: id, terms: searchTerms(people[id]), type: "modal" });
        }
      });

      if (!prefersReducedMotion()) {
        var nodes = treeRoot.querySelectorAll(".tree-node");
        nodes.forEach(function (c, i) {
          c.style.setProperty("--enter-delay", (Math.min(i, 16) * 45) + "ms");
          c.classList.add("enter");
        });
        window.requestAnimationFrame(function () {
          window.requestAnimationFrame(function () {
            nodes.forEach(function (c) { c.classList.add("entered"); });
          });
        });
      }
      // Center the horizontal scroll on the root person (the tree can be wider
      // than the viewport; scroll is contained within .tree-viewport).
      window.requestAnimationFrame(function () {
        var vp = document.querySelector(".tree-viewport");
        var rootCard = nodeCardById[data.root];
        if (vp && rootCard) {
          var vpRect = vp.getBoundingClientRect();
          var cRect = rootCard.getBoundingClientRect();
          vp.scrollLeft += (cRect.left + cRect.width / 2) - (vpRect.left + vpRect.width / 2);
        }
      });
    }
    wireSearch();
    initialized = true;
  }

  /* ===================================================================
     Boot
     =================================================================== */
  function boot() {
    if (!enc) {
      // No encrypted payload — surface a clear message rather than a blank gate.
      if (gate) gate.hidden = false;
      showError("The archive payload (js/data.enc.js) is missing.");
      return;
    }
    tryCachedUnlock();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
