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
    // Date-based lifespan for everyone. Living people (no death) read "b. YYYY";
    // the "Living" badge is shown alongside, not in place of, this text.
    var b = precisionYear(p.birth);
    var d = precisionYear(p.death);
    if (b && d) return b + "–" + d;
    if (b) return "b. " + b;
    if (d) return "d. " + d;
    return p.living ? "Living" : "Dates unknown";
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
    metaRow.appendChild(el("span", "card-life", lifespanText(p)));
    if (p.living) metaRow.appendChild(el("span", "living-badge", "Living"));
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

  /* -------------------------------------------------------------------
     Spatial layout: tidy ancestor chart on a 2D canvas.
     y = generation (root at the bottom); x by recursive leaf-packing so
     nothing overlaps and a couple sits centered over their shared child.
     ------------------------------------------------------------------- */
  var CARD_W = 200;      // fixed card width on the map (px, canvas space)
  var ROW_STEP = 215;    // vertical distance between generation centers
  var X_STEP = 250;      // horizontal spacing between packed leaves
  var ENDCAP_H = 40;     // reserved space above a line's end

  var mapViewport = document.getElementById("map-viewport");
  var mapCanvas = document.getElementById("map-canvas");
  var mapLines = document.getElementById("map-lines");
  var mapNodes = {};                 // id -> { id, gen, parents, x, y, h, sx, sy, card }
  var mapBounds = { w: 0, h: 0 };
  var rootCanvasPoint = { x: 0, y: 0 };

  function svgEl(tag, attrs) {
    var e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function clearMap() {
    if (!mapCanvas) return;
    Array.prototype.slice.call(mapCanvas.querySelectorAll(".person-card, .map-endcap"))
      .forEach(function (n) { n.remove(); });
    if (mapLines) mapLines.innerHTML = "";
    mapNodes = {};
  }

  function buildMap(rootId) {
    clearMap();
    var maxGen = 0;

    // 1. Collect the direct-ancestor set with generation numbers.
    (function collect(id, gen) {
      var p = people[id];
      if (!p || mapNodes[id]) return;
      if (gen > maxGen) maxGen = gen;
      var parents = (p.parents || []).filter(function (pid) { return people[pid]; });
      mapNodes[id] = { id: id, gen: gen, parents: parents, x: 0, y: 0, h: 0, card: null };
      parents.forEach(function (pid) { collect(pid, gen + 1); });
    })(rootId, 0);

    // 2. Assign x by leaf-packing (post-order over parents), y by generation.
    var leaf = 0;
    (function assignX(id) {
      var n = mapNodes[id];
      if (!n.parents.length) { n.x = leaf * X_STEP; leaf++; }
      else {
        var sum = 0;
        n.parents.forEach(function (pid) { assignX(pid); sum += mapNodes[pid].x; });
        n.x = sum / n.parents.length;
      }
      n.y = (maxGen - n.gen) * ROW_STEP;   // root (gen 0) sits at the bottom
    })(rootId);

    // 3. Create cards and measure their heights (needs a laid-out page-frame).
    Object.keys(mapNodes).forEach(function (id) {
      var n = mapNodes[id];
      var card = makePersonCard(people[id]);
      card.classList.add("map-card");
      card.style.width = CARD_W + "px";
      card.style.left = "-9999px";
      card.style.top = "0px";
      mapCanvas.appendChild(card);
      n.card = card;
      n.h = card.offsetHeight || 120;
      searchIndex.push({ id: id, terms: searchTerms(people[id]), type: "node", card: card });
    });

    // 4. Compute bounds (including card size + endcap space) and a shift so all
    //    coordinates are positive with padding.
    var minL = Infinity, maxR = -Infinity, minT = Infinity, maxB = -Infinity;
    Object.keys(mapNodes).forEach(function (id) {
      var n = mapNodes[id];
      minL = Math.min(minL, n.x - CARD_W / 2);
      maxR = Math.max(maxR, n.x + CARD_W / 2);
      minT = Math.min(minT, n.y - n.h / 2 - (n.parents.length ? 0 : ENDCAP_H));
      maxB = Math.max(maxB, n.y + n.h / 2);
    });
    var PAD = 150;
    var ox = -minL + PAD, oy = -minT + PAD;
    mapBounds.w = (maxR - minL) + PAD * 2;
    mapBounds.h = (maxB - minT) + PAD * 2;

    // 5. Position cards + endcaps in shifted canvas coordinates.
    Object.keys(mapNodes).forEach(function (id) {
      var n = mapNodes[id];
      n.sx = n.x + ox; n.sy = n.y + oy;
      n.card.style.left = (n.sx - CARD_W / 2) + "px";
      n.card.style.top = (n.sy - n.h / 2) + "px";
      if (!n.parents.length) {
        var cap = el("div", "map-endcap");
        cap.innerHTML = '<span class="endcap-fleuron" aria-hidden="true">❧</span>' +
          '<span class="endcap-text">line continues beyond records…</span>';
        cap.style.left = (n.sx - CARD_W / 2) + "px";
        cap.style.top = (n.sy - n.h / 2 - ENDCAP_H) + "px";
        cap.style.width = CARD_W + "px";
        mapCanvas.appendChild(cap);
      }
    });

    // 6. Connector geometry: parent stubs + couple bus + drop to the child.
    var conn = "", spouse = "";
    Object.keys(mapNodes).forEach(function (id) {
      var c = mapNodes[id];
      if (!c.parents.length) return;
      var childTop = c.sy - c.h / 2;
      var parentGenY = mapNodes[c.parents[0]].sy;
      var busY = (parentGenY + c.sy) / 2;
      var xs = [];
      c.parents.forEach(function (pid) {
        var pn = mapNodes[pid];
        xs.push(pn.sx);
        conn += "M" + pn.sx + " " + (pn.sy + pn.h / 2) + "L" + pn.sx + " " + busY;
      });
      if (xs.length > 1) {
        spouse += "M" + Math.min.apply(null, xs) + " " + busY + "L" + Math.max.apply(null, xs) + " " + busY;
      }
      conn += "M" + c.sx + " " + busY + "L" + c.sx + " " + childTop;
    });

    mapLines.setAttribute("width", mapBounds.w);
    mapLines.setAttribute("height", mapBounds.h);
    mapLines.setAttribute("viewBox", "0 0 " + mapBounds.w + " " + mapBounds.h);
    mapLines.appendChild(svgEl("path", { d: conn, "class": "conn" }));
    if (spouse) mapLines.appendChild(svgEl("path", { d: spouse, "class": "spouse" }));

    mapCanvas.style.width = mapBounds.w + "px";
    mapCanvas.style.height = mapBounds.h + "px";

    var rn = mapNodes[rootId];
    if (rn) rootCanvasPoint = { x: rn.sx, y: rn.sy };
  }

  /* -------------------------------------------------------------------
     Pan / zoom engine — transform-only, Pointer Events, wheel + pinch.
     ------------------------------------------------------------------- */
  // Min scale is low enough that the full ~8-generation chart (canvas ≈ 5500px
  // wide) fits within a 390/360px phone with margin; 0.12 would only fit desktop.
  var MIN_SCALE = 0.035, MAX_SCALE = 2.5;
  var view = { tx: 0, ty: 0, scale: 1 };
  var pointers = new Map();
  var panLast = null, pinch = null, gestureMoved = 0, suppressClick = false, lastTap = null;

  function clampNum(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function vw() { return mapViewport ? mapViewport.clientWidth : 0; }
  function vh() { return mapViewport ? mapViewport.clientHeight : 0; }

  function clampView() {
    var s = view.scale;
    view.tx = clampNum(view.tx, vw() * 0.5 - mapBounds.w * s, vw() * 0.5);
    view.ty = clampNum(view.ty, vh() * 0.5 - mapBounds.h * s, vh() * 0.5);
  }
  function applyView(animate) {
    if (!mapCanvas) return;
    if (animate && !prefersReducedMotion()) {
      mapCanvas.style.transition = "transform 0.5s var(--ease)";
      window.clearTimeout(applyView._t);
      applyView._t = window.setTimeout(function () { mapCanvas.style.transition = ""; }, 540);
    } else {
      mapCanvas.style.transition = "";
    }
    mapCanvas.style.transform = "translate(" + view.tx + "px," + view.ty + "px) scale(" + view.scale + ")";
  }
  function zoomAbout(clientX, clientY, newScale) {
    var r = mapViewport.getBoundingClientRect();
    newScale = clampNum(newScale, MIN_SCALE, MAX_SCALE);
    var cx = (clientX - r.left - view.tx) / view.scale;
    var cy = (clientY - r.top - view.ty) / view.scale;
    view.scale = newScale;
    view.tx = (clientX - r.left) - cx * newScale;
    view.ty = (clientY - r.top) - cy * newScale;
    clampView(); applyView();
  }
  function zoomByFactor(f) {
    var r = mapViewport.getBoundingClientRect();
    zoomAbout(r.left + vw() / 2, r.top + vh() / 2, view.scale * f);
  }
  function centerOnCanvas(cx, cy, scale, anchorY, animate) {
    view.scale = clampNum(scale, MIN_SCALE, MAX_SCALE);
    view.tx = vw() / 2 - cx * view.scale;
    view.ty = vh() * (anchorY == null ? 0.5 : anchorY) - cy * view.scale;
    clampView(); applyView(animate);
  }
  function centerOnNode(id, animate) {
    var n = mapNodes[id];
    if (!n) return;
    centerOnCanvas(n.sx, n.sy, clampNum(Math.max(view.scale, 1), MIN_SCALE, MAX_SCALE), 0.5, animate);
  }
  // Scale that fits the ENTIRE layout (bounds already include padding) within
  // the viewport with a small margin, clamped to the allowed zoom range.
  function fitScale() {
    var margin = 70;
    return clampNum(
      Math.min((vw() - margin * 2) / mapBounds.w, (vh() - margin * 2) / mapBounds.h),
      MIN_SCALE, MAX_SCALE);
  }
  function recenter(animate) {
    // Fit the whole tree and center it in the viewport.
    centerOnCanvas(mapBounds.w / 2, mapBounds.h / 2, fitScale(), 0.5, animate);
  }
  function initialView() {
    // On load, show the whole chart (comfortable near-fit) centered.
    centerOnCanvas(mapBounds.w / 2, mapBounds.h / 2, clampNum(fitScale(), MIN_SCALE, 0.9), 0.5, false);
  }

  function midpoint(pts) { return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }; }
  function screenToCanvas(clientX, clientY) {
    var r = mapViewport.getBoundingClientRect();
    return { x: (clientX - r.left - view.tx) / view.scale, y: (clientY - r.top - view.ty) / view.scale };
  }

  function wireMapGestures() {
    if (!mapViewport || wireMapGestures._done) return;
    wireMapGestures._done = true;

    mapViewport.addEventListener("pointerdown", function (e) {
      suppressClick = false;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      gestureMoved = 0;
      if (pointers.size === 1) { panLast = { x: e.clientX, y: e.clientY }; pinch = null; }
      else if (pointers.size === 2) {
        var pts = Array.from(pointers.values());
        pinch = {
          startDist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
          startScale: view.scale,
          anchor: screenToCanvas(midpoint(pts).x, midpoint(pts).y)
        };
        panLast = null;
      }
    });

    mapViewport.addEventListener("pointermove", function (e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size >= 2 && pinch) {
        var pts = Array.from(pointers.values());
        var dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        var mid = midpoint(pts);
        var r = mapViewport.getBoundingClientRect();
        view.scale = clampNum(pinch.startScale * (dist / pinch.startDist), MIN_SCALE, MAX_SCALE);
        view.tx = (mid.x - r.left) - pinch.anchor.x * view.scale;
        view.ty = (mid.y - r.top) - pinch.anchor.y * view.scale;
        gestureMoved += 12;
        clampView(); applyView();
      } else if (panLast) {
        var dx = e.clientX - panLast.x, dy = e.clientY - panLast.y;
        gestureMoved += Math.abs(dx) + Math.abs(dy);
        // Capture only once a real drag begins, so a tap still clicks the card.
        if (gestureMoved > 8) { try { mapViewport.setPointerCapture(e.pointerId); } catch (_) {} }
        view.tx += dx; view.ty += dy;
        panLast = { x: e.clientX, y: e.clientY };
        clampView(); applyView();
      }
    });

    function endPointer(e) {
      if (gestureMoved > 8) suppressClick = true;
      var wasTouch = e.pointerType && e.pointerType !== "mouse";
      pointers.delete(e.pointerId);
      try { mapViewport.releasePointerCapture(e.pointerId); } catch (_) {}
      if (pointers.size === 1) {
        var p = Array.from(pointers.values())[0];
        panLast = { x: p.x, y: p.y }; pinch = null;
      } else if (pointers.size === 0) {
        panLast = null; pinch = null;
        // double-tap to zoom (touch only; mouse uses dblclick)
        if (wasTouch && gestureMoved <= 8) {
          var now = Date.now();
          if (lastTap && now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
            zoomAbout(e.clientX, e.clientY, view.scale * 1.6); lastTap = null;
          } else { lastTap = { t: now, x: e.clientX, y: e.clientY }; }
        }
      }
    }
    mapViewport.addEventListener("pointerup", endPointer);
    mapViewport.addEventListener("pointercancel", endPointer);

    // Swallow the click that ends a drag so it doesn't open a modal.
    mapViewport.addEventListener("click", function (e) {
      if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; }
    }, true);

    mapViewport.addEventListener("wheel", function (e) {
      e.preventDefault();
      zoomAbout(e.clientX, e.clientY, view.scale * Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });

    mapViewport.addEventListener("dblclick", function (e) {
      if (e.target.closest(".person-card")) return; // let card open its modal
      zoomAbout(e.clientX, e.clientY, view.scale * 1.6);
    });

    mapViewport.addEventListener("keydown", function (e) {
      var step = 70;
      switch (e.key) {
        case "ArrowLeft": view.tx += step; break;
        case "ArrowRight": view.tx -= step; break;
        case "ArrowUp": view.ty += step; break;
        case "ArrowDown": view.ty -= step; break;
        case "+": case "=": zoomByFactor(1.2); e.preventDefault(); return;
        case "-": case "_": zoomByFactor(1 / 1.2); e.preventDefault(); return;
        default: return;
      }
      clampView(); applyView(); e.preventDefault();
    });

    var mc = mapViewport.querySelector(".map-controls");
    if (mc) mc.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    var zi = document.getElementById("zoom-in");
    var zo = document.getElementById("zoom-out");
    var rc = document.getElementById("recenter");
    if (zi) zi.addEventListener("click", function () { zoomByFactor(1.25); });
    if (zo) zo.addEventListener("click", function () { zoomByFactor(1 / 1.25); });
    if (rc) rc.addEventListener("click", function () { recenter(true); });

    window.addEventListener("resize", function () { if (initialized) { clampView(); applyView(); } });
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
    if (p.living) {
      var lb = el("p", "modal-living");
      lb.appendChild(el("span", "living-badge", "Living"));
      header.appendChild(lb);
    }
    dialogBody.appendChild(header);

    // Living people are now shown in full (dates, place, occupation, story,
    // uncertainties, sources) driven by the data — the same path as everyone.
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
    // Collateral relatives (no map node): open their modal directly.
    if (entry.type === "modal" || !mapNodes[entry.id]) {
      openModal(entry.id, searchInput);
      return;
    }
    // On-map person: pan + zoom the map to them, then pulse the card.
    var card = entry.card || (mapNodes[entry.id] && mapNodes[entry.id].card);
    centerOnNode(entry.id, true);
    window.setTimeout(function () { pulse(card); }, prefersReducedMotion() ? 0 : 540);
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
  var PASSCODE_LENGTH = 4;   // number of digits (drives the dot count)

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
      clearMap();
      if (dialogBody) dialogBody.innerHTML = "";
      if (dialog && dialog.open) dialog.close();
      if (originsBody) originsBody.innerHTML = "";
      if (originsDialog && originsDialog.open) originsDialog.close();
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

    // The map cards need a laid-out container to measure their heights, so
    // reveal the page-frame now (still hidden behind the gate's overlay).
    if (pageFrame) pageFrame.hidden = false;

    if (mapCanvas) {
      buildMap(data.root);

      // Index EVERYONE else (collateral relatives — uncles, aunts, cousins —
      // who have no map node) so search can still find them; selecting one
      // opens their modal directly.
      var indexed = {};
      searchIndex.forEach(function (e) { indexed[e.id] = 1; });
      Object.keys(people).forEach(function (id) {
        if (!indexed[id]) {
          searchIndex.push({ id: id, terms: searchTerms(people[id]), type: "modal" });
        }
      });

      wireMapGestures();
      // Place the initial view once layout is settled, then a gentle fade-in.
      window.requestAnimationFrame(function () {
        initialView();
        mapCanvas.classList.remove("map-enter");
        void mapCanvas.offsetWidth;
        if (!prefersReducedMotion()) mapCanvas.classList.add("map-enter");
      });
    }
    wireSearch();
    initialized = true;
  }

  /* ===================================================================
     Origins panel — ancestral breakdown by blood fraction.
     Computed live from `people`, so it always matches the tree. Each parent
     contributes half; a line that ends (no parents in the data) keeps its full
     remaining weight, attributed to the ending ancestor's birth country.
     =================================================================== */
  var ORIGIN_META = {
    "Poland":            { label: "Poland",                                    color: "#c0392b" },
    "Germany":           { label: "Germany",                                   color: "#c08a2e" },
    "Ireland":           { label: "Ireland",                                   color: "#3f8054" },
    "England":           { label: "England (traced to the immigrant)",         color: "#3f6d8c" },
    "Scotland":          { label: "Scotland",                                  color: "#5b6da8" },
    "Wales":             { label: "Wales",                                     color: "#4f8a86" },
    "France":            { label: "France",                                    color: "#8c5a8c" },
    "Colonial American": { label: "Colonial American (likely English/British)", color: "#8a7857" }
  };
  var ORIGIN_FALLBACK = "Colonial American";

  // Map a birthplace string to an origin country. Everything American, or with
  // no recorded birthplace, falls into the "Colonial American" bucket — old
  // family stock whose deeper origin isn't yet documented to the boat.
  function originCountry(place) {
    if (!place) return ORIGIN_FALLBACK;
    var s = String(place).toLowerCase();
    if (/\bengland\b|warwickshire|durham|london|yorkshire|\bkent\b|essex|somerset|devon|suffolk|norfolk|britain|\buk\b|badby|northampton/.test(s)) return "England";
    if (/ireland|monaghan|carrickmacross|\bcork\b|galway|\bmayo\b|donegal/.test(s)) return "Ireland";
    if (/poland|galicia|siennów|siennow|przemy/.test(s)) return "Poland";
    if (/germany|bavaria|bayern|prussia|baden/.test(s)) return "Germany";
    if (/scotland/.test(s)) return "Scotland";
    if (/wales/.test(s)) return "Wales";
    if (/france/.test(s)) return "France";
    return ORIGIN_FALLBACK; // American place, or unrecognized → colonial bucket
  }

  // Walk the ancestor graph from the root, attributing each person's blood
  // fraction. Returns [{ country, fraction, contributors: [{id, weight}] }]
  // sorted by fraction descending. Fractions sum to 1.
  function computeOrigins(rootId) {
    var points = {}; // "id|country" -> { id, country, weight }
    function add(id, country, w) {
      var k = id + "|" + country;
      if (!points[k]) points[k] = { id: id, country: country, weight: 0 };
      points[k].weight += w;
    }
    (function walk(id, w) {
      var p = people[id];
      if (!p) return;
      var parents = (p.parents || []).filter(function (pid) { return people[pid]; });
      var self = originCountry(p.birth && p.birth.place);
      if (!parents.length) { add(id, self, w); return; }
      parents.forEach(function (pid) { walk(pid, w * 0.5); });
      var missing = 2 - parents.length;          // an unknown parent ends the line here
      if (missing > 0) add(id, self, w * 0.5 * missing);
    })(rootId, 1);

    var totals = {};
    Object.keys(points).forEach(function (k) {
      var c = points[k];
      if (!totals[c.country]) totals[c.country] = { country: c.country, fraction: 0, contributors: [] };
      totals[c.country].fraction += c.weight;
      totals[c.country].contributors.push({ id: c.id, weight: c.weight });
    });
    return Object.keys(totals).map(function (c) {
      totals[c].contributors.sort(function (a, b) { return b.weight - a.weight; });
      return totals[c];
    }).sort(function (a, b) { return b.fraction - a.fraction; });
  }

  function fmtPct(f) {
    var v = f * 100;
    if (v > 0 && v < 0.1) return "<0.1%";
    return v.toFixed(1) + "%";
  }
  function metaFor(country) {
    return ORIGIN_META[country] || { label: country, color: "#9b9384" };
  }

  var originsDialog = document.getElementById("origins-dialog");
  var originsBody = document.getElementById("origins-body");
  var originsBtn = document.getElementById("origins-btn");
  var originsLastFocused = null;

  function buildOriginsPanel() {
    if (!originsBody) return;
    originsBody.innerHTML = "";
    var data = computeOrigins(DATA.root);

    var header = el("header", "origins-header");
    header.appendChild(el("h2", "origins-title font-display", "Where the Family Came From"));
    header.appendChild(el("p", "origins-lede",
      "Every ancestor’s share of your blood: each parent is half, each grandparent a quarter, and so on back through the tree."));
    originsBody.appendChild(header);

    // Stacked proportion bar.
    var bar = el("div", "origins-bar");
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", data.map(function (d) {
      return metaFor(d.country).label + " " + fmtPct(d.fraction);
    }).join(", "));
    data.forEach(function (d) {
      var seg = el("span", "origins-seg");
      seg.style.width = (d.fraction * 100) + "%";
      seg.style.background = metaFor(d.country).color;
      seg.title = metaFor(d.country).label + " — " + fmtPct(d.fraction);
      bar.appendChild(seg);
    });
    originsBody.appendChild(bar);

    // Legend rows; each expands to the ancestors who make it up.
    var list = el("ul", "origins-legend");
    data.forEach(function (d) {
      var meta = metaFor(d.country);
      var li = el("li", "origins-row");

      var head = el("button", "origins-row-head");
      head.type = "button";
      head.setAttribute("aria-expanded", "false");
      var sw = el("span", "origins-swatch");
      sw.style.background = meta.color;
      sw.setAttribute("aria-hidden", "true");
      head.appendChild(sw);
      head.appendChild(el("span", "origins-row-label", meta.label));
      head.appendChild(el("span", "origins-row-pct", fmtPct(d.fraction)));
      var caret = el("span", "origins-caret", "▸");
      caret.setAttribute("aria-hidden", "true");
      head.appendChild(caret);

      var detail = el("div", "origins-row-detail");
      detail.hidden = true;
      d.contributors.forEach(function (c) {
        var p = people[c.id];
        if (!p) return;
        var row = el("button", "origins-contrib");
        row.type = "button";
        row.appendChild(el("span", "origins-contrib-name", fullName(p)));
        var place = (p.birth && p.birth.place) ? p.birth.place : "birthplace unrecorded";
        row.appendChild(el("span", "origins-contrib-meta", fmtPct(c.weight) + " · " + place));
        row.addEventListener("click", function () {
          if (originsDialog.open) originsDialog.close();
          openModal(c.id, originsBtn);
        });
        detail.appendChild(row);
      });

      head.addEventListener("click", function () {
        var open = head.getAttribute("aria-expanded") === "true";
        head.setAttribute("aria-expanded", open ? "false" : "true");
        detail.hidden = open;
        caret.classList.toggle("open", !open);
      });

      li.appendChild(head);
      li.appendChild(detail);
      list.appendChild(li);
    });
    originsBody.appendChild(list);

    // Honest footnote: what the numbers do and don't claim.
    var traced = data.reduce(function (s, d) {
      return s + (d.country === ORIGIN_FALLBACK ? 0 : d.fraction);
    }, 0);
    var note = el("section", "origins-note");
    note.appendChild(el("p", null,
      "Traced to a specific origin country: " + fmtPct(traced) + ". The rest is old " +
      "American family stock whose deeper origin isn’t yet documented — by surname, " +
      "place and church it is very likely English/British colonial, with some German."));
    note.appendChild(el("p", null,
      "Why England reads so low: the colonial English lines (Griswold, Royce, Rice, " +
      "Massure) trace back 7–10 generations, and you inherit only a sliver of your " +
      "blood from any one ancestor that distant — so those proven threads count for " +
      "little by fraction, even though the American stock around them shares their origin."));
    originsBody.appendChild(note);
  }

  function openOrigins() {
    if (!originsDialog || !DATA) return;
    originsLastFocused = document.activeElement;
    buildOriginsPanel();
    if (typeof originsDialog.showModal === "function") originsDialog.showModal();
    else originsDialog.setAttribute("open", "");
    var close = originsDialog.querySelector(".origins-close");
    if (close) close.focus();
    originsBody.scrollTop = 0;
  }
  function closeOrigins() { if (originsDialog && originsDialog.open) originsDialog.close(); }

  if (originsBtn) originsBtn.addEventListener("click", openOrigins);
  if (originsDialog) {
    var oClose = originsDialog.querySelector(".origins-close");
    if (oClose) oClose.addEventListener("click", closeOrigins);
    originsDialog.addEventListener("click", function (e) { if (e.target === originsDialog) closeOrigins(); });
    originsDialog.addEventListener("close", function () {
      if (originsLastFocused && typeof originsLastFocused.focus === "function") originsLastFocused.focus();
    });
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
