/* =========================================================================
 * Family Tree Builder
 * A boundary-less, scrollable genealogy chart using standard pedigree symbols
 * (square = male, circle = female, diamond = unknown; slashed = deceased;
 *  horizontal line = couple; double-slash = divorced; dashed line = adopted).
 *
 * No build step, no dependencies — designed to run as static files on
 * GitHub Pages. Data lives in localStorage while editing and can be
 * published as a password-encrypted blob for family to view.
 * ========================================================================= */
(function () {
  "use strict";

  const SVGNS = "http://www.w3.org/2000/svg";
  const STORE_KEY = "familyTree.v1";

  /* ---- layout constants ---- */
  const COLW = 175;   // horizontal spacing between two people
  const ROWH = 215;   // vertical spacing between generations
  const CLUSTER_GAP = COLW; // min horizontal gap between unrelated family clusters
  const HALF = 46;    // half the visual footprint of a shape

  /* ---------------------------------------------------------------- state */
  let state = blankState();
  let layoutPos = {};        // computed positions {id:{x,y}}
  let selectedId = null;
  let readonly = false;
  let view = { tx: 0, ty: 0, scale: 1 };
  let pendingPhoto = null;   // dataURL staged in the person form
  let formSex = "male";

  function blankState() {
    return { title: "Family Tree", subtitle: "", persons: [], unions: [], links: [], manual: {} };
  }

  /* --------------------------------------------------------------- lookups */
  const byId = (arr, id) => arr.find((x) => x.id === id);
  const personById = (id) => byId(state.persons, id);
  const unionById = (id) => byId(state.unions, id);
  const childLinksOfUnion = (uid) => state.links.filter((l) => l.union === uid);
  const parentLinksOfPerson = (pid) => state.links.filter((l) => l.child === pid);
  const unionsOfPerson = (pid) => state.unions.filter((u) => u.a === pid || u.b === pid);

  function uid() {
    return "n" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }

  /* -------------------------------------------------------------- DOM refs */
  const $ = (sel) => document.querySelector(sel);
  const svg = $("#svg");
  const gViewport = $("#viewport");
  const gNodes = $("#nodes");
  const gLinks = $("#links");
  const stage = $("#stage");
  const emptyState = $("#empty");

  /* ================================================================ MODEL */
  function addPerson(data) {
    const p = { id: uid(), name: data.name || "Unnamed", birth: num(data.birth), death: num(data.death), sex: data.sex || "unknown", photo: data.photo || null };
    state.persons.push(p);
    return p;
  }
  function num(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }

  function deletePerson(pid) {
    state.persons = state.persons.filter((p) => p.id !== pid);
    // drop unions & links referencing this person
    const goneUnions = state.unions.filter((u) => u.a === pid || u.b === pid).map((u) => u.id);
    state.unions = state.unions.filter((u) => !goneUnions.includes(u.id));
    state.links = state.links.filter((l) => l.child !== pid && !goneUnions.includes(l.union));
    delete state.manual[pid];
  }

  function addUnion(a, b, status) {
    const u = { id: uid(), a, b: b || null, status: status || "married" };
    state.unions.push(u);
    return u;
  }
  function deleteUnion(uid_) {
    state.unions = state.unions.filter((u) => u.id !== uid_);
    state.links = state.links.filter((l) => l.union !== uid_);
  }

  function addChild(unionId, childId, type) {
    if (state.links.some((l) => l.union === unionId && l.child === childId)) return;
    state.links.push({ id: uid(), union: unionId, child: childId, type: type || "bio" });
  }
  function deleteLink(id) { state.links = state.links.filter((l) => l.id !== id); }

  /* ============================================================= LAYOUT */
  /* generation number for every person (0 = oldest at the top) */
  function computeGenerations() {
    const gen = {};
    state.persons.forEach((p) => (gen[p.id] = 0));
    const unionGen = (u) => Math.max(gen[u.a] || 0, u.b != null ? gen[u.b] || 0 : 0);
    for (let it = 0; it < 300; it++) {
      let changed = false;
      state.unions.forEach((u) => {
        if (u.b == null) return;
        const g = Math.max(gen[u.a] || 0, gen[u.b] || 0);
        if (gen[u.a] !== g) { gen[u.a] = g; changed = true; }
        if (gen[u.b] !== g) { gen[u.b] = g; changed = true; }
      });
      state.links.forEach((l) => {
        const u = unionById(l.union);
        if (!u) return;
        const need = unionGen(u) + 1;
        if ((gen[l.child] || 0) < need) { gen[l.child] = need; changed = true; }
      });
      if (!changed) break;
    }
    return gen;
  }

  function autoLayout() {
    const persons = state.persons;
    if (!persons.length) { layoutPos = {}; return; }
    const gen = computeGenerations();

    // adjacency to neighbouring generations
    const childrenOf = {}, parentsOf = {};
    persons.forEach((p) => { childrenOf[p.id] = []; parentsOf[p.id] = []; });
    state.links.forEach((l) => {
      const u = unionById(l.union); if (!u) return;
      [u.a, u.b].forEach((pid) => {
        if (pid == null) return;
        childrenOf[pid].push(l.child);
        parentsOf[l.child].push(pid);
      });
    });

    // group persons by generation
    const maxGen = Math.max(...persons.map((p) => gen[p.id]));
    const genList = [];
    for (let g = 0; g <= maxGen; g++) genList[g] = persons.filter((p) => gen[p.id] === g).map((p) => p.id);

    // spouse clusters (chains of partners) inside each generation
    const clustersByGen = genList.map((ids, g) => buildClusters(ids, g, gen));

    // order clusters within each generation via barycenter sweeps
    const order = clustersByGen.map((cl) => cl.slice()); // order[g] = [cluster,...]
    const colIndex = {}; // personId -> horizontal index within its generation
    const reindex = () => order.forEach((cls) => {
      let i = 0; cls.forEach((c) => c.ids.forEach((id) => (colIndex[id] = i++)));
    });
    reindex();
    for (let pass = 0; pass < 10; pass++) {
      const down = pass % 2 === 0;
      const seq = down ? range(1, maxGen) : range(maxGen - 1, 0, -1);
      seq.forEach((g) => {
        const adj = down ? parentsOf : childrenOf;
        order[g].forEach((c, i) => (c._bary = clusterBary(c, adj, colIndex, i)));
        order[g] = stableSort(order[g], (a, b) => a._bary - b._bary);
        reindex();
      });
    }

    // assign x coordinates, cluster granularity, refined toward neighbours
    order.forEach((cls) => {
      let x = 0;
      cls.forEach((c) => { c.x = x; x += c.width + CLUSTER_GAP; });
    });
    const memberX = (c, id) => c.x + c.offset[id];
    for (let pass = 0; pass < 14; pass++) {
      const down = pass % 2 === 0;
      const seq = down ? range(0, maxGen) : range(maxGen, 0, -1);
      seq.forEach((g) => {
        const adj = down ? parentsOf : childrenOf;
        order[g].forEach((c) => {
          let sum = 0, cnt = 0;
          c.ids.forEach((id) => {
            const nb = adj[id];
            if (!nb || !nb.length) return;
            let t = 0, m = 0;
            nb.forEach((o) => { const oc = clusterOf(order, o); if (oc) { t += memberX(oc, o); m++; } });
            if (m) { sum += t / m - c.offset[id]; cnt++; }
          });
          c._desired = cnt ? sum / cnt : c.x;
        });
        // resolve left-to-right so clusters never overlap, but honour desired
        let prevRight = -Infinity;
        order[g].forEach((c) => {
          let nx = c._desired;
          if (nx < prevRight + CLUSTER_GAP) nx = prevRight + CLUSTER_GAP;
          c.x = nx; prevRight = c.x + c.width;
        });
      });
    }

    // write final positions
    layoutPos = {};
    order.forEach((cls, g) => cls.forEach((c) => c.ids.forEach((id) => {
      layoutPos[id] = { x: c.x + c.offset[id], y: g * ROWH };
    })));
  }

  function buildClusters(ids, g, gen) {
    const inGen = new Set(ids);
    const adj = {}; ids.forEach((id) => (adj[id] = []));
    state.unions.forEach((u) => {
      if (u.b == null) return;
      if (inGen.has(u.a) && inGen.has(u.b)) { adj[u.a].push(u.b); adj[u.b].push(u.a); }
    });
    const seen = new Set(), clusters = [];
    // deterministic: iterate in generation order, prefer chain endpoints as starts
    ids.forEach((start) => {
      if (seen.has(start)) return;
      // find an endpoint of this component (degree <= 1) for a tidy chain
      const comp = componentOf(start, adj);
      let head = comp.find((id) => adj[id].length <= 1) || start;
      const chain = walkChain(head, adj, seen);
      const offset = {}; chain.forEach((id, i) => (offset[id] = i * COLW));
      clusters.push({ ids: chain, offset, width: (chain.length - 1) * COLW, x: 0 });
    });
    return clusters;
  }
  function componentOf(start, adj) {
    const out = [], stack = [start], seen = new Set([start]);
    while (stack.length) { const n = stack.pop(); out.push(n); adj[n].forEach((m) => { if (!seen.has(m)) { seen.add(m); stack.push(m); } }); }
    return out;
  }
  function walkChain(head, adj, seen) {
    const chain = []; let cur = head, prev = null;
    while (cur != null && !seen.has(cur)) {
      seen.add(cur); chain.push(cur);
      const next = adj[cur].find((m) => m !== prev && !seen.has(m));
      prev = cur; cur = next;
    }
    return chain;
  }
  function clusterBary(c, adj, colIndex, fallbackIndex) {
    let sum = 0, cnt = 0;
    c.ids.forEach((id) => { (adj[id] || []).forEach((o) => { if (o in colIndex) { sum += colIndex[o]; cnt++; } }); });
    return cnt ? sum / cnt : fallbackIndex;
  }
  function clusterOf(order, id) {
    for (const cls of order) for (const c of cls) if (c.offset && id in c.offset) return c;
    return null;
  }
  function range(a, b, step) { step = step || (a <= b ? 1 : -1); const out = []; for (let i = a; step > 0 ? i <= b : i >= b; i += step) out.push(i); return out; }
  function stableSort(arr, cmp) { return arr.map((v, i) => [v, i]).sort((x, y) => cmp(x[0], y[0]) || x[1] - y[1]).map((p) => p[0]); }

  const posOf = (id) => state.manual[id] || layoutPos[id] || { x: 0, y: 0 };

  /* ============================================================= RENDER */
  function render() {
    gNodes.textContent = "";
    gLinks.textContent = "";
    emptyState.style.display = state.persons.length ? "none" : "flex";

    state.unions.forEach(renderUnion);
    // single-parent links (child whose only parent link points to a 1-person "union" handled in renderUnion)
    state.persons.forEach(renderPerson);
    updatePeopleList();
    $("#peopleCount").textContent = state.persons.length;
  }

  function el(tag, attrs, children) {
    const e = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (children) (Array.isArray(children) ? children : [children]).forEach((c) => c && e.appendChild(c));
    return e;
  }

  function renderPerson(p) {
    const pos = posOf(p.id);
    const g = el("g", { class: "person" + (p.id === selectedId ? " selected" : ""), transform: `translate(${pos.x},${pos.y})`, "data-id": p.id });

    const clip = { male: "clip-male", female: "clip-female", unknown: "clip-unknown" }[p.sex] || "clip-unknown";
    if (p.photo) {
      g.appendChild(el("image", { href: p.photo, x: -HALF, y: -HALF, width: HALF * 2, height: HALF * 2, preserveAspectRatio: "xMidYMid slice", "clip-path": `url(#${clip})` }));
    } else {
      g.appendChild(el("text", { class: "placeholder-emoji", x: 0, y: 2 }, txt("👤")));
    }
    // shape outline on top
    g.appendChild(shapeOutline(p.sex, !!p.photo));
    // deceased slash
    if (p.death != null) g.appendChild(el("line", { class: "deceased", x1: -HALF, y1: HALF, x2: HALF, y2: -HALF }));

    // labels
    g.appendChild(el("text", { class: "label", x: 0, y: HALF + 20 }, txt(p.name)));
    const d = dateStr(p);
    if (d) g.appendChild(el("text", { class: "dates", x: 0, y: HALF + 38 }, txt(d)));

    gNodes.appendChild(g);
  }

  function shapeOutline(sex, hasPhoto) {
    const fill = hasPhoto ? "none" : "var(--node-fill)";
    if (sex === "female") return el("circle", { class: "shape", r: 41, cx: 0, cy: 0, fill: hasPhoto ? "none" : fill, "fill-opacity": hasPhoto ? 0 : 1 });
    if (sex === "unknown") return el("polygon", { class: "shape", points: "0,-46 46,0 0,46 -46,0", fill });
    return el("rect", { class: "shape", x: -40, y: -40, width: 80, height: 80, rx: 6, fill });
  }

  function dateStr(p) {
    if (p.birth != null && p.death != null) return p.birth + "–" + p.death;
    if (p.birth != null) return "b. " + p.birth;
    if (p.death != null) return "d. " + p.death;
    return "";
  }

  function renderUnion(u) {
    const pa = personById(u.a); if (!pa) return;
    const pb = u.b != null ? personById(u.b) : null;
    const A = posOf(u.a), B = pb ? posOf(u.b) : null;
    const kids = childLinksOfUnion(u.id).map((l) => ({ l, p: personById(l.child) })).filter((k) => k.p);

    let midX, midY, dropTop;
    if (pb) {
      const y = (A.y + B.y) / 2;
      const left = A.x < B.x ? A : B, right = A.x < B.x ? B : A;
      const dashed = u.status === "partners";
      gLinks.appendChild(el("line", { class: "link", x1: left.x + HALF - 6, y1: y, x2: right.x - HALF + 6, y2: y, "stroke-dasharray": dashed ? "6 5" : null }));
      midX = (A.x + B.x) / 2; midY = y; dropTop = y;
      if (u.status === "divorced") {
        // double-slash across the middle of the marriage line
        [-7, 5].forEach((dx) => gLinks.appendChild(el("line", { class: "divorce-tick", x1: midX + dx + 5, y1: midY - 11, x2: midX + dx - 5, y2: midY + 11 })));
      }
    } else {
      midX = A.x; midY = A.y; dropTop = A.y + HALF; // drop from the single parent's bottom
    }

    if (!kids.length) return;

    // bus below the couple, connecting to each child
    const childTops = kids.map((k) => ({ x: posOf(k.p.id).x, top: posOf(k.p.id).y - HALF - 8, type: k.l.type }));
    // stagger the sibling-bus height a little so unions in the same generation
    // (e.g. birth parents + adoptive parents of the same children) don't overlap
    const uIdx = state.unions.indexOf(u);
    const busY = midY + ROWH * 0.46 + (uIdx % 4) * 16;
    // vertical drop from union to bus
    gLinks.appendChild(el("line", { class: "link", x1: midX, y1: dropTop, x2: midX, y2: busY }));
    // horizontal bus
    const minX = Math.min(midX, ...childTops.map((c) => c.x));
    const maxX = Math.max(midX, ...childTops.map((c) => c.x));
    if (childTops.length > 1 || minX !== maxX)
      gLinks.appendChild(el("line", { class: "link", x1: minX, y1: busY, x2: maxX, y2: busY }));
    // verticals to each child (dashed + green if adopted)
    childTops.forEach((c) => {
      gLinks.appendChild(el("line", { class: "link" + (c.type === "adopted" ? " adopt" : ""), x1: c.x, y1: busY, x2: c.x, y2: c.top }));
    });
  }

  function txt(s) { return document.createTextNode(s); }

  /* ------------------------------------------------------- people list UI */
  function updatePeopleList() {
    const ul = $("#peopleList"); ul.textContent = "";
    const sorted = state.persons.slice().sort((a, b) => (a.birth || 9999) - (b.birth || 9999) || a.name.localeCompare(b.name));
    sorted.forEach((p) => {
      const li = document.createElement("li");
      if (p.id === selectedId) li.className = "sel";
      li.innerHTML = miniShape(p.sex) + `<span>${escapeHtml(p.name)}</span><span class="meta">${dateStr(p)}</span>`;
      li.onclick = () => { selectPerson(p.id); centerOn(p.id); };
      ul.appendChild(li);
    });
  }
  function miniShape(sex) {
    if (sex === "female") return '<svg class="mini" viewBox="-14 -14 28 28"><circle r="11"/></svg>';
    if (sex === "unknown") return '<svg class="mini" viewBox="-14 -14 28 28"><polygon points="0,-12 12,0 0,12 -12,0"/></svg>';
    return '<svg class="mini" viewBox="-14 -14 28 28"><rect x="-11" y="-11" width="22" height="22" rx="3"/></svg>';
  }

  /* ============================================================ VIEW */
  function applyView() {
    gViewport.setAttribute("transform", `translate(${view.tx},${view.ty}) scale(${view.scale})`);
    $("#zoomLabel").textContent = Math.round(view.scale * 100) + "%";
  }
  function bbox() {
    const ids = state.persons.map((p) => p.id);
    if (!ids.length) return { x: 0, y: 0, w: 100, h: 100 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ids.forEach((id) => { const p = posOf(id); minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); });
    const pad = 90;
    return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  }
  function fitView() {
    const b = bbox(); const r = stage.getBoundingClientRect();
    const s = Math.min(r.width / b.w, r.height / b.h, 1.2);
    view.scale = Math.max(0.15, s);
    view.tx = (r.width - b.w * view.scale) / 2 - b.x * view.scale;
    view.ty = (r.height - b.h * view.scale) / 2 - b.y * view.scale;
    applyView();
  }
  function centerOn(id) {
    const p = posOf(id); const r = stage.getBoundingClientRect();
    view.tx = r.width / 2 - p.x * view.scale;
    view.ty = r.height / 2 - p.y * view.scale;
    applyView();
  }
  function zoomAt(factor, cx, cy) {
    const r = stage.getBoundingClientRect();
    cx = cx == null ? r.width / 2 : cx - r.left; cy = cy == null ? r.height / 2 : cy - r.top;
    const ns = Math.min(3, Math.max(0.12, view.scale * factor));
    const k = ns / view.scale;
    view.tx = cx - (cx - view.tx) * k; view.ty = cy - (cy - view.ty) * k;
    view.scale = ns; applyView();
  }

  /* ============================================================ INTERACTION */
  let drag = null;
  svg.addEventListener("pointerdown", (e) => {
    const personEl = e.target.closest && e.target.closest(".person");
    if (personEl && !readonly) {
      const id = personEl.getAttribute("data-id");
      const p = posOf(id);
      drag = { mode: "node", id, startX: e.clientX, startY: e.clientY, ox: p.x, oy: p.y, moved: false };
    } else if (personEl && readonly) {
      selectPerson(personEl.getAttribute("data-id"));
      drag = { mode: "pan", startX: e.clientX, startY: e.clientY, tx: view.tx, ty: view.ty };
      stage.classList.add("panning");
    } else {
      drag = { mode: "pan", startX: e.clientX, startY: e.clientY, tx: view.tx, ty: view.ty };
      stage.classList.add("panning");
    }
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
    if (drag.mode === "pan") { view.tx = drag.tx + dx; view.ty = drag.ty + dy; applyView(); }
    else if (drag.mode === "node") {
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      state.manual[drag.id] = { x: drag.ox + dx / view.scale, y: drag.oy + dy / view.scale };
      render();
    }
  });
  svg.addEventListener("pointerup", (e) => {
    stage.classList.remove("panning");
    if (drag && drag.mode === "node") {
      if (!drag.moved) selectPerson(drag.id);
      else save();
    }
    drag = null;
  });
  stage.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY); }, { passive: false });

  /* ============================================================ FORMS */
  function selectPerson(id) {
    selectedId = id;
    const p = personById(id);
    if (p && !readonly) fillPersonForm(p);
    render();
  }
  function fillPersonForm(p) {
    $("#personId").value = p.id;
    $("#pName").value = p.name;
    $("#pBirth").value = p.birth == null ? "" : p.birth;
    $("#pDeath").value = p.death == null ? "" : p.death;
    setSex(p.sex);
    pendingPhoto = p.photo || null;
    updatePhotoPreview();
    $("#personSubmit").textContent = "Save changes";
    $("#personCancel").hidden = false;
    $("#personDelete").hidden = false;
  }
  function resetPersonForm() {
    $("#personId").value = "";
    $("#personForm").reset();
    setSex("male");
    pendingPhoto = null; updatePhotoPreview();
    $("#personSubmit").textContent = "Add person";
    $("#personCancel").hidden = true;
    $("#personDelete").hidden = true;
  }
  function setSex(s) {
    formSex = s;
    document.querySelectorAll("#sexToggle button").forEach((b) => b.classList.toggle("active", b.dataset.sex === s));
  }
  function updatePhotoPreview() {
    const img = $("#photoPreview"), clr = $("#photoClear");
    if (pendingPhoto) { img.src = pendingPhoto; img.hidden = false; clr.hidden = false; }
    else { img.hidden = true; clr.hidden = true; }
  }

  document.querySelectorAll("#sexToggle button").forEach((b) => (b.onclick = () => setSex(b.dataset.sex)));

  $("#personForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = $("#personId").value;
    const data = { name: $("#pName").value.trim() || "Unnamed", birth: $("#pBirth").value, death: $("#pDeath").value, sex: formSex, photo: pendingPhoto };
    if (id) {
      const p = personById(id);
      Object.assign(p, { name: data.name, birth: num(data.birth), death: num(data.death), sex: data.sex, photo: data.photo });
    } else {
      const p = addPerson(data); selectedId = p.id;
    }
    resetPersonForm();
    relayoutAndSave();
    toast("Saved");
  });
  $("#personCancel").onclick = resetPersonForm;
  $("#personDelete").onclick = () => {
    const id = $("#personId").value; if (!id) return;
    if (confirm("Delete this person and their connections?")) {
      deletePerson(id); selectedId = null; resetPersonForm(); relayoutAndSave();
    }
  };

  /* photo upload with downscale */
  $("#photoDrop").onclick = () => $("#photoInput").click();
  $("#photoClear").onclick = () => { pendingPhoto = null; updatePhotoPreview(); };
  $("#photoInput").addEventListener("change", (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => { pendingPhoto = downscale(img, 400); updatePhotoPreview(); };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  });
  function downscale(img, max) {
    let { width: w, height: h } = img;
    const scale = Math.min(1, max / Math.max(w, h));
    w = Math.round(w * scale); h = Math.round(h * scale);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.82);
  }

  /* ============================================================ MODALS */
  function openModal(title, hint, bodyHtml, onOk, okLabel) {
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = `<div class="modal"><h2>${title}</h2><div class="hint">${hint}</div>${bodyHtml}
      <div class="btn-row"><button class="btn" data-cancel>Cancel</button><button class="btn primary" data-ok>${okLabel || "Add"}</button></div></div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.querySelector("[data-cancel]").onclick = close;
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    back.querySelector("[data-ok]").onclick = () => { if (onOk(back) !== false) close(); };
    return back;
  }
  function personOptions(selectedVal, includeNone) {
    const opts = state.persons.slice().sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => `<option value="${p.id}" ${p.id === selectedVal ? "selected" : ""}>${escapeHtml(p.name)}${p.birth ? " (" + p.birth + ")" : ""}</option>`).join("");
    return (includeNone ? '<option value="">— none (single parent) —</option>' : "") + opts;
  }
  function unionLabel(u) {
    const a = personById(u.a); const b = u.b != null ? personById(u.b) : null;
    const sym = u.status === "divorced" ? " ✂ " : u.status === "partners" ? " ~ " : " + ";
    return escapeHtml((a ? a.name : "?") + (b ? sym + b.name : " (single parent)"));
  }
  function unionOptions(selectedVal) {
    return state.unions.map((u) => `<option value="${u.id}" ${u.id === selectedVal ? "selected" : ""}>${unionLabel(u)}</option>`).join("");
  }

  function openUnionModal() {
    if (state.persons.length < 1) return toast("Add people first");
    openModal("Add a couple / relationship",
      "Draws the line between two partners. Choose “divorced” to show a past marriage, or add another couple later for a remarriage.",
      `<label class="field"><span>Partner A</span><select id="uA">${personOptions(selectedId, false)}</select></label>
       <label class="field"><span>Partner B</span><select id="uB">${personOptions(null, true)}</select></label>
       <label class="field"><span>Status</span><select id="uStatus">
         <option value="married">Married</option><option value="divorced">Divorced / separated</option>
         <option value="partners">Partners (unmarried)</option></select></label>`,
      (m) => {
        const a = m.querySelector("#uA").value, b = m.querySelector("#uB").value, s = m.querySelector("#uStatus").value;
        if (!a) return false;
        if (a === b) { toast("Pick two different people"); return false; }
        addUnion(a, b, s); relayoutAndSave(); toast("Couple added");
      });
  }

  function openChildModal() {
    if (!state.unions.length) return toast("Add a couple first");
    if (!state.persons.length) return toast("Add people first");
    openModal("Add a child",
      "Attach a child to a specific couple — that’s how the chart shows which marriage a child belongs to. Mark them adopted to draw a dashed connector.",
      `<label class="field"><span>Couple (which marriage)</span><select id="cU">${unionOptions()}</select></label>
       <label class="field"><span>Child</span><select id="cChild">${personOptions(null, false)}</select></label>
       <label class="field"><span>Relationship</span><select id="cType">
         <option value="bio">Biological</option><option value="adopted">Adopted</option></select></label>
       <div class="hint">Tip: for a child raised by relatives, add them once as adopted under the adoptive couple, then also add them as biological under their birth parents — both links are drawn.</div>`,
      (m) => {
        const u = m.querySelector("#cU").value, c = m.querySelector("#cChild").value, t = m.querySelector("#cType").value;
        if (!u || !c) return false;
        addChild(u, c, t); relayoutAndSave(); toast("Child added");
      });
  }

  /* ============================================================ PUBLISH / CRYPTO */
  async function deriveKey(password, salt) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" }, base,
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function encryptState(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const data = new TextEncoder().encode(JSON.stringify(exportObject()));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
    return btoa(JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
  }
  async function decryptState(password, payload) {
    const o = JSON.parse(atob(payload));
    const key = await deriveKey(password, unb64(o.salt));
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(o.iv) }, key, unb64(o.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  function openPublishModal() {
    if (!state.persons.length) return toast("Nothing to publish yet");
    openModal("Publish for family",
      "Enter a password. We encrypt the whole tree in your browser and download <code>family-data.js</code>. Commit that file next to this page — visitors will need the password to view it.",
      `<label class="field"><span>Family password</span><input type="password" id="pubPass" placeholder="choose a password" /></label>
       <label class="field"><span>Confirm password</span><input type="password" id="pubPass2" placeholder="repeat it" /></label>`,
      (m) => {
        const p1 = m.querySelector("#pubPass").value, p2 = m.querySelector("#pubPass2").value;
        if (!p1) { toast("Enter a password"); return false; }
        if (p1 !== p2) { toast("Passwords don’t match"); return false; }
        encryptState(p1).then((payload) => {
          const content = "/* Encrypted family tree — generated by the Family Tree editor. */\nwindow.FAMILY_TREE_DATA = " + JSON.stringify(payload) + ";\n";
          downloadFile("family-data.js", content, "text/javascript");
          toast("Downloaded family-data.js — commit it to publish");
        }).catch((err) => { console.error(err); toast("Encryption failed"); });
      }, "Encrypt & download");
  }

  /* ============================================================ IMPORT/EXPORT/SAVE */
  function exportObject() {
    return { title: state.title, subtitle: state.subtitle, persons: state.persons, unions: state.unions, links: state.links, manual: state.manual };
  }
  function loadObject(obj) {
    state = Object.assign(blankState(), {
      title: obj.title || "Family Tree", subtitle: obj.subtitle || "",
      persons: obj.persons || [], unions: obj.unions || [], links: obj.links || [], manual: obj.manual || {},
    });
  }
  function downloadFile(name, content, type) {
    const blob = new Blob([content], { type: type || "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(exportObject())); } catch (e) { console.warn("save failed", e); } }
  function hasLocalData() { try { const s = localStorage.getItem(STORE_KEY); return s && JSON.parse(s).persons && JSON.parse(s).persons.length; } catch (e) { return false; } }
  function loadLocal() { try { const s = localStorage.getItem(STORE_KEY); if (s) loadObject(JSON.parse(s)); } catch (e) { console.warn(e); } }

  function relayoutAndSave() { autoLayout(); render(); save(); syncTitle(); }

  /* ============================================================ MISC UI */
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 1800);
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function syncTitle() {
    $("#treeTitle").textContent = state.title || "Family Tree";
    $("#treeSubtitle").textContent = state.subtitle || (readonly ? "" : "Build & arrange your family");
    document.title = state.title || "Family Tree";
  }

  /* wire toolbar + buttons */
  $("#tbAdd").onclick = () => { resetPersonForm(); $("#pName").focus(); ensurePanel(); };
  $("#tbUnion").onclick = openUnionModal;
  $("#tbChild").onclick = openChildModal;
  $("#tbArrange").onclick = () => { state.manual = {}; relayoutAndSave(); fitView(); toast("Auto-arranged"); };
  $("#tbFit").onclick = fitView;
  $("#tbZoomIn").onclick = () => zoomAt(1.2);
  $("#tbZoomOut").onclick = () => zoomAt(1 / 1.2);
  $("#addUnionBtn").onclick = openUnionModal;
  $("#addChildBtn").onclick = openChildModal;
  $("#exportBtn").onclick = () => { downloadFile((state.title || "family-tree").replace(/\s+/g, "-").toLowerCase() + ".json", JSON.stringify(exportObject(), null, 2)); toast("Exported"); };
  $("#importBtn").onclick = () => $("#importInput").click();
  $("#importInput").addEventListener("change", (e) => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { try { loadObject(JSON.parse(r.result)); relayoutAndSave(); fitView(); toast("Imported"); } catch (err) { toast("Bad file"); } };
    r.readAsText(f); e.target.value = "";
  });
  $("#publishBtn").onclick = openPublishModal;
  $("#resetBtn").onclick = () => { if (confirm("Clear the entire tree from this browser?")) { state = blankState(); localStorage.removeItem(STORE_KEY); selectedId = null; resetPersonForm(); relayoutAndSave(); } };
  $("#panelToggle").onclick = () => $("#panel").classList.toggle("collapsed");
  function ensurePanel() { $("#panel").classList.remove("collapsed"); }
  $("#legendToggle").onclick = () => { const l = $("#legend"); l.classList.toggle("min"); $("#legendToggle").textContent = l.classList.contains("min") ? "+" : "–"; };
  $("#emptyAdd").onclick = () => { resetPersonForm(); $("#pName").focus(); };
  $("#emptyDemo").onclick = () => { loadObject(demoData()); relayoutAndSave(); fitView(); toast("Loaded example family"); };

  /* ============================================================ LOCK SCREEN */
  function showLock(intoEditor) {
    const lock = $("#lock"); lock.hidden = false;
    $("#lockForm").onsubmit = (e) => {
      e.preventDefault();
      const pw = $("#lockPass").value;
      $("#lockErr").textContent = "";
      decryptState(pw, window.FAMILY_TREE_DATA).then((obj) => {
        loadObject(obj);
        lock.hidden = true;
        if (intoEditor) { readonly = false; save(); }
        else enterReadonly();
        boot();
      }).catch(() => { $("#lockErr").textContent = "Wrong password — try again."; });
    };
    $("#lockPass").focus();
  }
  function enterReadonly() {
    readonly = true;
    document.body.classList.add("readonly");
    $("#tbAdd").style.display = $("#tbUnion").style.display = $("#tbChild").style.display = "none";
    $("#tbArrange").style.display = "none";
  }

  /* ============================================================ DEMO DATA
   * Showcases every hard case: divorce, remarriage, "which marriage a child
   * is from", and the grandmother scenario (a couple who adopt their
   * orphaned relatives, whose birth parents died young). */
  function demoData() {
    const P = (id, name, sex, birth, death) => ({ id, name, sex, birth, death: death || null, photo: null });
    const persons = [
      // adoptive great-grandparents (grandmother's parents)
      P("gpa", "Robert Hauck", "male", 1908, 1985),
      P("gma", "Mary Hauck", "female", 1911, 1994),
      // Mary's sister & her husband — the birth parents who died young
      P("bpa", "Frank Kessler", "male", 1906, 1945),
      P("bpb", "Rose Kessler", "female", 1910, 1946),
      // biological children of Robert & Mary
      P("gm", "Grandma Ann", "female", 1938),
      P("unc", "Uncle Joe", "male", 1936, 2015),
      // orphaned cousins — birth children of Frank & Rose, adopted by Robert & Mary
      P("c1", "Cousin Ella", "female", 1940),
      P("c2", "Cousin Sam", "male", 1942),
      // Ann's first marriage (divorced) and second marriage
      P("h1", "Tom Berg", "male", 1935),
      P("h2", "George Lane", "male", 1940),
      P("d1", "Aunt Susan", "female", 1961),
      P("d2", "Peter's Parent", "male", 1966),
    ];
    const unions = [
      { id: "u_gp", a: "gpa", b: "gma", status: "married" },
      { id: "u_bp", a: "bpa", b: "bpb", status: "married" },
      { id: "u_ann1", a: "gm", b: "h1", status: "divorced" },
      { id: "u_ann2", a: "gm", b: "h2", status: "married" },
    ];
    const links = [
      { id: "l1", union: "u_gp", child: "gm", type: "bio" },
      { id: "l2", union: "u_gp", child: "unc", type: "bio" },
      { id: "l3", union: "u_bp", child: "c1", type: "bio" },
      { id: "l4", union: "u_bp", child: "c2", type: "bio" },
      { id: "l5", union: "u_gp", child: "c1", type: "adopted" },
      { id: "l6", union: "u_gp", child: "c2", type: "adopted" },
      { id: "l7", union: "u_ann1", child: "d1", type: "bio" },
      { id: "l8", union: "u_ann2", child: "d2", type: "bio" },
    ];
    return { title: "The Hauck Family", subtitle: "Example tree", persons, unions, links, manual: {} };
  }

  /* ============================================================ BOOT */
  function boot() {
    autoLayout(); render(); syncTitle(); fitView();
  }

  function init() {
    setSex("male");
    const params = new URLSearchParams(location.search);
    const wantEdit = params.has("edit");
    const published = typeof window.FAMILY_TREE_DATA === "string" && window.FAMILY_TREE_DATA.length > 20;

    if (published && !hasLocalData() && !wantEdit) {
      // visitor: must unlock, read-only
      showLock(false);
      return;
    }
    if (published && wantEdit && !hasLocalData()) {
      // owner returning on another machine: unlock into the editor
      showLock(true);
      return;
    }
    // normal editor
    if (hasLocalData()) loadLocal();
    boot();
  }

  init();
})();
