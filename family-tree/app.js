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
  const COLW = 168;   // horizontal spacing between two people
  const ROWH = 250;   // vertical spacing between generations
  const CLUSTER_GAP = COLW * 0.7; // min horizontal gap between unrelated family clusters
  const HALF = 46;    // half the visual footprint of a shape

  /* ---------------------------------------------------------------- state */
  let state = blankState();
  let layoutPos = {};        // computed positions {id:{x,y}}
  let selectedId = null;
  let readonly = false;
  let view = { tx: 0, ty: 0, scale: 1 };
  let pendingPhoto = null;   // dataURL staged in the person form
  let formSex = "male";
  let formColor = "";
  const FAMILY_COLORS = ["#2f6fb0", "#9e6b3f", "#3f8f5a", "#2a9d9d", "#bf8b30", "#b5495b", "#8a4f80"];

  function blankState() {
    return { title: "Family Tree", subtitle: "", persons: [], unions: [], links: [], manual: {}, hidden: {}, focus: [] };
  }

  /* --------------------------------------------------------------- lookups */
  const byId = (arr, id) => arr.find((x) => x.id === id);
  const personById = (id) => byId(state.persons, id);
  const unionById = (id) => byId(state.unions, id);
  const childLinksOfUnion = (uid) => state.links.filter((l) => l.union === uid);
  const parentLinksOfPerson = (pid) => state.links.filter((l) => l.child === pid);
  const unionsOfPerson = (pid) => state.unions.filter((u) => u.a === pid || u.b === pid);

  /* --------- visibility (hidden people keep their data; view-only filter) --- */
  const isHidden = (id) => !!(state.hidden && state.hidden[id]);
  const anyHidden = () => state.hidden && Object.keys(state.hidden).length > 0;
  const visiblePersons = () => state.persons.filter((p) => !isHidden(p.id));
  const unionVisible = (u) => !isHidden(u.a) && (u.b == null || !isHidden(u.b));
  const visibleUnions = () => state.unions.filter(unionVisible);
  const visibleLinks = () => state.links.filter((l) => { const u = unionById(l.union); return !isHidden(l.child) && u && unionVisible(u); });

  // Everyone who should stay visible when focusing on X: X, X's spouses, and all
  // of X's descendants plus their spouses. Everyone "above"/aside is hidden.
  function focusSet(rootId) {
    const keep = new Set([rootId]);
    const spousesOf = (id) => unionsOfPerson(id).map((u) => (u.a === id ? u.b : u.a)).filter((x) => x != null);
    const childrenOf = (id) => state.unions.filter((u) => u.a === id || u.b === id).flatMap((u) => childLinksOfUnion(u.id).map((l) => l.child));
    const queue = [rootId];
    while (queue.length) {
      const id = queue.shift();
      spousesOf(id).forEach((s) => keep.add(s));
      childrenOf(id).forEach((c) => { if (!keep.has(c)) { keep.add(c); queue.push(c); } });
    }
    return keep;
  }
  function hideAbove(rootId) {
    const keep = focusSet(rootId);
    state.hidden = {};
    state.persons.forEach((p) => { if (!keep.has(p.id)) state.hidden[p.id] = true; });
  }
  function toggleHidden(id) { if (isHidden(id)) delete state.hidden[id]; else state.hidden[id] = true; }
  function showAll() { state.hidden = {}; }

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
    const p = { id: uid(), name: data.name || "Unnamed", birth: num(data.birth), death: num(data.death), deceased: !!data.deceased, sex: data.sex || "unknown", color: data.color || null, photo: data.photo || null, docs: data.docs || [] };
    state.persons.push(p);
    return p;
  }
  const isDeceased = (p) => p.death != null || !!p.deceased;
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
  function computeGenerations(persons, unions, links, uById) {
    const gen = {};
    persons.forEach((p) => (gen[p.id] = 0));
    const unionGen = (u) => Math.max(gen[u.a] || 0, u.b != null ? gen[u.b] || 0 : 0);
    for (let it = 0; it < 300; it++) {
      let changed = false;
      unions.forEach((u) => {
        if (u.b == null) return;
        const g = Math.max(gen[u.a] || 0, gen[u.b] || 0);
        if (gen[u.a] !== g) { gen[u.a] = g; changed = true; }
        if (gen[u.b] !== g) { gen[u.b] = g; changed = true; }
      });
      links.forEach((l) => {
        const u = uById[l.union];
        if (!u) return;
        const need = unionGen(u) + 1;
        if ((gen[l.child] || 0) < need) { gen[l.child] = need; changed = true; }
      });
      if (!changed) break;
    }
    return gen;
  }

  function autoLayout() {
    // Work over the VISIBLE subset only — hidden people keep their data but are
    // dropped from layout so they take no space (see state.hidden).
    const persons = visiblePersons();
    if (!persons.length) { layoutPos = {}; return; }
    const unions = visibleUnions();
    const links = visibleLinks();
    const uById = {}; unions.forEach((u) => (uById[u.id] = u));
    // GLOBAL generations — computed across everyone so every band's rows line up
    // vertically (a grandparent is always on the same row, whichever family).
    const gen = computeGenerations(persons, unions, links, uById);

    // Lay everyone out together as a "meet in the middle" pedigree (see
    // layoutComponent): married couples sit adjacent so each partner's family
    // fans up and outward and the two families converge on the couple.
    const all = new Set(persons.map((p) => p.id));
    const sub = layoutComponent(all, persons, unions, links, uById, gen);
    layoutPos = sub.pos;
  }

  // Lay the whole graph out as a "meet in the middle" pedigree: married couples
  // sit adjacent, so each partner's family fans up and outward and the two
  // families converge on the couple (and their children below). Every bloodline
  // family is kept as a CONTIGUOUS block so unrelated families never interleave
  // or stack — the tangle that free barycenter layout produces. Returns local
  // x/y positions plus the min/max x.
  function layoutComponent(idSet, persons, unions, links, uById, gen) {
    const cPersons = persons.filter((p) => idSet.has(p.id));
    if (!cPersons.length) return { pos: {}, minX: Infinity, maxX: -Infinity };
    const cUnions = unions.filter((u) => idSet.has(u.a) && (u.b == null || idSet.has(u.b)));
    const cLinks = links.filter((l) => { const u = uById[l.union]; return idSet.has(l.child) && u && idSet.has(u.a); });

    // which surname/descent family each person belongs to (contiguity grouping)
    const familyId = {};
    descentFamilies(cPersons, cUnions, cLinks, uById).forEach((set, i) => set.forEach((id) => (familyId[id] = i)));

    // adjacency to neighbouring generations (within this family only)
    const childrenOf = {}, parentsOf = {};
    cPersons.forEach((p) => { childrenOf[p.id] = []; parentsOf[p.id] = []; });
    cLinks.forEach((l) => {
      const u = uById[l.union]; if (!u) return;
      [u.a, u.b].forEach((pid) => {
        if (pid == null || !idSet.has(pid)) return;
        if (childrenOf[pid]) childrenOf[pid].push(l.child);
        if (parentsOf[l.child]) parentsOf[l.child].push(pid);
      });
    });

    // group persons by GLOBAL generation
    const maxGen = Math.max(...cPersons.map((p) => gen[p.id]));
    const genList = [];
    for (let g = 0; g <= maxGen; g++) genList[g] = cPersons.filter((p) => gen[p.id] === g).map((p) => p.id);

    // spouse clusters (chains of partners) inside each generation
    const clustersByGen = genList.map((ids, g) => buildClusters(ids || [], g, gen, cUnions));

    // order clusters within each generation via barycenter sweeps
    const order = clustersByGen.map((cl) => cl.slice()); // order[g] = [cluster,...]
    const colIndex = {}; // personId -> horizontal index within its generation
    const reindex = () => order.forEach((cls) => {
      let i = 0; cls.forEach((c) => c.ids.forEach((id) => (colIndex[id] = i++)));
    });
    reindex();
    // (1) barycenter sweeps sort out the gross left/right arrangement
    for (let pass = 0; pass < 8; pass++) {
      const down = pass % 2 === 0;
      const seq = down ? (maxGen >= 1 ? range(1, maxGen) : []) : (maxGen >= 1 ? range(maxGen - 1, 0, -1) : []);
      seq.forEach((g) => {
        const adj = down ? parentsOf : childrenOf;
        order[g].forEach((c, i) => (c._bary = clusterBary(c, adj, colIndex, i)));
        order[g] = stableSort(order[g], (a, b) => a._bary - b._bary);
        reindex();
      });
    }
    // (2) sibling grouping: keep every couple's children contiguous and sitting
    // under that couple, so half/step-sibling sets don't interleave (e.g. the
    // Hauck children stay together even though one married into another family).
    const primaryUnion = {};
    cLinks.forEach((l) => { if (l.type === "bio") primaryUnion[l.child] = l.union; });
    cLinks.forEach((l) => { if (!(l.child in primaryUnion)) primaryUnion[l.child] = l.union; });
    const clusterUnion = (c) => { for (const id of c.ids) if (primaryUnion[id]) return primaryUnion[id]; return null; };
    const unionPos = (uid) => {
      const u = uById[uid]; if (!u) return Infinity;
      const xs = [u.a, u.b].filter((x) => x != null && x in colIndex).map((x) => colIndex[x]);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Infinity;
    };
    for (let pass = 0; pass < 3; pass++) {
      for (let g = 1; g <= maxGen; g++) {
        order[g].forEach((c, i) => {
          const gu = clusterUnion(c);
          c._sort = gu != null ? unionPos(gu) : (c.ids[0] in colIndex ? colIndex[c.ids[0]] : i);
        });
        order[g] = stableSort(order[g], (a, b) => a._sort - b._sort);
        reindex();
      }
    }
    // (3) family contiguity: keep every bloodline family together as one block,
    // ordered by the family's overall horizontal centre. This stops unrelated
    // families from interleaving or sitting over one another. A couple that
    // BRIDGES two families is keyed to the AVERAGE of the two families' centres,
    // so it sorts to the boundary BETWEEN them — the two spouses end up at the
    // adjacent ends of their family lines, with each family's siblings kept to
    // their own side rather than squeezed between the couple.
    const clusterFamKey = (c, famBary) => {
      let sum = 0, n = 0; const seen = {};
      for (const id of c.ids) {
        const f = familyId[id];
        if (f == null || seen[f] || !(f in famBary)) continue;
        seen[f] = 1; sum += famBary[f]; n++;
      }
      return n ? sum / n : null;
    };
    for (let pass = 0; pass < 4; pass++) {
      const acc = {}, cnt = {};
      for (const id in colIndex) { const f = familyId[id]; if (f == null) continue; acc[f] = (acc[f] || 0) + colIndex[id]; cnt[f] = (cnt[f] || 0) + 1; }
      const famBary = {}; for (const f in acc) famBary[f] = acc[f] / cnt[f];
      for (let g = 0; g <= maxGen; g++) {
        order[g].forEach((c, i) => {
          const k = clusterFamKey(c, famBary);
          c._famB = k != null ? k : i;
          c._inB = c.ids[0] in colIndex ? colIndex[c.ids[0]] : i;
        });
        order[g] = stableSort(order[g], (a, b) => (a._famB - b._famB) || (a._inB - b._inB));
        reindex();
      }
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

    // write this band's local positions, then squeeze out dead space inside it
    const pos = {};
    order.forEach((cls, g) => cls.forEach((c) => c.ids.forEach((id) => {
      pos[id] = { x: c.x + c.offset[id], y: g * ROWH };
    })));
    compactPos(pos);
    let minX = Infinity, maxX = -Infinity;
    Object.keys(pos).forEach((id) => { minX = Math.min(minX, pos[id].x); maxX = Math.max(maxX, pos[id].x); });
    return { pos, minX, maxX };
  }

  // Partition everyone into bloodline families. Union-find over parent↔child
  // links only — a marriage never merges two families. A person who is blood-
  // connected to no one (e.g. a second husband with no children in the tree)
  // is pulled into their spouse's family so they band together rather than
  // floating off on their own.
  function lineageComponents(persons, unions, links, uById) {
    const parent = {}; persons.forEach((p) => (parent[p.id] = p.id));
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
    const has = {}; persons.forEach((p) => (has[p.id] = true));
    const degree = {}; persons.forEach((p) => (degree[p.id] = 0));
    links.forEach((l) => {
      const u = uById[l.union]; if (!u) return;
      if (has[l.child]) degree[l.child]++;
      [u.a, u.b].forEach((pid) => {
        if (pid == null || !has[pid]) return;
        degree[pid]++;
        if (has[l.child]) unite(l.child, pid);
      });
    });
    unions.forEach((u) => {
      if (u.b == null) return;
      if (has[u.a] && has[u.b]) {
        if (degree[u.a] === 0) unite(u.a, u.b);
        if (degree[u.b] === 0) unite(u.b, u.a);
      }
    });
    const groups = {};
    persons.forEach((p) => { const r = find(p.id); (groups[r] = groups[r] || new Set()).add(p.id); });
    return Object.values(groups);
  }

  // Partition everyone into surname/descent families for layout grouping. Unlike
  // lineageComponents, a marriage does NOT merge two families and a child follows
  // only ONE parent up the tree — so each surname line stays its own block (Eide,
  // Boyd, Fuchs, Miller, Hauck…). Blocks meet their in-laws at the marriage that
  // joins them, which is what gives the "one family on each side, converging in
  // the middle" shape at every level. A person who married in (no parents in the
  // tree) joins their spouse's family.
  function descentFamilies(persons, unions, links, uById) {
    const has = {}; persons.forEach((p) => (has[p.id] = true));
    // each child's birth union (prefer a biological link over an adoptive one)
    const bioUnion = {};
    links.forEach((l) => { if (l.type !== "adopted" && !(l.child in bioUnion)) bioUnion[l.child] = l.union; });
    links.forEach((l) => { if (!(l.child in bioUnion)) bioUnion[l.child] = l.union; });
    const hasParents = (id) => id in bioUnion && !!uById[bioUnion[id]];
    // the single parent a child inherits its family from: prefer a parent who is
    // themselves rooted in the tree (continues a lineage), else the first parent.
    const primaryParent = {};
    persons.forEach((p) => {
      const u = uById[bioUnion[p.id]]; if (!u) return;
      const cand = [u.a, u.b].filter((x) => x != null && has[x]);
      if (!cand.length) return;
      primaryParent[p.id] = cand.find((x) => hasParents(x)) || cand[0];
    });
    const parent = {}; persons.forEach((p) => (parent[p.id] = p.id));
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
    persons.forEach((p) => { if (primaryParent[p.id] != null) unite(p.id, primaryParent[p.id]); });
    // married-in people (no parents in the tree) join their spouse's family
    unions.forEach((u) => {
      if (u.b == null || !has[u.a] || !has[u.b]) return;
      if (!hasParents(u.a)) unite(u.a, u.b);
      if (!hasParents(u.b)) unite(u.b, u.a);
    });
    const groups = {};
    persons.forEach((p) => { const r = find(p.id); (groups[r] = groups[r] || new Set()).add(p.id); });
    return Object.values(groups);
  }

  // Collapse vertical corridors of empty space that span a band — preserves
  // every relative position and vertical alignment; only removes dead space.
  function compactPos(pos) {
    const ids = Object.keys(pos);
    if (ids.length < 2) return;
    const pad = COLW * 0.55, maxGap = COLW * 1.1;
    const ivs = ids.map((id) => ({ l: pos[id].x - pad, r: pos[id].x + pad })).sort((a, b) => a.l - b.l);
    const cuts = [];
    let cur = { l: ivs[0].l, r: ivs[0].r };
    for (let i = 1; i < ivs.length; i++) {
      if (ivs[i].l > cur.r + 0.5) {
        const gap = ivs[i].l - cur.r;
        if (gap > maxGap) cuts.push({ x: cur.r, amount: gap - maxGap });
        cur = { l: ivs[i].l, r: ivs[i].r };
      } else if (ivs[i].r > cur.r) cur.r = ivs[i].r;
    }
    if (!cuts.length) return;
    ids.forEach((id) => {
      let s = 0;
      for (const c of cuts) if (pos[id].x > c.x) s += c.amount;
      pos[id].x -= s;
    });
  }

  function buildClusters(ids, g, gen, unions) {
    const inGen = new Set(ids);
    const adj = {}; ids.forEach((id) => (adj[id] = []));
    unions.forEach((u) => {
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

    visibleUnions().forEach(renderUnion);
    visiblePersons().forEach(renderPerson);
    updatePeopleList();
    $("#peopleCount").textContent = state.persons.length;
    updateHiddenChip();
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
    g.appendChild(shapeOutline(p.sex, !!p.photo, p.color));
    // deceased slash
    if (isDeceased(p)) g.appendChild(el("line", { class: "deceased", x1: -HALF, y1: HALF, x2: HALF, y2: -HALF }));

    // labels — with a paper-coloured backing so connectors pass BEHIND the text
    const lines = nameLines(p.name);
    const d = dateStr(p);
    const cw = 7.5, dcw = 6.5;
    let w = 0;
    lines.forEach((l) => (w = Math.max(w, l.length * cw)));
    if (d) w = Math.max(w, d.length * dcw);
    const nLines = lines.length;
    const bgH = nLines * 18 + (d ? 15 : 0) + 8;
    g.appendChild(el("rect", { class: "label-bg", x: -(w / 2) - 6, y: HALF + 6, width: w + 12, height: bgH, rx: 5 }));
    lines.forEach((l, i) => g.appendChild(el("text", { class: "label", x: 0, y: HALF + 22 + i * 18 }, txt(l))));
    if (d) g.appendChild(el("text", { class: "dates", x: 0, y: HALF + 24 + nLines * 18 }, txt(d)));

    // attached obituaries/records badge
    if (p.docs && p.docs.length) {
      const badge = el("g", { class: "doc-badge", "data-id": p.id, transform: `translate(${HALF - 4},${-HALF + 2})` });
      badge.appendChild(el("text", { x: 0, y: 0, "text-anchor": "middle" }, txt("📄")));
      const tt = el("title", null, txt(p.docs.length + " attached record" + (p.docs.length > 1 ? "s" : "")));
      badge.appendChild(tt);
      g.appendChild(badge);
    }

    gNodes.appendChild(g);
  }

  function shapeOutline(sex, hasPhoto, color) {
    const fill = hasPhoto ? "none" : "var(--node-fill)";
    const style = color ? "stroke:" + color + ";stroke-width:3.4" : null; // family colour; inline style beats the class rule
    if (sex === "female") return el("circle", { class: "shape", r: 41, cx: 0, cy: 0, fill: hasPhoto ? "none" : fill, "fill-opacity": hasPhoto ? 0 : 1, style });
    if (sex === "unknown") return el("polygon", { class: "shape", points: "0,-46 46,0 0,46 -46,0", fill, style });
    return el("rect", { class: "shape", x: -40, y: -40, width: 80, height: 80, rx: 6, fill, style });
  }

  // Wrap a long name onto two lines (split at the space nearest the middle).
  function nameLines(name) {
    if (name.length <= 16 || name.indexOf(" ") < 0) return [name];
    const mid = name.length / 2;
    let best = -1, bd = 1e9;
    for (let i = 0; i < name.length; i++) if (name[i] === " ") { const dd = Math.abs(i - mid); if (dd < bd) { bd = dd; best = i; } }
    return best < 0 ? [name] : [name.slice(0, best), name.slice(best + 1)];
  }

  function dateStr(p) {
    if (p.birth != null && p.death != null) return p.birth + "–" + p.death;
    if (p.birth != null) return "b. " + p.birth + (isDeceased(p) ? " · d." : "");
    if (p.death != null) return "d. " + p.death;
    if (p.deceased) return "deceased";
    return "";
  }

  function renderUnion(u) {
    const pa = personById(u.a); if (!pa) return;
    const pb = u.b != null ? personById(u.b) : null;
    const A = posOf(u.a), B = pb ? posOf(u.b) : null;
    const kids = childLinksOfUnion(u.id).map((l) => ({ l, p: personById(l.child) })).filter((k) => k.p && !isHidden(k.p.id));

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

    // Colour the descent lines by the children's family so each set of lines is
    // traceable at a glance instead of a grey tangle.
    const famColor = kids.map((k) => k.p.color).find(Boolean) || (pa && pa.color) || (pb && pb.color) || null;
    const cstyle = famColor ? "stroke:" + famColor + ";stroke-width:2.8" : null;

    const childTops = kids.map((k) => ({ x: posOf(k.p.id).x, top: posOf(k.p.id).y - HALF - 8, type: k.l.type }));
    // Place the sibling bus in the clear band BELOW the parents' name labels and
    // ABOVE the children — so it never runs through anyone's name. A small
    // stagger keeps same-generation unions from sharing one line.
    const uIdx = state.unions.indexOf(u);
    const busY = midY + 158 + (uIdx % 3) * 13;
    // vertical drop from union to bus
    gLinks.appendChild(el("line", { class: "link", x1: midX, y1: dropTop, x2: midX, y2: busY, style: cstyle }));
    // horizontal bus
    const minX = Math.min(midX, ...childTops.map((c) => c.x));
    const maxX = Math.max(midX, ...childTops.map((c) => c.x));
    if (childTops.length > 1 || minX !== maxX)
      gLinks.appendChild(el("line", { class: "link", x1: minX, y1: busY, x2: maxX, y2: busY, style: cstyle }));
    // verticals to each child (dashed + green if adopted)
    childTops.forEach((c) => {
      gLinks.appendChild(el("line", { class: "link" + (c.type === "adopted" ? " adopt" : ""), x1: c.x, y1: busY, x2: c.x, y2: c.top, style: c.type === "adopted" ? null : cstyle }));
    });
  }

  function txt(s) { return document.createTextNode(s); }

  /* ------------------------------------------------------- people list UI */
  function updatePeopleList() {
    const ul = $("#peopleList"); ul.textContent = "";
    const sorted = state.persons.slice().sort((a, b) => (a.birth || 9999) - (b.birth || 9999) || a.name.localeCompare(b.name));
    sorted.forEach((p) => {
      const li = document.createElement("li");
      li.className = (p.id === selectedId ? "sel " : "") + (isHidden(p.id) ? "hidden" : "");
      li.innerHTML = miniShape(p.sex) + `<span>${escapeHtml(p.name)}</span><span class="meta">${dateStr(p)}</span>`;
      li.onclick = () => { selectPerson(p.id); if (!isHidden(p.id)) centerOn(p.id); };
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
    // only visible people have layout positions; hidden ones would otherwise
    // drag the box back to the origin and throw off fit-to-screen.
    const ids = visiblePersons().map((p) => p.id);
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
  // Open the page centred on a chosen couple (e.g. Peter & Alicen): the focus
  // people sit dead-centre, with the zoom set so their immediate family (spouses,
  // parents and children) is comfortably in view around them.
  function focusView(ids) {
    const focus = ids.filter((id) => personById(id) && !isHidden(id));
    if (!focus.length) return fitView();
    const fp = focus.map((id) => posOf(id));
    const cx = fp.reduce((s, p) => s + p.x, 0) / fp.length;
    const cy = fp.reduce((s, p) => s + p.y, 0) / fp.length;
    // gather the immediate family to size the zoom
    const set = new Set(focus);
    focus.forEach((id) => {
      unionsOfPerson(id).forEach((u) => {
        [u.a, u.b].forEach((x) => { if (x != null && !isHidden(x)) set.add(x); });
        childLinksOfUnion(u.id).forEach((l) => { if (!isHidden(l.child)) set.add(l.child); });
      });
      parentLinksOfPerson(id).forEach((l) => {
        const u = unionById(l.union); if (!u) return;
        [u.a, u.b].forEach((x) => { if (x != null && !isHidden(x)) set.add(x); });
      });
    });
    // widest distance from the couple's centre, so the frame stays centred on
    // them; capped so a scattered relative can't zoom the couple out to a speck.
    let halfW = 220, halfH = 200;
    set.forEach((id) => { const p = posOf(id); halfW = Math.max(halfW, Math.abs(p.x - cx) + 110); halfH = Math.max(halfH, Math.abs(p.y - cy) + 110); });
    halfW = Math.min(halfW, 650); halfH = Math.min(halfH, 430);
    const r = stage.getBoundingClientRect();
    view.scale = Math.max(0.55, Math.min(r.width / (halfW * 2), r.height / (halfH * 2), 1.1));
    view.tx = r.width / 2 - cx * view.scale;
    view.ty = r.height / 2 - cy * view.scale;
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
  const pointers = new Map();   // every active touch/mouse pointer: id -> {x,y}
  let pinch = null;             // two-finger zoom state
  let lastTap = 0;              // for double-tap-to-zoom

  function pinchInfo() {
    const pts = [...pointers.values()];
    const dx = pts[0].x - pts[1].x, dy = pts[0].y - pts[1].y;
    return { dist: Math.hypot(dx, dy) || 1, mx: (pts[0].x + pts[1].x) / 2, my: (pts[0].y + pts[1].y) / 2 };
  }
  function startPinch() {
    drag = null; stage.classList.remove("panning");
    const r = stage.getBoundingClientRect();
    const info = pinchInfo();
    // remember the world point under the pinch centre so it stays put as we scale/pan
    pinch = {
      startDist: info.dist, startScale: view.scale,
      worldX: (info.mx - r.left - view.tx) / view.scale,
      worldY: (info.my - r.top - view.ty) / view.scale,
    };
  }

  svg.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { svg.setPointerCapture(e.pointerId); } catch (_) {}
    if (pointers.size >= 2) { startPinch(); return; }

    const badge = e.target.closest && e.target.closest(".doc-badge");
    if (badge) { openDocsForPerson(badge.getAttribute("data-id")); return; }
    const personEl = e.target.closest && e.target.closest(".person");
    const isTouch = e.pointerType !== "mouse";
    if (personEl && !readonly && !isTouch) {
      // desktop only: click-and-drag a person to fine-tune their position
      const id = personEl.getAttribute("data-id");
      const p = posOf(id);
      drag = { mode: "node", id, startX: e.clientX, startY: e.clientY, ox: p.x, oy: p.y, moved: false };
    } else {
      // touch (or the read-only view): a finger on a person taps to select and
      // otherwise pans — it never drags the person out of place.
      drag = { mode: "pan", startX: e.clientX, startY: e.clientY, tx: view.tx, ty: view.ty, moved: false };
      if (personEl) drag.tapId = personEl.getAttribute("data-id");
      stage.classList.add("panning");
    }
  });

  svg.addEventListener("pointermove", (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) {
      const r = stage.getBoundingClientRect();
      const info = pinchInfo();
      const ns = Math.min(3, Math.max(0.12, pinch.startScale * (info.dist / pinch.startDist)));
      view.scale = ns;
      view.tx = (info.mx - r.left) - pinch.worldX * ns;
      view.ty = (info.my - r.top) - pinch.worldY * ns;
      applyView();
      return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
    if (drag.mode === "pan") {
      if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
      view.tx = drag.tx + dx; view.ty = drag.ty + dy; applyView();
    }
    else if (drag.mode === "node") {
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      state.manual[drag.id] = { x: drag.ox + dx / view.scale, y: drag.oy + dy / view.scale };
      render();
    }
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    try { svg.releasePointerCapture(e.pointerId); } catch (_) {}
    if (pointers.size < 2) pinch = null;
    // lifting one finger of a pinch — keep panning smoothly with the finger left down
    if (pointers.size === 1 && !drag) {
      const pt = [...pointers.values()][0];
      drag = { mode: "pan", startX: pt.x, startY: pt.y, tx: view.tx, ty: view.ty };
      stage.classList.add("panning");
    }
    if (pointers.size === 0) {
      stage.classList.remove("panning");
      if (drag && drag.mode === "node") { if (!drag.moved) selectPerson(drag.id); else save(); }
      // a tap on a person (no real movement) selects them
      else if (drag && drag.mode === "pan" && drag.tapId && !drag.moved) { selectPerson(drag.tapId); }
      // double-tap on empty canvas zooms in on that spot (touch only)
      if (e.pointerType !== "mouse" && drag && drag.mode === "pan" && !drag.tapId && !drag.moved) {
        if (e.timeStamp - lastTap < 300) { zoomAt(1.6, e.clientX, e.clientY); lastTap = 0; }
        else lastTap = e.timeStamp;
      }
      drag = null;
    }
  }
  svg.addEventListener("pointerup", endPointer);
  svg.addEventListener("pointercancel", endPointer);
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
    $("#pDeceased").checked = isDeceased(p);
    setSex(p.sex);
    setColor(p.color || "");
    pendingPhoto = p.photo || null;
    updatePhotoPreview();
    $("#personSubmit").textContent = "Save changes";
    $("#personCancel").hidden = false;
    $("#personDelete").hidden = false;
    $("#hideAboveBtn").disabled = false;
    $("#hideOneBtn").disabled = false;
    $("#hideOneBtn").textContent = isHidden(p.id) ? "Unhide this person" : "Hide this person";
    renderDocsForm(p);
  }
  function resetPersonForm() {
    $("#personId").value = "";
    $("#personForm").reset();
    setSex("male");
    pendingPhoto = null; updatePhotoPreview();
    setColor("");
    $("#personSubmit").textContent = "Add person";
    $("#personCancel").hidden = true;
    $("#personDelete").hidden = true;
    $("#hideAboveBtn").disabled = true;
    $("#hideOneBtn").disabled = true;
    $("#hideOneBtn").textContent = "Hide this person";
    renderDocsForm(null);
  }

  const docIcon = (k) => ({ link: "🔗", text: "📄", pdf: "📕", image: "🖼️" }[k] || "📄");
  function renderDocsForm(p) {
    const list = $("#docsList"), addBtn = $("#addDocBtn"), hint = $("#docsHint");
    list.innerHTML = "";
    if (!p) {
      addBtn.disabled = true;
      hint.textContent = "Add this person first, then reopen them to attach an obituary or record.";
      return;
    }
    addBtn.disabled = false;
    const docs = p.docs || [];
    if (!docs.length) hint.textContent = "Attach an obituary — paste the text, upload a PDF/photo, or save a link. Kept with the tree so it survives even if the original goes offline.";
    else hint.textContent = "";
    docs.forEach((doc) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="badge">${docIcon(doc.kind)}</span>
        <span class="t">${escapeHtml(doc.title || "Untitled")} <span class="kind">${doc.kind === "link" ? "link only" : doc.kind}</span></span>
        <button data-view>View</button><button class="rm" data-rm>✕</button>`;
      li.querySelector("[data-view]").onclick = () => openDocViewer(doc);
      li.querySelector("[data-rm]").onclick = () => {
        if (confirm("Remove this record?")) { p.docs = docs.filter((x) => x.id !== doc.id); save(); render(); renderDocsForm(p); }
      };
      list.appendChild(li);
    });
  }
  function setSex(s) {
    formSex = s;
    document.querySelectorAll("#sexToggle button").forEach((b) => b.classList.toggle("active", b.dataset.sex === s));
  }
  function buildColorSwatches() {
    const row = $("#colorRow");
    FAMILY_COLORS.forEach((c) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "swatch"; b.dataset.color = c; b.style.background = c; b.title = c;
      row.appendChild(b);
    });
    row.querySelectorAll(".swatch").forEach((b) => (b.onclick = () => setColor(b.dataset.color)));
  }
  function setColor(c) {
    formColor = c || "";
    document.querySelectorAll("#colorRow .swatch").forEach((b) => b.classList.toggle("sel", (b.dataset.color || "") === formColor));
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
    const data = { name: $("#pName").value.trim() || "Unnamed", birth: $("#pBirth").value, death: $("#pDeath").value, deceased: $("#pDeceased").checked, sex: formSex, color: formColor, photo: pendingPhoto };
    if (id) {
      const p = personById(id);
      Object.assign(p, { name: data.name, birth: num(data.birth), death: num(data.death), deceased: data.deceased, sex: data.sex, color: data.color || null, photo: data.photo });
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

  /* ============================================================ AI OBITUARY IMPORT */
  function openImportModal() {
    if (readonly) return;
    const saved = (function () { try { return localStorage.getItem("familyTree.importPass") || ""; } catch (e) { return ""; } })();
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = `<div class="modal"><h2>Import from an obituary</h2>
      <div class="hint">Claude reads the source and proposes people & relationships. Review before it’s added. Nothing is saved until you confirm.</div>
      <label class="field"><span>Import passcode</span><input type="password" id="imPass" placeholder="set in Vercel (IMPORT_PASSCODE)" value="${escapeHtml(saved)}"/></label>
      <label class="field"><span>Paste obituary text</span><textarea id="imText" rows="6" placeholder="Paste the obituary here…"></textarea></label>
      <label class="field"><span>…or a link to one</span><input type="text" id="imUrl" placeholder="https://…"/></label>
      <label class="field"><span>…or upload a PDF / photo</span><input type="file" id="imFile" accept="application/pdf,image/*"/></label>
      <div class="err" id="imErr" style="color:var(--divorce);font-size:12.5px;min-height:16px"></div>
      <div id="imStatus" class="hint"></div>
      <div class="btn-row"><button class="btn" data-cancel>Cancel</button><button class="btn primary" id="imGo">Read & preview</button></div></div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.querySelector("[data-cancel]").onclick = close;
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    const err = back.querySelector("#imErr");
    const status = back.querySelector("#imStatus");

    back.querySelector("#imGo").onclick = async () => {
      err.textContent = "";
      const pass = back.querySelector("#imPass").value.trim();
      const text = back.querySelector("#imText").value.trim();
      const url = back.querySelector("#imUrl").value.trim();
      const fileEl = back.querySelector("#imFile");
      if (!pass) { err.textContent = "Enter the import passcode."; return; }
      if (!text && !url && !fileEl.files[0]) { err.textContent = "Add some text, a link, or a file."; return; }
      try { localStorage.setItem("familyTree.importPass", pass); } catch (e) {}

      const payload = {
        passcode: pass, text, url,
        existing: state.persons.map((p) => ({ name: p.name, birth: p.birth, death: p.death })),
      };
      if (fileEl.files[0]) {
        const f = fileEl.files[0];
        if (f.size > 8 * 1024 * 1024) { err.textContent = "File is too large (max 8 MB)."; return; }
        payload.file = { mediaType: f.type, data: await fileToBase64(f) };
      }

      status.textContent = "Reading with Claude… this can take a moment.";
      back.querySelector("#imGo").disabled = true;
      try {
        const data = await callExtract(payload);
        const counts = countExtraction(data);
        if (!counts.people && !counts.couples && !counts.children) { err.textContent = "Nothing usable was found in that source."; status.textContent = ""; back.querySelector("#imGo").disabled = false; return; }
        if (confirm(`Add to the tree?\n\n• ${counts.people} people\n• ${counts.couples} couples\n• ${counts.children} parent–child links`)) {
          mergeExtraction(data);
          relayoutAndSave(); fitView();
          toast("Imported from obituary");
          close();
        } else {
          status.textContent = ""; back.querySelector("#imGo").disabled = false;
        }
      } catch (e2) {
        err.textContent = e2.message || "Import failed.";
        status.textContent = "";
        back.querySelector("#imGo").disabled = false;
      }
    };
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1]);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  async function callExtract(payload) {
    let res;
    try {
      res = await fetch("api/extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    } catch (e) { throw new Error("Couldn’t reach the import service."); }
    if (!res.ok) {
      let msg = "Import failed (" + res.status + ").";
      try { msg = (await res.json()).error || msg; } catch (e) {}
      if (res.status === 404) msg = "The import service isn’t available here — it needs the Vercel deployment.";
      throw new Error(msg);
    }
    return res.json();
  }

  function countExtraction(d) {
    return {
      people: (d.people || []).length,
      couples: (d.couples || []).length,
      children: (d.children || []).length,
    };
  }

  function mergeExtraction(d) {
    const keyToId = {};
    const findByName = (name) => state.persons.find((p) => p.name.trim().toLowerCase() === String(name || "").trim().toLowerCase());
    (d.people || []).forEach((pp) => {
      const ex = findByName(pp.name);
      if (ex) {
        keyToId[pp.key] = ex.id;
        if (ex.birth == null && pp.birthYear) ex.birth = num(pp.birthYear);
        if (ex.death == null && pp.deathYear) ex.death = num(pp.deathYear);
      } else {
        const np = addPerson({ name: pp.name || "Unnamed", sex: pp.sex || "unknown", birth: pp.birthYear, death: pp.deathYear });
        keyToId[pp.key] = np.id;
      }
    });
    const resolve = (ref) => {
      if (!ref) return null;
      if (keyToId[ref]) return keyToId[ref];
      const ex = findByName(ref);
      return ex ? ex.id : null;
    };
    const findUnion = (a, b) => state.unions.find((u) => (u.a === a && u.b === b) || (u.a === b && u.b === a));
    (d.couples || []).forEach((c) => {
      const a = resolve(c.a), b = resolve(c.b);
      if (!a) return;
      if (!findUnion(a, b)) addUnion(a, b, c.status || "married");
    });
    (d.children || []).forEach((ch) => {
      const child = resolve(ch.child); if (!child) return;
      const a = resolve(ch.parentA), b = resolve(ch.parentB);
      let u = findUnion(a, b);
      if (!u && a) u = addUnion(a, b || null, "married");
      if (u) addChild(u.id, child, ch.relationship === "adopted" ? "adopted" : "bio");
    });
  }

  /* ============================================================ OBITUARY / RECORD ATTACHMENTS */
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return "link"; } }

  function openAttachModal(personId) {
    const person = personById(personId); if (!person) return;
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = `<div class="modal"><h2>Attach obituary / record</h2>
      <div class="hint">Saved with the tree so it stays even if the original goes offline. Paste the text or upload a file for a durable copy — a link alone can be archived later.</div>
      <label class="field"><span>Title</span><input type="text" id="dTitle" placeholder="e.g. Obituary — Spitzer Funeral Home"/></label>
      <label class="field"><span>Link (optional)</span><input type="text" id="dUrl" placeholder="https://…"/></label>
      <div class="btn-row" style="justify-content:flex-start;margin:0 0 10px">
        <button type="button" class="btn" id="dFetch">⬇︎ Fetch &amp; archive text from link</button>
      </div>
      <label class="field"><span>Paste the text (durable copy)</span><textarea id="dText" rows="6" placeholder="Paste the obituary text here…"></textarea></label>
      <label class="field"><span>…or upload a PDF / photo / file</span><input type="file" id="dFile" accept="application/pdf,image/*,.txt,.html"/></label>
      <div class="err" id="dErr" style="color:var(--divorce);font-size:12.5px;min-height:16px"></div>
      <div class="hint" id="dStatus"></div>
      <div class="btn-row"><button class="btn" data-cancel>Cancel</button><button class="btn primary" id="dSave">Save record</button></div></div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.querySelector("[data-cancel]").onclick = close;
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    const err = back.querySelector("#dErr"), status = back.querySelector("#dStatus");

    back.querySelector("#dFetch").onclick = async () => {
      err.textContent = "";
      const url = back.querySelector("#dUrl").value.trim();
      if (!url) { err.textContent = "Enter a link first."; return; }
      let pass = ""; try { pass = localStorage.getItem("familyTree.importPass") || ""; } catch (e) {}
      if (!pass) pass = prompt("Import passcode (set as IMPORT_PASSCODE in Vercel):") || "";
      if (!pass) return;
      try { localStorage.setItem("familyTree.importPass", pass); } catch (e) {}
      status.textContent = "Fetching…";
      try {
        const data = await callArchive({ passcode: pass, url });
        if (!back.querySelector("#dTitle").value.trim()) back.querySelector("#dTitle").value = data.title || "";
        back.querySelector("#dText").value = data.text || "";
        status.textContent = "Fetched — review and Save.";
      } catch (e2) { err.textContent = e2.message; status.textContent = ""; }
    };

    back.querySelector("#dSave").onclick = async () => {
      err.textContent = "";
      const title = back.querySelector("#dTitle").value.trim();
      const url = back.querySelector("#dUrl").value.trim();
      const text = back.querySelector("#dText").value.trim();
      const file = back.querySelector("#dFile").files[0];
      let kind = "link", content = "";
      if (file) {
        if (file.size > 8 * 1024 * 1024) { err.textContent = "File is too large (max 8 MB)."; return; }
        if (file.type === "application/pdf") { kind = "pdf"; content = "data:application/pdf;base64," + (await fileToBase64(file)); }
        else if (file.type.startsWith("image/")) { kind = "image"; content = "data:" + file.type + ";base64," + (await fileToBase64(file)); }
        else { kind = "text"; content = await file.text(); }
      } else if (text) { kind = "text"; content = text; }
      else if (url) { kind = "link"; content = ""; }
      else { err.textContent = "Add some text, a file, or a link."; return; }

      const doc = { id: uid(), title: title || (url ? hostOf(url) : "Record"), url, capturedAt: todayStr(), kind, content };
      if (!person.docs) person.docs = [];
      person.docs.push(doc);
      save(); render(); renderDocsForm(person);
      close(); toast("Record attached");
    };
  }

  async function callArchive(payload) {
    let res;
    try { res = await fetch("api/archive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); }
    catch (e) { throw new Error("Couldn’t reach the archive service."); }
    if (!res.ok) {
      let msg = "Fetch failed (" + res.status + ").";
      try { msg = (await res.json()).error || msg; } catch (e) {}
      if (res.status === 404) msg = "Fetching a link needs the Vercel deployment — for now, paste the text or upload a file.";
      throw new Error(msg);
    }
    return res.json();
  }

  function openDocsForPerson(id) {
    const p = personById(id); if (!p || !p.docs || !p.docs.length) return;
    selectPerson(id);
    if (p.docs.length === 1) { openDocViewer(p.docs[0]); return; }
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = `<div class="modal"><h2>${escapeHtml(p.name)} — records</h2><ul class="docs-list" id="chooseList"></ul>
      <div class="btn-row"><button class="btn primary" data-cancel>Close</button></div></div>`;
    document.body.appendChild(back);
    back.querySelector("[data-cancel]").onclick = () => back.remove();
    back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
    const ul = back.querySelector("#chooseList");
    p.docs.forEach((doc) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="badge">${docIcon(doc.kind)}</span><span class="t">${escapeHtml(doc.title || "Untitled")}</span><button data-view>View</button>`;
      li.querySelector("[data-view]").onclick = () => { back.remove(); openDocViewer(doc); };
      ul.appendChild(li);
    });
  }

  function openDocViewer(doc) {
    let bodyHtml;
    if (doc.kind === "text") bodyHtml = `<pre>${escapeHtml(doc.content || "")}</pre>`;
    else if (doc.kind === "pdf") bodyHtml = `<iframe src="${doc.content}"></iframe>`;
    else if (doc.kind === "image") bodyHtml = `<img src="${doc.content}" alt=""/>`;
    else bodyHtml = `<p class="hint">No archived copy is saved yet — open the original above, or edit this record to paste the text or upload a PDF for a permanent copy.</p>`;
    const srcLine = (doc.url ? `<a href="${escapeHtml(doc.url)}" target="_blank" rel="noopener">View original listing ↗</a> · ` : "") + "saved " + (doc.capturedAt || "");
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = `<div class="modal doc-view"><h2>${escapeHtml(doc.title || "Record")}</h2>
      <div class="src">${srcLine}</div>${bodyHtml}
      <div class="btn-row">${doc.kind !== "link" ? '<button class="btn" data-dl>⬇︎ Download</button>' : ""}<button class="btn primary" data-cancel>Close</button></div></div>`;
    document.body.appendChild(back);
    back.querySelector("[data-cancel]").onclick = () => back.remove();
    back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
    const dl = back.querySelector("[data-dl]");
    if (dl) dl.onclick = () => downloadDoc(doc);
  }

  function downloadDoc(doc) {
    const base = (doc.title || "record").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "record";
    if (doc.kind === "text") { downloadFile(base + ".txt", doc.content || "", "text/plain"); return; }
    const a = document.createElement("a");
    a.href = doc.content;
    a.download = base + (doc.kind === "pdf" ? ".pdf" : "");
    a.click();
  }

  /* ============================================================ IMPORT/EXPORT/SAVE */
  function exportObject() {
    return { title: state.title, subtitle: state.subtitle, persons: state.persons, unions: state.unions, links: state.links, manual: state.manual, hidden: state.hidden, focus: state.focus };
  }
  function loadObject(obj) {
    state = Object.assign(blankState(), {
      title: obj.title || "Family Tree", subtitle: obj.subtitle || "",
      persons: obj.persons || [], unions: obj.unions || [], links: obj.links || [], manual: obj.manual || {}, hidden: obj.hidden || {},
      focus: Array.isArray(obj.focus) ? obj.focus : [],
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
  function updateHiddenChip() {
    const chip = $("#hiddenChip");
    const n = state.hidden ? Object.keys(state.hidden).length : 0;
    chip.hidden = n === 0;
    chip.textContent = "Show all (" + n + " hidden)";
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
  $("#importObitBtn").onclick = openImportModal;
  $("#addDocBtn").onclick = () => { const id = $("#personId").value; if (id) openAttachModal(id); };
  $("#hideAboveBtn").onclick = () => {
    const id = $("#personId").value; if (!id) return;
    const p = personById(id);
    hideAbove(id); relayoutAndSave(); fitView();
    toast("Hid everyone above " + (p ? p.name.split(" ")[0] : "this person"));
  };
  $("#hideOneBtn").onclick = () => {
    const id = $("#personId").value; if (!id) return;
    toggleHidden(id);
    $("#hideOneBtn").textContent = isHidden(id) ? "Unhide this person" : "Hide this person";
    relayoutAndSave(); fitView();
  };
  $("#hiddenChip").onclick = () => { showAll(); relayoutAndSave(); fitView(); toast("Showing everyone"); };
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
    // On phones, start with a clean tree-first view: panel tucked away, legend
    // collapsed. The ✎ button re-opens the editor / people list.
    if (window.matchMedia && window.matchMedia("(max-width: 720px)").matches) {
      $("#panel").classList.add("collapsed");
      const l = $("#legend"); if (l) { l.classList.add("min"); const t = $("#legendToggle"); if (t) t.textContent = "+"; }
    }
    autoLayout(); render(); syncTitle();
    // Open centred on the chosen people (e.g. Peter & Alicen) if the tree names
    // any that are visible; otherwise fit the whole tree to the screen.
    const focus = (state.focus || []).filter((id) => personById(id) && !isHidden(id));
    if (focus.length) focusView(focus); else fitView();
  }

  function init() {
    buildColorSwatches();
    setSex("male");
    setColor("");
    renderDocsForm(null);
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
    else if (window.FAMILY_TREE_STARTER && typeof window.FAMILY_TREE_STARTER === "object") loadObject(window.FAMILY_TREE_STARTER);
    boot();
  }

  init();
})();
