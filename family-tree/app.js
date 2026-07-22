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
  const XLINKNS = "http://www.w3.org/1999/xlink";
  const STORE_KEY = "familyTree.v1";

  /* ---- layout constants ---- */
  const COLW = 168;   // horizontal spacing between two people
  const ROWH = 250;   // vertical spacing between generations
  const CLUSTER_GAP = COLW * 0.7; // min horizontal gap between unrelated family clusters
  const FAM_GAP = COLW * 0.7;     // extra breathing room between different surname families
  const SIDE_GAP = COLW * 1.4;    // extra breathing room between the two sides (each spouse's relatives)
  const HALF = 46;    // half the visual footprint of a shape

  /* ---------------------------------------------------------------- state */
  let state = blankState();
  let layoutPos = {};        // computed positions {id:{x,y}}
  let busLevels = {};        // per-union descent-bus vertical level (avoid overlap)
  let selectedId = null;
  let readonly = false;
  let rearrange = false;     // "Rearrange" mode — people only move while this is on
  let selection = new Set(); // ids selected by the marquee box (for group moves)
  let marquee = null;        // {x0,y0,x1,y1} world-coords while dragging a select box
  let undoStack = [];        // snapshots for Cmd/Ctrl+Z
  let redoStack = [];
  let view = { tx: 0, ty: 0, scale: 1 };
  let pendingPhoto = null;   // dataURL staged in the person form
  let formSex = "male";
  let formColor = "";
  const FAMILY_COLORS = ["#2f6fb0", "#9e6b3f", "#3f8f5a", "#2a9d9d", "#bf8b30", "#b5495b", "#8a4f80"];

  function blankState() {
    return { title: "Family Tree", subtitle: "", persons: [], unions: [], links: [], manual: {}, hidden: {}, focus: [], version: 0 };
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
    const p = { id: uid(), name: data.name || "Unnamed", birth: num(data.birth), death: num(data.death), birthDate: data.birthDate || null, deathDate: data.deathDate || null, deceased: !!data.deceased, sex: data.sex || "unknown", color: data.color || null, photo: data.photo || null, docs: data.docs || [] };
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
    // (3) contiguity, two levels:
    //   • BLOOD SIDE (coarse): everyone reachable by blood from one person — so a
    //     married couple's two whole sides never interleave (all of Peter's
    //     relatives — his dad's Hauck line AND his mom's Boyd/Eide line — stay on
    //     one side; all of Alicen's Fuchs/Miller relatives stay on the other).
    //   • SURNAME family (fine): within a side, keep each surname line together.
    // A couple that bridges two groups is anchored to whichever partner has more
    // siblings, so it stays next to that partner's brothers and sisters and lands
    // at the edge nearest the family they married into.
    const componentId = {};
    lineageComponents(cPersons, cUnions, cLinks, uById).forEach((set, i) => set.forEach((id) => (componentId[id] = i)));
    const unionKids = {};
    cLinks.forEach((l) => { unionKids[l.union] = (unionKids[l.union] || 0) + 1; });
    const sibCount = (id) => { const u = primaryUnion[id]; return u ? (unionKids[u] || 1) : 0; };
    // key a cluster by whichever member has the most siblings (its "home" group)
    const anchorKey = (c, bary, groupOf) => {
      let best = null, bestScore = -1;
      for (const id of c.ids) {
        const g = groupOf[id];
        if (g == null || !(g in bary)) continue;
        const s = sibCount(id);
        if (s > bestScore) { bestScore = s; best = g; }
      }
      return best != null ? bary[best] : null;
    };
    const baryOf = (groupOf) => {
      const acc = {}, cnt = {};
      for (const id in colIndex) { const g = groupOf[id]; if (g == null) continue; acc[g] = (acc[g] || 0) + colIndex[id]; cnt[g] = (cnt[g] || 0) + 1; }
      const bary = {}; for (const g in acc) bary[g] = acc[g] / cnt[g];
      return bary;
    };
    for (let pass = 0; pass < 4; pass++) {
      const compBary = baryOf(componentId), famBary = baryOf(familyId);
      for (let g = 0; g <= maxGen; g++) {
        order[g].forEach((c, i) => {
          const ck = anchorKey(c, compBary, componentId);
          const fk = anchorKey(c, famBary, familyId);
          c._compB = ck != null ? ck : i;
          c._famB = fk != null ? fk : i;
          c._inB = c.ids[0] in colIndex ? colIndex[c.ids[0]] : i;
        });
        order[g] = stableSort(order[g], (a, b) => (a._compB - b._compB) || (a._famB - b._famB) || (a._inB - b._inB));
        reindex();
      }
    }
    // (4) orient each couple so each partner sits toward their OWN parents. When
    // two families meet at a marriage (e.g. Harlan Fuchs married Darleen Miller),
    // this puts each spouse under their own side so the two descent lines drop
    // straight down instead of crossing over each other.
    order.forEach((cls) => cls.forEach((c) => {
      if (c.ids.length !== 2) return;
      const parentCol = (id) => {
        const ps = parentsOf[id] || []; let s = 0, n = 0;
        ps.forEach((pp) => { if (pp in colIndex) { s += colIndex[pp]; n++; } });
        return n ? s / n : null;
      };
      const a = c.ids[0], b = c.ids[1];
      const ka = parentCol(a), kb = parentCol(b);
      if (ka == null || kb == null) return;   // only decide when both have parents shown
      if (ka > kb) { c.ids = [b, a]; c.offset = { [b]: 0, [a]: COLW }; }
      else { c.offset = { [a]: 0, [b]: COLW }; }
    }));
    reindex();

    // assign x coordinates, cluster granularity, refined toward neighbours.
    // Favour clarity over compactness: leave extra space between different
    // surname families, and more between the two sides, so each group reads as
    // its own cluster with clear whitespace around it.
    const memberX = (c, id) => c.x + c.offset[id];
    const cFam = (c) => { for (const id of c.ids) if (familyId[id] != null) return familyId[id]; return -1; };
    const cComp = (c) => { for (const id of c.ids) if (componentId[id] != null) return componentId[id]; return -1; };
    const gapBetween = (a, b) => {
      if (!a) return CLUSTER_GAP;
      if (cComp(a) !== cComp(b)) return CLUSTER_GAP + SIDE_GAP;
      if (cFam(a) !== cFam(b)) return CLUSTER_GAP + FAM_GAP;
      return CLUSTER_GAP;
    };
    const assignCoords = () => {
      order.forEach((cls) => {
        let x = 0, prev = null;
        cls.forEach((c) => { x += prev ? gapBetween(prev, c) - CLUSTER_GAP : 0; c.x = x; x += c.width + CLUSTER_GAP; prev = c; });
      });
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
          let prevRight = -Infinity, prevC = null;
          order[g].forEach((c) => {
            const gap = gapBetween(prevC, c);
            let nx = c._desired;
            if (nx < prevRight + gap) nx = prevRight + gap;
            c.x = nx; prevRight = c.x + c.width; prevC = c;
          });
        });
      }
    };
    assignCoords();

    // (5) Second pass — reorder each SIBLING set so the sibling whose line
    // continues toward a marriage that bridges two families (e.g. William, whose
    // grandson Peter marries into Alicen's family) sits on the edge nearest that
    // marriage, and childless collaterals fall back to the family's own side
    // instead of crowding the boundary with the in-laws. Uses the first pass's
    // real positions, then lays out once more.
    const prelimX = {};
    order.forEach((cls) => cls.forEach((c) => c.ids.forEach((id) => (prelimX[id] = c.x + c.offset[id]))));
    // which OTHER family each spouse marries into, and where each family sits
    const compCenter = {};
    { const acc = {}, cnt = {}; for (const id in prelimX) { const c = componentId[id]; if (c == null) continue; acc[c] = (acc[c] || 0) + prelimX[id]; cnt[c] = (cnt[c] || 0) + 1; } for (const c in acc) compCenter[c] = acc[c] / cnt[c]; }
    const mateComp = {};
    cUnions.forEach((u) => {
      if (u.b == null) return;
      const ca = componentId[u.a], cb = componentId[u.b];
      if (ca != null && cb != null && ca !== cb) { mateComp[u.a] = cb; mateComp[u.b] = ca; }
    });
    // reachOf(person) → where a marriage below them points (the in-law family's
    // centre), summed over descendants. n>0 means "this line continues down to a
    // marriage that joins another family."
    const reachMemo = {};
    const reachOf = (id) => {
      if (id in reachMemo) return reachMemo[id];
      let sum = 0, n = 0;
      if (mateComp[id] != null && (mateComp[id] in compCenter)) { sum += compCenter[mateComp[id]]; n++; }
      (childrenOf[id] || []).forEach((k) => { const r = reachOf(k); sum += r.sum; n += r.n; });
      return reachMemo[id] = { sum, n };
    };
    const ownX = (c) => { let s = 0, m = 0; c.ids.forEach((id) => { if (id in prelimX) { s += prelimX[id]; m++; } }); return m ? s / m : 0; };
    const clusterTarget = (c) => { let sum = 0, n = 0; c.ids.forEach((id) => { const r = reachOf(id); sum += r.sum; n += r.n; }); return n ? { v: sum / n, bridge: true } : { v: ownX(c), bridge: false }; };
    // group a cluster with its surname family (by the member with most siblings)
    const clusterFamAnchor = (c) => {
      let best = null, bestScore = -1;
      for (const id of c.ids) { const f = familyId[id]; if (f == null) continue; const s = sibCount(id); if (s > bestScore) { bestScore = s; best = f; } }
      return best;
    };
    // Within each surname family at a generation, put the branch that continues
    // toward the in-law family on the side facing that family, and the childless
    // collaterals on the far side — so e.g. William's line faces Alicen's family
    // while his siblings fall back onto Peter's side instead of crowding the
    // boundary with the in-laws.
    for (let g = 1; g <= maxGen; g++) {
      const arr = order[g];
      let i = 0;
      while (i < arr.length) {
        const f = clusterFamAnchor(arr[i]);
        let j = i; while (j < arr.length && clusterFamAnchor(arr[j]) === f) j++;
        if (f != null && j - i > 1) {
          const run = arr.slice(i, j).map((c) => ({ c, t: clusterTarget(c), x: ownX(c) }));
          const bridge = run.filter((r) => r.t.bridge), plain = run.filter((r) => !r.t.bridge);
          bridge.sort((a, b) => a.x - b.x); plain.sort((a, b) => a.x - b.x);
          let merged;
          if (bridge.length && plain.length) {
            const bt = bridge.reduce((s, r) => s + r.t.v, 0) / bridge.length;   // where the in-laws are
            const fc = run.reduce((s, r) => s + r.x, 0) / run.length;           // this family's centre
            merged = bt >= fc ? [...plain, ...bridge] : [...bridge, ...plain];  // continuing branch faces the in-laws
          } else {
            merged = run.sort((a, b) => a.x - b.x);
          }
          for (let k = i; k < j; k++) arr[k] = merged[k - i].c;
        }
        i = j;
      }
    }
    reindex();
    assignCoords();

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

    busLevels = computeBusLevels();
    visibleUnions().forEach(renderUnion);
    visiblePersons().forEach(renderPerson);
    renderHiddenBadges();
    updatePeopleList();
    $("#peopleCount").textContent = state.persons.length;
    updateHiddenChip();
  }

  function el(tag, attrs, children) {
    const e = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) if (attrs[k] != null) {
      e.setAttribute(k, attrs[k]);
      // iOS Safari won't load an <image> from a plain href — it needs the
      // namespaced xlink:href too. Set both so photos render everywhere.
      if (k === "href") e.setAttributeNS(XLINKNS, "xlink:href", attrs[k]);
    }
    if (children) (Array.isArray(children) ? children : [children]).forEach((c) => c && e.appendChild(c));
    return e;
  }

  function renderPerson(p) {
    const pos = posOf(p.id);
    const g = el("g", { class: "person" + (p.id === selectedId ? " selected" : "") + (selection.has(p.id) ? " multi" : ""), transform: `translate(${pos.x},${pos.y})`, "data-id": p.id });
    // Hover tooltip carries the exact dates when known (the label stays year-only).
    if (p.birthDate || p.deathDate) {
      const tip = [p.name];
      if (p.birthDate) tip.push("Born " + fmtDate(p.birthDate));
      if (p.deathDate) tip.push("Died " + fmtDate(p.deathDate));
      g.appendChild(el("title", null, txt(tip.join("\n"))));
    }

    const clip = { male: "clip-male", female: "clip-female", unknown: "clip-unknown" }[p.sex] || "clip-unknown";
    const decd = isDeceased(p);
    if (p.photo) {
      // For a photo, the deceased slash goes BEHIND the picture so it never
      // crosses the face — only its tips peek out past the edges.
      if (decd) g.appendChild(el("line", { class: "deceased", x1: -HALF - 9, y1: HALF + 9, x2: HALF + 9, y2: -HALF - 9 }));
      g.appendChild(el("image", { href: p.photo, x: -HALF, y: -HALF, width: HALF * 2, height: HALF * 2, preserveAspectRatio: "xMidYMid slice", "clip-path": `url(#${clip})` }));
    } else {
      g.appendChild(el("text", { class: "placeholder-emoji", x: 0, y: 2 }, txt("👤")));
    }
    // shape outline on top
    g.appendChild(shapeOutline(p.sex, !!p.photo, p.color));
    // deceased slash — drawn across the empty symbol (the classic mark) only when
    // there's no photo; photo nodes get the behind-the-picture version above.
    if (decd && !p.photo) g.appendChild(el("line", { class: "deceased", x1: -HALF, y1: HALF, x2: HALF, y2: -HALF }));

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

    // attached obituaries/records — a small, refined page badge (not an emoji)
    if (p.docs && p.docs.length) {
      const badge = el("g", { class: "doc-badge", "data-id": p.id, transform: `translate(${HALF - 5},${-HALF + 5})` });
      badge.appendChild(el("circle", { class: "doc-badge-bg", r: 9, cx: 0, cy: 0 }));
      // a minimal document glyph: a page with a folded corner and two text lines
      badge.appendChild(el("path", { class: "doc-badge-mark", d: "M-3 -4.4 H1.4 L3 -2.8 V4.4 H-3 Z M1.2 -4.4 V-2.8 H3", fill: "none" }));
      badge.appendChild(el("line", { class: "doc-badge-mark", x1: -1.4, y1: 0, x2: 1.4, y2: 0 }));
      badge.appendChild(el("line", { class: "doc-badge-mark", x1: -1.4, y1: 2, x2: 1.4, y2: 2 }));
      badge.appendChild(el("title", null, txt(p.docs.length + " attached record" + (p.docs.length > 1 ? "s" : ""))));
      g.appendChild(badge);
    }

    gNodes.appendChild(g);
  }

  function shapeOutline(sex, hasPhoto, color) {
    const fill = hasPhoto ? "none" : "var(--node-fill)";
    // Build an inline style: it beats the `.person .shape { fill: … }` CSS rule,
    // which would otherwise paint the node fill OVER a photo and hide it. So for
    // a photo node we force fill:none here, and it also carries the family colour.
    const parts = [];
    if (color) parts.push("stroke:" + color, "stroke-width:3.4");
    if (hasPhoto) parts.push("fill:none");
    const style = parts.length ? parts.join(";") : null;
    if (sex === "female") return el("circle", { class: "shape", r: 41, cx: 0, cy: 0, fill, style });
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

  // "1906-07-05" → "July 5, 1906" (parsed by parts to avoid timezone drift).
  function fmtDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ""); if (!m) return iso || "";
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return months[+m[2] - 1] + " " + (+m[3]) + ", " + m[1];
  }
  function dateStr(p) {
    if (p.birth != null && p.death != null) return p.birth + "–" + p.death;
    if (p.birth != null) return "b. " + p.birth + (isDeceased(p) ? " · d." : "");
    if (p.death != null) return "d. " + p.death;
    if (p.deceased) return "deceased";
    return "";
  }

  // The x-range a couple's descent "bus" needs to span (drop point → children).
  function busSpan(u) {
    const pa = personById(u.a); if (!pa) return null;
    const pb = u.b != null ? personById(u.b) : null;
    const kids = childLinksOfUnion(u.id).map((l) => l.child).filter((c) => personById(c) && !isHidden(c));
    if (!kids.length) return null;
    const A = posOf(u.a), B = pb ? posOf(u.b) : null;
    const midY = pb ? (A.y + B.y) / 2 : A.y;
    const xs = kids.map((c) => posOf(c).x);
    let dropX = pb ? (A.x + B.x) / 2 : A.x;
    if (pb) {
      const kc = xs.reduce((s, x) => s + x, 0) / xs.length;
      const lo = Math.min(A.x, B.x) + HALF, hi = Math.max(A.x, B.x) - HALF;
      dropX = hi >= lo ? Math.max(lo, Math.min(hi, kc)) : dropX;
    }
    return { midY, dropX, min: Math.min(dropX, ...xs), max: Math.max(dropX, ...xs) };
  }

  // Give each couple's descent bus a vertical level so two buses in the same
  // generation whose spans overlap never share one horizontal line (which would
  // read as two lines overlapping for a stretch). Greedy interval colouring,
  // per generation; non-overlapping buses happily share level 0.
  function computeBusLevels() {
    const rows = {};
    visibleUnions().forEach((u) => {
      const s = busSpan(u); if (!s) return;
      const key = Math.round(s.midY);
      (rows[key] = rows[key] || []).push({ id: u.id, min: s.min, max: s.max });
    });
    const out = {};
    Object.values(rows).forEach((arr) => {
      arr.sort((a, b) => a.min - b.min);
      const placed = [];
      arr.forEach((iv) => {
        const taken = new Set();
        placed.forEach((p) => { if (p.max >= iv.min - COLW * 0.35 && p.min <= iv.max + COLW * 0.35) taken.add(p.level); });
        let lvl = 0; while (taken.has(lvl)) lvl++;
        out[iv.id] = lvl;
        placed.push({ min: iv.min, max: iv.max, level: lvl });
      });
    });
    return out;
  }

  // A little "+" button that appears on hover over a union's lines, to quickly
  // add a child / sibling to that couple. Hidden until the union group is hovered
  // (see CSS); clicks are caught in the pointerdown handler via the .add-plus class.
  function addPlus(unionId, x, y, label, personId) {
    const g = el("g", { class: "add-plus", "data-union": unionId, "data-person": personId || "", transform: `translate(${x},${y})` });
    g.appendChild(el("circle", { class: "add-plus-bg", r: 11, cx: 0, cy: 0 }));
    g.appendChild(el("line", { class: "add-plus-mark", x1: -5, y1: 0, x2: 5, y2: 0 }));
    g.appendChild(el("line", { class: "add-plus-mark", x1: 0, y1: -5, x2: 0, y2: 5 }));
    g.appendChild(el("title", null, txt(label)));
    return g;
  }

  // Quick-add a child to a union: drop in a blank person, link them, and open the
  // form focused on the name so you just type and Save. Undoable.
  // ---- placing newly-added people next to their family (instead of off in auto-land) ----
  const hasPos = (id) => !!(state.manual[id] || layoutPos[id]);
  // Shift everyone at/right of x rightward by `width`, keeping their relative
  // positions, so a gap opens at x. Pins them so the shift survives re-layout.
  function makeRoomAt(x, width, exceptIds) {
    visiblePersons().forEach((p) => {
      if (exceptIds && exceptIds.has(p.id)) return;
      const q = posOf(p.id);
      if (q.x >= x) state.manual[p.id] = { x: q.x + width, y: q.y };
    });
  }
  const spotOccupied = (x, y, exceptId) => visiblePersons().some((p) => p.id !== exceptId && Math.abs(posOf(p.id).x - x) < COLW * 0.85 && Math.abs(posOf(p.id).y - y) < ROWH * 0.55);
  // Pin `id` at (x,y); if that spot is taken, open room by shifting the right side over.
  function placeAt(id, x, y) {
    if (spotOccupied(x, y, id)) makeRoomAt(x - COLW * 0.5, COLW, new Set([id]));
    state.manual[id] = { x, y };
  }
  const isManual = (id) => !!(id && state.manual && state.manual[id]);
  // A new child goes next to the rightmost sibling (same row), or — if the first —
  // centred one row below the parents. Only pins a spot when that family is
  // MANUALLY arranged; for a purely auto-laid-out family, auto-layout already
  // places siblings correctly, so we leave the newcomer to it.
  function placeNewChild(u, childId) {
    const sibs = childLinksOfUnion(u.id).map((l) => l.child).filter((c) => c !== childId && personById(c) && !isHidden(c));
    if (sibs.length) {
      const right = sibs.reduce((r, c) => (posOf(c).x > posOf(r).x ? c : r), sibs[0]);
      if (!isManual(right)) return;
      const rp = posOf(right); placeAt(childId, rp.x + COLW, rp.y);
    } else {
      if (!isManual(u.a) && !isManual(u.b)) return;
      const A = posOf(u.a), B = u.b != null ? posOf(u.b) : null;
      const x = B ? (A.x + B.x) / 2 : A.x;
      const y = (B ? Math.max(A.y, B.y) : A.y) + ROWH;
      placeAt(childId, x, y);
    }
  }
  // Place a batch of freshly-imported people relative to whoever is already placed:
  // children under their parents/siblings, spouses beside partners, parents above
  // their children — iterating until nothing new can be anchored.
  function placeNewPeople(ids) {
    const pending = new Set(ids.filter((id) => personById(id) && !isHidden(id)));
    let progress = true;
    while (pending.size && progress) {
      progress = false;
      for (const id of [...pending]) {
        const pu = parentLinksOfPerson(id).map((l) => unionById(l.union)).find((u) => u && [u.a, u.b].filter(Boolean).some((pid) => !pending.has(pid) && hasPos(pid)));
        if (pu) { placeNewChild(pu, id); pending.delete(id); progress = true; continue; }
        const su = state.unions.find((u) => (u.a === id || u.b === id) && (() => { const o = u.a === id ? u.b : u.a; return o && !pending.has(o) && hasPos(o); })());
        if (su) { const o = su.a === id ? su.b : su.a; if (isManual(o)) { const op = posOf(o); placeAt(id, op.x + COLW, op.y); } pending.delete(id); progress = true; continue; }
        const kl = state.links.find((l) => { const u = unionById(l.union); return u && (u.a === id || u.b === id) && !pending.has(l.child) && hasPos(l.child); });
        if (kl) { if (isManual(kl.child)) { const kp = posOf(kl.child); placeAt(id, kp.x, kp.y - ROWH); } pending.delete(id); progress = true; continue; }
      }
    }
    // whatever's left (isolated new clusters) falls back to auto-layout
  }

  function quickAddChild(unionId) {
    if (readonly) return;
    const u = unionById(unionId); if (!u) return;
    pushUndo();
    const np = addPerson({ name: "New person", sex: "unknown" });
    addChild(u.id, np.id, "bio");
    placeNewChild(u, np.id);   // slot in next to siblings / below the parents
    selectedId = np.id;
    relayoutAndSave();
    ensurePanel(); fillPersonForm(np);
    const nameEl = $("#pName"); if (nameEl) { nameEl.focus(); nameEl.select(); }
    toast("Added — type their name and Save");
  }

  // ---- shared add-a-relative actions (used by the tree + menu and the profile) ----
  const guessSpouseSex = (p) => (p && p.sex === "male") ? "female" : (p && p.sex === "female") ? "male" : "unknown";
  // Focus a freshly-added blank person so you can just type their name and Save.
  function focusNewPerson(np, msg) {
    selectedId = np.id;
    relayoutAndSave();
    ensurePanel(); fillPersonForm(np);
    const nameEl = $("#pName"); if (nameEl) { nameEl.focus(); nameEl.select(); }
    toast(msg || "Added — type their name and Save");
  }

  // Add a NEW blank spouse/partner beside a person and open them for naming.
  function quickAddSpouse(personId) {
    if (readonly) return;
    const p = personById(personId); if (!p) return;
    pushUndo();
    const sp = addPerson({ name: "New spouse", sex: guessSpouseSex(p) });
    addUnion(personId, sp.id, "married");
    if (isManual(personId)) { const pp = posOf(personId); placeAt(sp.id, pp.x + COLW, pp.y); }
    focusNewPerson(sp, "Added spouse — type their name and Save");
  }

  // Add a NEW blank child of a person (their own union; make a solo one if none).
  function quickAddChildOf(personId) {
    if (readonly) return;
    const p = personById(personId); if (!p) return;
    pushUndo();
    let u = unionsOfPerson(personId)[0];
    if (!u) u = addUnion(personId, null, "married");
    const np = addPerson({ name: "New person", sex: "unknown" });
    addChild(u.id, np.id, "bio");
    placeNewChild(u, np.id);
    focusNewPerson(np);
  }

  const shortName = (n) => { const s = (n || "").replace(/["'()]/g, "").trim(); return s.split(/\s+/)[0] || s || "them"; };

  // A little floating menu on the tree + : Sibling / Spouse / Child, anchored to the
  // person the + sits beside (so "spouse" and "child" act on the right person).
  function onAwayAddMenu(e) { if (!(e.target.closest && e.target.closest("#addMenu"))) closeAddMenu(); }
  function closeAddMenu() { const m = $("#addMenu"); if (m) m.remove(); document.removeEventListener("pointerdown", onAwayAddMenu, true); }
  function openAddMenu(unionId, personId, clientX, clientY) {
    if (readonly) return;
    closeAddMenu();
    const p = personById(personId);
    const nm = p ? escapeHtml(shortName(p.name)) : "this person";
    const items = [
      { label: "＋ Sibling", sub: "another child of the same parents", act: () => quickAddChild(unionId) },
      { label: "＋ Spouse / partner", sub: "a couple line for " + nm, act: () => quickAddSpouse(personId) },
      { label: "＋ Child", sub: nm + "’s child", act: () => quickAddChildOf(personId) },
    ];
    const menu = document.createElement("div");
    menu.id = "addMenu"; menu.className = "add-menu";
    menu.innerHTML = items.map((it, i) => `<button type="button" data-i="${i}"><b>${it.label}</b><span>${it.sub}</span></button>`).join("");
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    const x = Math.max(8, Math.min(clientX, window.innerWidth - r.width - 8));
    const y = Math.max(8, Math.min(clientY, window.innerHeight - r.height - 8));
    menu.style.left = x + "px"; menu.style.top = y + "px";
    menu.querySelectorAll("button").forEach((b) => (b.onclick = () => { const it = items[+b.getAttribute("data-i")]; closeAddMenu(); it.act(); }));
    setTimeout(() => document.addEventListener("pointerdown", onAwayAddMenu, true), 0);
  }

  function renderUnion(u) {
    const pa = personById(u.a); if (!pa) return;
    const pb = u.b != null ? personById(u.b) : null;
    const A = posOf(u.a), B = pb ? posOf(u.b) : null;
    const kids = childLinksOfUnion(u.id).map((l) => ({ l, p: personById(l.child) })).filter((k) => k.p && !isHidden(k.p.id));
    const gu = el("g", { class: "union", "data-union": u.id });   // group so hover reveals the +

    let midX, midY, dropTop;
    if (pb) {
      const y = (A.y + B.y) / 2;
      const left = A.x < B.x ? A : B, right = A.x < B.x ? B : A;
      const dashed = u.status === "partners";
      gu.appendChild(el("line", { class: "link", x1: left.x + HALF - 6, y1: y, x2: right.x - HALF + 6, y2: y, "stroke-dasharray": dashed ? "6 5" : null }));
      midX = (A.x + B.x) / 2; midY = y; dropTop = y;
      if (u.status === "divorced") {
        [-7, 5].forEach((dx) => gu.appendChild(el("line", { class: "divorce-tick", x1: midX + dx + 5, y1: midY - 11, x2: midX + dx - 5, y2: midY + 11 })));
      }
    } else {
      midX = A.x; midY = A.y; dropTop = A.y + HALF; // drop from the single parent's bottom
    }

    if (!kids.length) {
      // Childless couple: a transparent stub below the couple makes a hover target,
      // and the + adds their first child.
      if (!readonly) {
        gu.appendChild(el("line", { class: "hit", x1: midX, y1: dropTop, x2: midX, y2: dropTop + 40 }));
        gu.appendChild(addPlus(u.id, midX, dropTop + 34, "Add a child"));
      }
      gLinks.appendChild(gu);
      return;
    }

    // Colour the descent lines by the children's family so each set of lines is
    // traceable at a glance instead of a grey tangle.
    const famColor = kids.map((k) => k.p.color).find(Boolean) || (pa && pa.color) || (pb && pb.color) || null;
    const cstyle = famColor ? "stroke:" + famColor + ";stroke-width:2.8" : null;

    const childTops = kids.map((k) => ({ x: posOf(k.p.id).x, top: posOf(k.p.id).y - HALF - 8, type: k.l.type }));
    const dropX = midX;
    const busY = midY + 120 + (busLevels[u.id] || 0) * 15;
    gu.appendChild(el("line", { class: "link", x1: dropX, y1: dropTop, x2: dropX, y2: busY, style: cstyle }));
    const minX = Math.min(dropX, ...childTops.map((c) => c.x));
    const maxX = Math.max(dropX, ...childTops.map((c) => c.x));
    if (childTops.length > 1 || minX !== maxX)
      gu.appendChild(el("line", { class: "link", x1: minX, y1: busY, x2: maxX, y2: busY, style: cstyle }));
    childTops.forEach((c) => {
      gu.appendChild(el("line", { class: "link" + (c.type === "adopted" ? " adopt" : ""), x1: c.x, y1: busY, x2: c.x, y2: c.top, style: c.type === "adopted" ? null : cstyle }));
    });
    // Hover targets (wide transparent lines over the whole descent) and a + to
    // add another child, placed right BESIDE the last child — so even a lone
    // child clearly shows where to add a sibling.
    if (!readonly) {
      gu.appendChild(el("line", { class: "hit", x1: dropX, y1: dropTop, x2: dropX, y2: busY }));
      gu.appendChild(el("line", { class: "hit", x1: minX, y1: busY, x2: maxX, y2: busY }));
      childTops.forEach((c) => gu.appendChild(el("line", { class: "hit", x1: c.x, y1: busY, x2: c.x, y2: c.top })));
      const rightKid = kids.reduce((r, k) => (posOf(k.p.id).x > posOf(r.p.id).x ? k : r), kids[0]);
      const rp = posOf(rightKid.p.id);
      gu.appendChild(addPlus(u.id, rp.x + HALF + 22, rp.y, "Add sibling / spouse / child", rightKid.p.id));
    }
    gLinks.appendChild(gu);
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

  function toWorld(clientX, clientY) {
    const r = stage.getBoundingClientRect();
    return { x: (clientX - r.left - view.tx) / view.scale, y: (clientY - r.top - view.ty) / view.scale };
  }
  function updateMarquee() {
    const box = $("#marquee");
    if (!marquee) { box.hidden = true; return; }
    const x0 = Math.min(marquee.x0, marquee.x1), x1 = Math.max(marquee.x0, marquee.x1);
    const y0 = Math.min(marquee.y0, marquee.y1), y1 = Math.max(marquee.y0, marquee.y1);
    box.style.left = (x0 * view.scale + view.tx) + "px";
    box.style.top = (y0 * view.scale + view.ty) + "px";
    box.style.width = (x1 - x0) * view.scale + "px";
    box.style.height = (y1 - y0) * view.scale + "px";
    box.hidden = false;
  }

  svg.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { svg.setPointerCapture(e.pointerId); } catch (_) {}
    if (pointers.size >= 2) { startPinch(); marquee = null; updateMarquee(); return; }

    const badge = e.target.closest && e.target.closest(".doc-badge");
    if (badge) { openDocsForPerson(badge.getAttribute("data-id")); return; }
    const hb = e.target.closest && e.target.closest(".hidden-badge");
    if (hb) { openHiddenPopup(hb.getAttribute("data-anchor")); return; }
    const plus = e.target.closest && e.target.closest(".add-plus");
    if (plus) {
      const uid_ = plus.getAttribute("data-union"), pid_ = plus.getAttribute("data-person");
      if (pid_) openAddMenu(uid_, pid_, e.clientX, e.clientY); else quickAddChild(uid_);
      return;
    }
    const personEl = e.target.closest && e.target.closest(".person");

    if (rearrange && !readonly) {
      if (personEl) {
        const id = personEl.getAttribute("data-id");
        // Shift-click toggles a person in/out of the group selection without
        // moving anything — build up a set, then drag any of them to move all.
        if (e.shiftKey) {
          if (selection.has(id)) selection.delete(id); else selection.add(id);
          render();
          if (selection.size) toast(selection.size + " selected — drag any of them to move the group");
          return;
        }
        if (!selection.has(id)) { selection = new Set([id]); render(); }
        const starts = {};
        selection.forEach((pid) => { const p = posOf(pid); starts[pid] = { x: p.x, y: p.y }; });
        drag = { mode: "group", id, startX: e.clientX, startY: e.clientY, starts, moved: false, pre: snapshot() };
      } else {
        const w = toWorld(e.clientX, e.clientY);
        drag = { mode: "marquee", startX: e.clientX, startY: e.clientY, moved: false };
        marquee = { x0: w.x, y0: w.y, x1: w.x, y1: w.y }; updateMarquee();
      }
      return;
    }
    // view mode: a click on a person taps to select; otherwise pan. Nothing moves.
    drag = { mode: "pan", startX: e.clientX, startY: e.clientY, tx: view.tx, ty: view.ty, moved: false };
    if (personEl) drag.tapId = personEl.getAttribute("data-id");
    stage.classList.add("panning");
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
      applyView(); updateMarquee();
      return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
    if (drag.mode === "pan") {
      if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
      view.tx = drag.tx + dx; view.ty = drag.ty + dy; applyView();
    }
    else if (drag.mode === "group") {
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      const wdx = dx / view.scale, wdy = dy / view.scale;
      for (const pid in drag.starts) state.manual[pid] = { x: drag.starts[pid].x + wdx, y: drag.starts[pid].y + wdy };
      render();
    }
    else if (drag.mode === "marquee") {
      drag.moved = true;
      const w = toWorld(e.clientX, e.clientY);
      marquee.x1 = w.x; marquee.y1 = w.y; updateMarquee();
    }
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    try { svg.releasePointerCapture(e.pointerId); } catch (_) {}
    if (pointers.size < 2) pinch = null;
    // lifting one finger of a pinch — keep panning smoothly with the finger left down
    if (pointers.size === 1 && !drag && !rearrange) {
      const pt = [...pointers.values()][0];
      drag = { mode: "pan", startX: pt.x, startY: pt.y, tx: view.tx, ty: view.ty };
      stage.classList.add("panning");
    }
    if (pointers.size === 0) {
      stage.classList.remove("panning");
      if (drag && drag.mode === "group") { if (drag.moved) { pushUndo(drag.pre); save(); } else if (drag.id) selectPerson(drag.id); }
      else if (drag && drag.mode === "marquee") {
        if (drag.moved && marquee) {
          const x0 = Math.min(marquee.x0, marquee.x1), x1 = Math.max(marquee.x0, marquee.x1);
          const y0 = Math.min(marquee.y0, marquee.y1), y1 = Math.max(marquee.y0, marquee.y1);
          selection = new Set();
          visiblePersons().forEach((p) => { const q = posOf(p.id); if (q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1) selection.add(p.id); });
          if (selection.size) toast(selection.size + " selected — drag any of them to move the group");
        } else { selection = new Set(); }
        marquee = null; updateMarquee(); render();
      }
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

  // Toggle rearrange mode; slide a person (and their descendants) past a sibling.
  function setRearrange(on) {
    rearrange = on;
    $("#tbRearrange").classList.toggle("active", rearrange);
    stage.classList.toggle("rearranging", rearrange);
    if (!rearrange) { selection = new Set(); marquee = null; updateMarquee(); render(); }
    toast(rearrange ? "Rearrange mode ON — drag a person, or drag a box to select several. Nothing moves when it's off." : "Rearrange mode off");
  }
  // everyone in a person's block that should travel with them: the person, their
  // spouse(s), and all descendants (with the descendants' spouses).
  function familyBlock(id) {
    const out = new Set(); const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      if (out.has(cur)) continue;
      out.add(cur);
      unionsOfPerson(cur).forEach((u) => {
        const spouse = u.a === cur ? u.b : u.a;
        if (spouse != null && !out.has(spouse)) out.add(spouse);
        childLinksOfUnion(u.id).forEach((l) => stack.push(l.child));
      });
    }
    return out;
  }
  function shiftSibling(dir) {
    if (!selectedId) return;
    const plinks = parentLinksOfPerson(selectedId);
    if (!plinks.length) { toast("This person has no siblings to shift past"); return; }
    const union = (plinks.find((l) => l.type !== "adopted") || plinks[0]).union;
    const sibs = childLinksOfUnion(union).map((l) => l.child).filter((c) => personById(c) && !isHidden(c));
    if (sibs.length < 2) { toast("No siblings to shift past"); return; }
    sibs.sort((a, b) => posOf(a).x - posOf(b).x);
    const idx = sibs.indexOf(selectedId);
    const nIdx = idx + (dir < 0 ? -1 : 1);
    if (nIdx < 0 || nIdx >= sibs.length) { toast("Already at the " + (dir < 0 ? "left" : "right") + " end"); return; }
    const other = sibs[nIdx];
    const delta = posOf(other).x - posOf(selectedId).x;
    // snapshot both blocks' current positions first (disjoint sibling subtrees),
    // then swap: this person's block slides right by the gap, the sibling's left.
    const a = [...familyBlock(selectedId)].map((pid) => ({ pid, p: posOf(pid) }));
    const b = [...familyBlock(other)].map((pid) => ({ pid, p: posOf(pid) }));
    pushUndo();
    a.forEach(({ pid, p }) => (state.manual[pid] = { x: p.x + delta, y: p.y }));
    b.forEach(({ pid, p }) => (state.manual[pid] = { x: p.x - delta, y: p.y }));
    save(); render();
  }

  // "Tidy up": line up people who already sit at roughly the same height so
  // they share one clean horizontal line — WITHOUT disturbing anyone the user
  // deliberately placed on a very different level. People are grouped into
  // horizontal bands (each within BAND_T px of the band's running centre); any
  // band with two or more people is snapped to that band's median height.
  // Someone sitting far from everyone else forms a band of one and never moves.
  function tidyUp() {
    const BAND_T = 70;   // "roughly the same height" tolerance (px)
    const pts = visiblePersons().map((p) => ({ id: p.id, x: posOf(p.id).x, y: posOf(p.id).y }));
    if (pts.length < 2) { toast("Nothing to tidy yet"); return; }
    pts.sort((a, b) => a.y - b.y);
    // Cluster into bands by vertical proximity (a point joins the current band
    // only while it stays within BAND_T of that band's mean — so a big jump
    // starts a fresh band and dramatically-offset people stay on their own).
    const bands = [];
    let cur = null;
    for (const pt of pts) {
      if (cur && Math.abs(pt.y - cur.mean) <= BAND_T) {
        cur.items.push(pt);
        cur.mean = cur.items.reduce((s, i) => s + i.y, 0) / cur.items.length;
      } else { cur = { items: [pt], mean: pt.y }; bands.push(cur); }
    }
    let moved = 0;
    const pre = snapshot();
    for (const band of bands) {
      if (band.items.length < 2) continue;              // a lone person: leave alone
      const ys = band.items.map((i) => i.y).sort((a, b) => a - b);
      const n = ys.length;
      const ty = n % 2 ? ys[(n - 1) / 2] : (ys[n / 2 - 1] + ys[n / 2]) / 2;  // median height
      for (const it of band.items) {
        if (Math.abs(it.y - ty) > 0.5) { state.manual[it.id] = { x: it.x, y: ty }; moved++; }
      }
    }
    if (!moved) { toast("Everything's already lined up"); return; }
    pushUndo(pre);
    save(); render();
    toast("Tidied up " + moved + " " + (moved === 1 ? "person" : "people") + " (Cmd+Z to undo)");
  }
  stage.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY); }, { passive: false });

  // Hovering a person reveals the "+ add sibling" button beside their family — so
  // even a lone child obviously shows where to add another child. (The + is on the
  // couple's line group; a short hide-delay lets you move onto it without flicker.)
  let plusRevealTimer = null;
  const clearPlusReveal = () => gLinks.querySelectorAll(".union.reveal-plus").forEach((g) => g.classList.remove("reveal-plus"));
  gNodes.addEventListener("pointerover", (e) => {
    if (readonly) return;
    const pe = e.target.closest && e.target.closest(".person"); if (!pe) return;
    const pid = pe.getAttribute("data-id");
    clearTimeout(plusRevealTimer); clearPlusReveal();
    parentLinksOfPerson(pid).forEach((l) => {
      const g = gLinks.querySelector('.union[data-union="' + l.union + '"]'); if (!g) return;
      g.classList.add("reveal-plus");
      // Slide the + beside the person you're hovering and aim it at them, so the
      // menu's "spouse / child" act on the right person (not just the last child).
      const plus = g.querySelector(".add-plus[data-person]");
      if (plus && posOf(pid)) {
        const pp = posOf(pid);
        plus.setAttribute("transform", `translate(${pp.x + HALF + 22},${pp.y})`);
        plus.setAttribute("data-person", pid);
      }
    });
  });
  gNodes.addEventListener("pointerout", (e) => {
    const pe = e.target.closest && e.target.closest(".person"); if (!pe) return;
    clearTimeout(plusRevealTimer); plusRevealTimer = setTimeout(clearPlusReveal, 240);
  });

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
    $("#pBirthDate").value = p.birthDate || "";
    $("#pDeathDate").value = p.deathDate || "";
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
    renderRelationships(p);
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
    renderRelationships(null);
  }

  const docIcon = (k) => ({ link: "🔗", text: "📄", pdf: "📕", image: "🖼️" }[k] || "📄");
  function renderDocsForm(p) {
    const list = $("#docsList"), addBtn = $("#addDocBtn"), hint = $("#docsHint"), photoBtn = $("#obitPhotoBtn");
    list.innerHTML = "";
    if (photoBtn) photoBtn.hidden = true;
    if (!p) {
      addBtn.disabled = true;
      hint.textContent = "Add this person first, then reopen them to attach an obituary or record.";
      return;
    }
    addBtn.disabled = false;
    const docs = p.docs || [];
    // Offer to pull a picture out of an obituary when there's one to pull from
    // (an uploaded photo, or a linked page we can fetch the portrait off).
    if (photoBtn) {
      const canPhoto = docs.some((d) => d && ((d.kind === "image" && d.content) || d.url));
      photoBtn.hidden = !canPhoto;
      photoBtn.textContent = p.photo ? "📷 Replace picture from obituary" : "📷 Use photo from obituary";
    }
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

  /* ------------------------------------------- relationships (in the profile) */
  const relName = (id) => { const q = personById(id); return q ? escapeHtml(q.name) : "?"; };
  // Choose an existing person or spin up a new blank one. onPick(idOrNull); null = new.
  function pickPerson(title, hint, onPick, excludeIds) {
    const excl = new Set(excludeIds || []);
    const opts = state.persons.filter((q) => !excl.has(q.id)).sort((a, b) => a.name.localeCompare(b.name))
      .map((q) => `<option value="${q.id}">${escapeHtml(q.name)}${q.birth ? " (" + q.birth + ")" : ""}</option>`).join("");
    openModal(title, hint,
      `<label class="field"><span>Who</span><select id="ppWho">
         <option value="__new">➕ New person (I’ll name them)</option>${opts}</select></label>`,
      (m) => { const v = m.querySelector("#ppWho").value; onPick(v === "__new" ? null : v); }, "Add");
  }
  // Re-save + re-render the tree and the open profile after a relationship edit.
  function refreshRel(personId) {
    relayoutAndSave();
    const p = personById(personId);
    if (p) { selectedId = personId; fillPersonForm(p); }
  }
  function relSetStatus(unionId, status, personId) { pushUndo(); const u = unionById(unionId); if (u) u.status = status; refreshRel(personId); }
  function relSetChildType(linkId, type, personId) { pushUndo(); const l = state.links.find((x) => x.id === linkId); if (l) l.type = type; refreshRel(personId); }
  function relUnlinkUnion(unionId, personId) {
    if (!confirm("Remove this relationship? Both people stay in the tree; any children of this couple lose this parent link.")) return;
    pushUndo(); deleteUnion(unionId); refreshRel(personId);
  }
  function relRemoveLink(linkId, personId) {
    if (!confirm("Remove this parent–child link? Both people stay in the tree.")) return;
    pushUndo(); deleteLink(linkId); refreshRel(personId);
  }
  function relAddPartner(personId) {
    pickPerson("Add a partner", "Link an existing person as a spouse / partner, or create a new one.", (pid) => {
      if (pid === personId) return toast("Pick someone else");
      pushUndo();
      let partnerId = pid;
      if (!partnerId) partnerId = addPerson({ name: "New spouse", sex: guessSpouseSex(personById(personId)) }).id;
      addUnion(personId, partnerId, "married");
      if (isManual(personId) && !isManual(partnerId)) { const pp = posOf(personId); placeAt(partnerId, pp.x + COLW, pp.y); }
      if (!pid) focusNewPerson(personById(partnerId), "Added spouse — type their name and Save");
      else { refreshRel(personId); toast("Linked as a couple"); }
    }, [personId]);
  }
  function relAddChild(unionId, personId) {
    pickPerson("Add a child", "Link an existing person as this couple’s child, or create a new one.", (cid) => {
      pushUndo();
      let childId = cid;
      if (!childId) childId = addPerson({ name: "New person", sex: "unknown" }).id;
      addChild(unionId, childId, "bio");
      const u = unionById(unionId); if (u) placeNewChild(u, childId);
      if (!cid) focusNewPerson(personById(childId));
      else { refreshRel(personId); toast("Child linked"); }
    }, [personId]);
  }
  function relAddParent(personId) {
    pickPerson("Add a parent", "Pick an existing person as a parent — this person is attached as their child. Add the second parent by editing that person’s partners.",
      (pid) => {
        if (!pid) return toast("Pick an existing person as the parent");
        if (pid === personId) return toast("Pick someone else");
        pushUndo();
        let u = unionsOfPerson(pid)[0];
        if (!u) u = addUnion(pid, null, "married");
        addChild(u.id, personId, "bio");
        refreshRel(personId);
      }, [personId]);
  }
  function renderRelationships(p) {
    const sec = $("#relSection"), box = $("#relList"); if (!box || !sec) return;
    box.innerHTML = "";
    if (!p) { sec.hidden = true; return; }
    sec.hidden = false;
    const pid = p.id;
    const head = (t) => { const li = document.createElement("li"); li.className = "rel-head"; li.textContent = t; box.appendChild(li); };
    const none = (t) => { const li = document.createElement("li"); li.className = "rel-none"; li.textContent = t; box.appendChild(li); };
    const add = (html) => { const li = document.createElement("li"); li.className = "rel-add"; li.innerHTML = html; box.appendChild(li); return li; };

    // ---- partners & their children ----
    head("Partners");
    const unions = unionsOfPerson(pid);
    if (!unions.length) none("No partner recorded yet.");
    unions.forEach((u) => {
      const other = u.a === pid ? u.b : u.a;
      const li = document.createElement("li"); li.className = "rel-row";
      li.innerHTML = `<span class="rn">${other ? relName(other) : "<em>single parent</em>"}</span>
        <select class="rel-status" data-u="${u.id}">
          <option value="married">Married</option><option value="divorced">Divorced</option><option value="partners">Partners</option>
        </select><button class="rel-x" data-unlink="${u.id}" title="Remove relationship">✕</button>`;
      li.querySelector(".rel-status").value = u.status || "married";
      box.appendChild(li);
      childLinksOfUnion(u.id).forEach((l) => {
        if (!personById(l.child)) return;
        const ci = document.createElement("li"); ci.className = "rel-child";
        ci.innerHTML = `<span class="rn">↳ ${relName(l.child)}</span>
          <select class="rel-ctype" data-link="${l.id}"><option value="bio">Biological</option><option value="adopted">Adopted</option></select>
          <button class="rel-x" data-rmlink="${l.id}" title="Remove child link">✕</button>`;
        ci.querySelector(".rel-ctype").value = l.type || "bio";
        box.appendChild(ci);
      });
      add(`<button class="btn small" data-addchild="${u.id}">＋ Add child with ${other ? relName(other) : "this partner"}</button>`);
    });
    add(`<button class="btn small" data-addpartner="1">＋ Add partner</button>`);

    // ---- parents ----
    head("Parents");
    const plinks = parentLinksOfPerson(pid);
    if (!plinks.length) none("No parents recorded.");
    plinks.forEach((l) => {
      const u = unionById(l.union); if (!u) return;
      const li = document.createElement("li"); li.className = "rel-row";
      li.innerHTML = `<span class="rn">${escapeHtml(unionLabel(u))}</span>
        <select class="rel-ctype" data-link="${l.id}"><option value="bio">Biological</option><option value="adopted">Adopted</option></select>
        <button class="rel-x" data-rmlink="${l.id}" title="Remove parent link">✕</button>`;
      li.querySelector(".rel-ctype").value = l.type || "bio";
      box.appendChild(li);
    });
    add(`<button class="btn small" data-addparent="1">＋ Add parent</button>`);

    // ---- wire it up ----
    box.querySelectorAll(".rel-status").forEach((s) => (s.onchange = () => relSetStatus(s.getAttribute("data-u"), s.value, pid)));
    box.querySelectorAll(".rel-ctype").forEach((s) => (s.onchange = () => relSetChildType(s.getAttribute("data-link"), s.value, pid)));
    box.querySelectorAll("[data-unlink]").forEach((b) => (b.onclick = () => relUnlinkUnion(b.getAttribute("data-unlink"), pid)));
    box.querySelectorAll("[data-rmlink]").forEach((b) => (b.onclick = () => relRemoveLink(b.getAttribute("data-rmlink"), pid)));
    box.querySelectorAll("[data-addchild]").forEach((b) => (b.onclick = () => relAddChild(b.getAttribute("data-addchild"), pid)));
    const ap = box.querySelector("[data-addpartner]"); if (ap) ap.onclick = () => relAddPartner(pid);
    const apar = box.querySelector("[data-addparent]"); if (apar) apar.onclick = () => relAddParent(pid);
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
    const img = $("#photoPreview"), clr = $("#photoClear"), adj = $("#photoAdjustBtn");
    if (pendingPhoto) { img.src = pendingPhoto; img.hidden = false; clr.hidden = false; if (adj) adj.hidden = false; }
    else { img.hidden = true; clr.hidden = true; if (adj) adj.hidden = true; }
  }

  document.querySelectorAll("#sexToggle button").forEach((b) => (b.onclick = () => setSex(b.dataset.sex)));

  $("#personForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = $("#personId").value;
    const birthDate = $("#pBirthDate").value || null, deathDate = $("#pDeathDate").value || null;
    // A full date wins over the year box, so the tree year always matches the exact date.
    const birthYear = birthDate ? birthDate.slice(0, 4) : $("#pBirth").value;
    const deathYear = deathDate ? deathDate.slice(0, 4) : $("#pDeath").value;
    const data = { name: $("#pName").value.trim() || "Unnamed", birth: birthYear, death: deathYear, birthDate, deathDate, deceased: $("#pDeceased").checked, sex: formSex, color: formColor, photo: pendingPhoto };
    if (id) {
      const p = personById(id);
      Object.assign(p, { name: data.name, birth: num(data.birth), death: num(data.death), birthDate: data.birthDate, deathDate: data.deathDate, deceased: data.deceased, sex: data.sex, color: data.color || null, photo: data.photo });
    } else {
      const p = addPerson(data); selectedId = p.id;
    }
    resetPersonForm();
    relayoutAndSave();
    toast("Saved");
  });
  // Entering a full date fills in (and keeps in sync) the year that shows on the tree.
  $("#pBirthDate").addEventListener("change", () => { const v = $("#pBirthDate").value; if (v) $("#pBirth").value = v.slice(0, 4); });
  $("#pDeathDate").addEventListener("change", () => { const v = $("#pDeathDate").value; if (v) { $("#pDeath").value = v.slice(0, 4); $("#pDeceased").checked = true; } });
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
  $("#photoUrlBtn").onclick = () => setPhotoFromUrl($("#photoUrl").value);
  $("#photoInput").addEventListener("change", (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => openPhotoAdjust(reader.result, (photo) => { pendingPhoto = photo; updatePhotoPreview(); });
    reader.onerror = () => toast("Couldn’t read that file.");
    reader.readAsDataURL(file);
    e.target.value = "";
  });
  $("#photoAdjustBtn").onclick = () => { if (pendingPhoto) openPhotoAdjust(pendingPhoto, (photo) => { pendingPhoto = photo; updatePhotoPreview(); }); };
  // Load a photo from a pasted image link (or any page with a portrait) into the
  // form's staged photo. The fetch runs server-side (Vercel), so it works on
  // cross-origin images the browser itself couldn't read. Save to keep it.
  async function setPhotoFromUrl(url) {
    url = (url || "").trim();
    if (!url) { toast("Paste an image link first"); return; }
    let pass = ""; try { pass = localStorage.getItem("familyTree.importPass") || ""; } catch (e) {}
    if (!pass) pass = prompt("One-time import passcode (set as IMPORT_PASSCODE on the Vercel site):") || "";
    if (!pass) return;
    try { localStorage.setItem("familyTree.importPass", pass); } catch (e) {}
    const btn = $("#photoUrlBtn"); if (btn) btn.disabled = true;
    toast("Fetching the photo…");
    try {
      const data = await callArchive({ passcode: pass, url });
      if (data && data.image) {
        openPhotoAdjust(data.image, (photo) => { pendingPhoto = photo; updatePhotoPreview(); toast("Photo loaded — click Save to keep it"); });
        return;
      }
      toast("No image found at that link");
    } catch (e) {
      toast(e.message || "Couldn’t fetch that image");
    } finally { if (btn) btn.disabled = false; }
  }
  function downscale(img, max) {
    let { width: w, height: h } = img;
    const scale = Math.min(1, max / Math.max(w, h));
    w = Math.round(w * scale); h = Math.round(h * scale);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.82);
  }

  // Crop / zoom / reposition editor. Opens on an image (data URL), lets the user
  // drag to move and pinch/slide to zoom within a square frame, and returns a
  // clean square JPEG via onDone. Also surfaces a clear error if the image can't
  // be read (e.g. an unsupported HEIC), instead of failing silently.
  function openPhotoAdjust(src, onDone) {
    const probe = new Image();
    probe.onerror = () => toast("Couldn’t read that image — try a JPG or PNG (a screenshot of it works too).");
    probe.onload = () => {
      const V = 280, OUT = 400;
      const natW = probe.naturalWidth, natH = probe.naturalHeight;
      const minScale = V / Math.min(natW, natH);
      let scale = minScale, ox = (V - natW * scale) / 2, oy = (V - natH * scale) / 2;

      const back = document.createElement("div");
      back.className = "modal-backdrop";
      back.innerHTML = `<div class="modal"><h2>Adjust photo</h2>
        <div class="hint">Drag to move, and pinch or use the slider to zoom. The circle shows what fills a round profile.</div>
        <div class="pa-stage" id="paStage"><canvas id="paCanvas" width="${V}" height="${V}"></canvas><div class="pa-guide"></div></div>
        <div class="pa-zoom"><span>−</span><input type="range" id="paZoom" min="1" max="4" step="0.01" value="1"><span>+</span></div>
        <div class="btn-row"><button class="btn" data-cancel>Cancel</button><button class="btn primary" id="paOk">Use photo</button></div></div>`;
      document.body.appendChild(back);
      const close = () => back.remove();
      back.querySelector("[data-cancel]").onclick = close;
      back.addEventListener("click", (e) => { if (e.target === back) close(); });
      const cv = back.querySelector("#paCanvas"), ctx = cv.getContext("2d");
      const stage = back.querySelector("#paStage"), zoom = back.querySelector("#paZoom");

      const clamp = () => {
        const w = natW * scale, h = natH * scale;
        ox = Math.min(0, Math.max(V - w, ox));
        oy = Math.min(0, Math.max(V - h, oy));
      };
      const draw = () => { ctx.clearRect(0, 0, V, V); ctx.drawImage(probe, ox, oy, natW * scale, natH * scale); };
      const setScaleAround = (ns, cx, cy) => {
        ns = Math.max(minScale, Math.min(minScale * 4, ns));
        const k = ns / scale; ox = cx - (cx - ox) * k; oy = cy - (cy - oy) * k; scale = ns; clamp(); draw();
        zoom.value = (scale / minScale).toFixed(2);
      };
      clamp(); draw();

      zoom.oninput = () => setScaleAround(minScale * parseFloat(zoom.value), V / 2, V / 2);

      // pointer pan + pinch zoom (works with mouse and touch)
      const pts = new Map();
      const toLocal = (e) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * (V / r.width), y: (e.clientY - r.top) * (V / r.height) }; };
      let last = null, pinchDist = 0;
      stage.addEventListener("pointerdown", (e) => { e.preventDefault(); stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, toLocal(e)); if (pts.size === 1) last = toLocal(e); pinchDist = 0; });
      stage.addEventListener("pointermove", (e) => {
        if (!pts.has(e.pointerId)) return;
        pts.set(e.pointerId, toLocal(e));
        const arr = [...pts.values()];
        if (arr.length >= 2) {
          const mx = (arr[0].x + arr[1].x) / 2, my = (arr[0].y + arr[1].y) / 2;
          const d = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
          if (pinchDist) setScaleAround(scale * (d / pinchDist), mx, my);
          pinchDist = d;
        } else {
          const p = toLocal(e); if (last) { ox += p.x - last.x; oy += p.y - last.y; clamp(); draw(); } last = p;
        }
      });
      const end = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinchDist = 0; if (pts.size === 0) last = null; else last = [...pts.values()][0]; };
      stage.addEventListener("pointerup", end);
      stage.addEventListener("pointercancel", end);

      back.querySelector("#paOk").onclick = () => {
        const out = document.createElement("canvas"); out.width = out.height = OUT;
        const f = OUT / V;
        out.getContext("2d").drawImage(probe, ox * f, oy * f, natW * scale * f, natH * scale * f);
        close();
        onDone(out.toDataURL("image/jpeg", 0.85));
      };
    };
    probe.src = src;
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
    back.innerHTML = `<div class="modal"><h2>Add people from an obituary</h2>
      <div class="hint">Paste a link to an obituary — Claude reads it, checks who’s already in your tree, and adds only the new relatives, connected to the right people. You’ll see who it found before anything is added. (You can paste the text or a photo instead.)</div>
      <label class="field"><span>This obituary is for</span><select id="imFor">
        <option value="">A new person (or not sure)</option>
        ${state.persons.slice().sort((a, b) => a.name.localeCompare(b.name)).map((pp) => `<option value="${pp.id}">${escapeHtml(pp.name)}</option>`).join("")}
      </select></label>
      <label class="field"><span>Link to the obituary</span><input type="text" id="imUrl" placeholder="https://…"/></label>
      <label class="field"><span>…or paste the text</span><textarea id="imText" rows="5" placeholder="Paste the obituary here…"></textarea></label>
      <label class="field"><span>…or upload a PDF / photo</span><input type="file" id="imFile" accept="application/pdf,image/*"/></label>
      <label class="field" id="imPassRow"${saved ? " hidden" : ""}><span>Import passcode</span><input type="password" id="imPass" placeholder="set in Vercel (IMPORT_PASSCODE)" value="${escapeHtml(saved)}"/></label>
      <div class="err" id="imErr" style="color:var(--divorce);font-size:12.5px;min-height:16px"></div>
      <div id="imStatus" class="hint"></div>
      <div class="btn-row"><button class="btn" data-cancel>Cancel</button><button class="btn primary" id="imGo">Read &amp; add people</button></div></div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.querySelector("[data-cancel]").onclick = close;
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    const err = back.querySelector("#imErr");
    const status = back.querySelector("#imStatus");

    const passRow = back.querySelector("#imPassRow");
    const goBtn = back.querySelector("#imGo");
    goBtn.onclick = async () => {
      err.textContent = "";
      let pass = back.querySelector("#imPass").value.trim();
      if (!pass) { try { pass = localStorage.getItem("familyTree.importPass") || ""; } catch (e) {} }
      const text = back.querySelector("#imText").value.trim();
      const url = back.querySelector("#imUrl").value.trim();
      const fileEl = back.querySelector("#imFile");
      if (!text && !url && !fileEl.files[0]) { err.textContent = "Add a link, paste the text, or upload a file."; return; }
      if (!pass) { passRow.hidden = false; err.textContent = "Enter the import passcode (one time — it’s remembered after)."; return; }
      try { localStorage.setItem("familyTree.importPass", pass); } catch (e) {}

      const forId = back.querySelector("#imFor").value;
      const forPerson = forId ? personById(forId) : null;
      const payload = {
        passcode: pass, text, url,
        subject: forPerson ? forPerson.name : "",   // the obituary is about this existing person
        existing: state.persons.map((p) => ({ name: p.name, birth: p.birth, death: p.death })),
      };
      if (fileEl.files[0]) {
        const f = fileEl.files[0];
        if (f.size > 8 * 1024 * 1024) { err.textContent = "File is too large (max 8 MB)."; return; }
        payload.file = { mediaType: f.type, data: await fileToBase64(f) };
      }

      status.textContent = "Reading the obituary with Claude… this can take a moment.";
      goBtn.disabled = true;
      try {
        const data = await callExtract(payload);
        const counts = countExtraction(data);
        if (!counts.people && !counts.couples && !counts.children) { err.textContent = "Nothing usable was found in that source."; status.textContent = ""; goBtn.disabled = false; return; }
        // Show WHO will be added (new names) rather than just counts.
        const existingNames = new Set(state.persons.map((p) => p.name.trim().toLowerCase()));
        const newNames = (data.people || []).map((pp) => pp.name).filter((n) => n && !existingNames.has(n.trim().toLowerCase()));
        const lines = [];
        if (newNames.length) lines.push(`Add ${newNames.length} new ${newNames.length === 1 ? "person" : "people"}:`, ...newNames.map((n) => "  • " + n));
        else lines.push("No new people — this will just connect people already in your tree.");
        const links = counts.couples + counts.children;
        if (links) lines.push("", `…and ${links} relationship link${links === 1 ? "" : "s"}.`);
        if (confirm(lines.join("\n"))) {
          pushUndo();
          mergeExtraction(data);
          // If this obituary is for someone already in the tree, keep a copy of it
          // on their profile too (text or link).
          if (forPerson) {
            forPerson.docs = forPerson.docs || [];
            const kind = text ? "text" : "link";
            forPerson.docs.push({ id: uid(), title: forPerson.name + "’s Obituary", url, capturedAt: todayStr(), kind, content: text || "" });
          }
          relayoutAndSave(); fitView();
          toast(newNames.length ? ("Added " + newNames.length + " from the obituary (Cmd+Z to undo)") : "Connected people from the obituary");
          close();
        } else {
          status.textContent = ""; goBtn.disabled = false;
        }
      } catch (e2) {
        const msg = e2.message || "Import failed.";
        if (/passcode/i.test(msg)) passRow.hidden = false;   // let them correct a wrong passcode
        err.textContent = msg;
        status.textContent = "";
        goBtn.disabled = false;
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
    const newIds = [];
    const findByName = (name) => state.persons.find((p) => p.name.trim().toLowerCase() === String(name || "").trim().toLowerCase());
    const yearOf = (year, date) => year || (date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.slice(0, 4) : "");
    const isoDate = (date) => (/^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : null);
    (d.people || []).forEach((pp) => {
      const bDate = isoDate(pp.birthDate), dDate = isoDate(pp.deathDate);
      const ex = findByName(pp.name);
      if (ex) {
        keyToId[pp.key] = ex.id;
        if (ex.birth == null && yearOf(pp.birthYear, bDate)) ex.birth = num(yearOf(pp.birthYear, bDate));
        if (ex.death == null && yearOf(pp.deathYear, dDate)) ex.death = num(yearOf(pp.deathYear, dDate));
        if (!ex.birthDate && bDate) ex.birthDate = bDate;   // exact dates from the obituary
        if (!ex.deathDate && dDate) ex.deathDate = dDate;
      } else {
        const np = addPerson({ name: pp.name || "Unnamed", sex: pp.sex || "unknown", birth: yearOf(pp.birthYear, bDate), death: yearOf(pp.deathYear, dDate), birthDate: bDate, deathDate: dDate });
        keyToId[pp.key] = np.id; newIds.push(np.id);
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
    // Slot the new people in next to their connections, opening room as needed,
    // so imports keep everyone else where they are instead of reshuffling.
    placeNewPeople(newIds);
    return newIds;
  }

  /* ============================================================ OBITUARY / RECORD ATTACHMENTS */
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return "link"; } }

  function openAttachModal(personId) {
    const person = personById(personId); if (!person) return;
    const obitTitle = person.name + "’s Obituary";
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = `<div class="modal"><h2>Attach ${escapeHtml(obitTitle)}</h2>
      <div class="hint">Paste a link and I’ll fetch the text and keep a durable copy — so it stays even if the original goes offline. Or paste the text yourself, or upload a photo / PDF. A photo also becomes ${escapeHtml(person.name)}’s picture in the tree.</div>
      <label class="field"><span>Link to the obituary</span><input type="text" id="dUrl" placeholder="https://…"/></label>
      <label class="field"><span>…or paste the text</span><textarea id="dText" rows="5" placeholder="Paste the obituary text here…"></textarea></label>
      <label class="field"><span>…or upload a photo / PDF</span><input type="file" id="dFile" accept="application/pdf,image/*,.txt,.html"/></label>
      <div class="err" id="dErr" style="color:var(--divorce);font-size:12.5px;min-height:16px"></div>
      <div class="hint" id="dStatus"></div>
      <div class="btn-row"><button class="btn" data-cancel>Cancel</button><button class="btn primary" id="dSave">Save</button></div></div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.querySelector("[data-cancel]").onclick = close;
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    const err = back.querySelector("#dErr"), status = back.querySelector("#dStatus");
    const saveBtn = back.querySelector("#dSave");

    saveBtn.onclick = async () => {
      err.textContent = "";
      const url = back.querySelector("#dUrl").value.trim();
      const text = back.querySelector("#dText").value.trim();
      const file = back.querySelector("#dFile").files[0];
      let kind = "link", content = "", fetchedImage = "", scrapedText = "";
      if (file) {
        if (file.size > 8 * 1024 * 1024) { err.textContent = "File is too large (max 8 MB)."; return; }
        let fileB64 = "", fileMt = file.type;
        if (file.type === "application/pdf") { kind = "pdf"; fileB64 = await fileToBase64(file); content = "data:application/pdf;base64," + fileB64; }
        else if (file.type.startsWith("image/")) { kind = "image"; fileB64 = await fileToBase64(file); content = "data:" + file.type + ";base64," + fileB64; }
        else { kind = "text"; content = await file.text(); }
        // Scrape the text out of a screenshot / PDF so there's a durable, searchable
        // record even if the picture is later lost.
        if (fileB64 && (kind === "image" || kind === "pdf")) {
          let pass = ""; try { pass = localStorage.getItem("familyTree.importPass") || ""; } catch (e) {}
          if (!pass) pass = prompt("One-time import passcode (set as IMPORT_PASSCODE on the Vercel site):") || "";
          if (pass) {
            try { localStorage.setItem("familyTree.importPass", pass); } catch (e) {}
            saveBtn.disabled = true; status.textContent = "Reading the text from the file…";
            try {
              const t = await callTranscribe({ passcode: pass, file: { mediaType: fileMt, data: fileB64 } });
              if (t && t.text) scrapedText = t.text;
            } catch (e2) { toast("Saved the file — couldn’t read its text here (" + (e2.message || "error") + ")"); }
            status.textContent = ""; saveBtn.disabled = false;
          }
        }
      } else if (text) { kind = "text"; content = text; }
      else if (url) {
        // A link on its own: automatically fetch and keep a durable text copy.
        let pass = ""; try { pass = localStorage.getItem("familyTree.importPass") || ""; } catch (e) {}
        if (!pass) pass = prompt("One-time import passcode (set as IMPORT_PASSCODE on the Vercel site):") || "";
        if (pass) {
          try { localStorage.setItem("familyTree.importPass", pass); } catch (e) {}
          saveBtn.disabled = true; status.textContent = "Fetching the obituary text…";
          try {
            const data = await callArchive({ passcode: pass, url });
            if (data && data.text) { kind = "text"; content = data.text; }
            else { kind = "link"; toast("Saved the link (no text found to archive)"); }
            if (data && data.image) fetchedImage = data.image;   // portrait pulled from the page
          } catch (e2) {
            // Couldn’t reach the archiver (e.g. on plain GitHub Pages) — keep the
            // link so nothing is lost; the text can be archived from the Vercel site.
            kind = "link"; content = ""; toast("Saved the link — auto-fetch needs the Vercel site");
          }
          status.textContent = ""; saveBtn.disabled = false;
        } else { kind = "link"; content = ""; toast("Saved the link"); }
      } else { err.textContent = "Add a link, paste the text, or upload a file."; return; }

      const doc = { id: uid(), title: obitTitle, url, capturedAt: todayStr(), kind, content };
      if (scrapedText) doc.text = scrapedText;   // durable, searchable copy of a photo/PDF's text
      if (!person.docs) person.docs = [];
      person.docs.push(doc);
      // A photo obituary — or a portrait pulled from a linked obituary page —
      // also becomes this person’s picture (unless they already have one).
      let setPic = false;
      if (!person.photo) {
        const src = kind === "image" ? content : fetchedImage;
        if (src) { const photo = await imageDataToPhoto(src); if (photo) { person.photo = photo; setPic = true; } }
      }
      save(); render(); renderDocsForm(person); if (selectedId === person.id) fillPersonForm(person);
      close();
      toast(scrapedText ? "Obituary saved — text scraped" + (setPic ? " & set as their picture" : "") : (setPic ? "Obituary saved — also set as their picture" : "Obituary saved"));
    };
  }

  // Load an image data-URL and return a downscaled JPEG suitable for a node picture.
  function imageDataToPhoto(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { try { resolve(downscale(img, 400)); } catch (e) { resolve(null); } };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }
  // Retroactively give people a picture from any image obituary already attached
  // (runs once per browser; new uploads set the picture at attach time).
  async function migratePhotosFromObits() {
    let changed = false;
    for (const p of state.persons) {
      if (p.photo || !Array.isArray(p.docs)) continue;
      const imgDoc = p.docs.find((d) => d && d.kind === "image" && d.content);
      if (!imgDoc) continue;
      const photo = await imageDataToPhoto(imgDoc.content);
      if (photo) { p.photo = photo; changed = true; }
    }
    return changed;
  }

  // Find a picture for one person from their obituary: use an uploaded photo
  // obituary if there is one, otherwise fetch the portrait from a linked
  // obituary page. Used by the "Use photo from obituary" button, so it works
  // retroactively for obituaries that are already attached.
  async function usePhotoFromObit(p) {
    if (!p) return;
    const docs = p.docs || [];
    const imgDoc = docs.find((d) => d && d.kind === "image" && d.content);
    if (imgDoc) {
      const photo = await imageDataToPhoto(imgDoc.content);
      if (photo) { p.photo = photo; save(); render(); if (selectedId === p.id) fillPersonForm(p); toast("Set their picture from the obituary"); return; }
    }
    const urlDoc = docs.find((d) => d && d.url);
    if (!urlDoc) { toast("No photo found in the obituary"); return; }
    let pass = ""; try { pass = localStorage.getItem("familyTree.importPass") || ""; } catch (e) {}
    if (!pass) pass = prompt("One-time import passcode (set as IMPORT_PASSCODE on the Vercel site):") || "";
    if (!pass) return;
    try { localStorage.setItem("familyTree.importPass", pass); } catch (e) {}
    const btn = $("#obitPhotoBtn"); if (btn) { btn.disabled = true; }
    toast("Looking for a photo in the obituary…");
    try {
      const data = await callArchive({ passcode: pass, url: urlDoc.url });
      if (data && data.image) {
        const photo = await imageDataToPhoto(data.image);
        if (photo) { p.photo = photo; save(); render(); if (selectedId === p.id) fillPersonForm(p); toast("Set their picture from the obituary"); return; }
      }
      toast("Couldn’t find a photo in that obituary");
    } catch (e) {
      toast(e.message || "Couldn’t reach the obituary page");
    } finally { if (btn) btn.disabled = false; }
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

  // Retroactively scrape text out of every already-uploaded photo/PDF obituary
  // that doesn't have a text copy yet, and store it on the record.
  async function scrapeAllObits() {
    if (readonly) return;
    const targets = [];
    state.persons.forEach((p) => (p.docs || []).forEach((d) => {
      if (d && (d.kind === "image" || d.kind === "pdf") && d.content && !d.text) targets.push(d);
    }));
    if (!targets.length) { toast("No uploaded obituaries need scraping"); return; }
    let pass = ""; try { pass = localStorage.getItem("familyTree.importPass") || ""; } catch (e) {}
    if (!pass) pass = prompt("One-time import passcode (set as IMPORT_PASSCODE on the Vercel site):") || "";
    if (!pass) return;
    try { localStorage.setItem("familyTree.importPass", pass); } catch (e) {}
    const btn = $("#scrapeAllBtn"); if (btn) btn.disabled = true;
    let ok = 0;
    try {
      for (let i = 0; i < targets.length; i++) {
        const d = targets[i];
        if (btn) btn.textContent = "Scraping… (" + (i + 1) + " of " + targets.length + ")";
        const m = /^data:([^;]+);base64,(.*)$/.exec(d.content || "");
        if (!m) continue;
        const t = await callTranscribe({ passcode: pass, file: { mediaType: m[1], data: m[2] } });
        if (t && t.text) { d.text = t.text; ok++; save(); }   // persist as we go
      }
      toast("Scraped text for " + ok + " of " + targets.length + " obituar" + (targets.length === 1 ? "y" : "ies"));
    } catch (e) {
      toast((e.message || "Scraping stopped") + (ok ? " — got " + ok + " first" : ""));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "📝 Scrape text from uploaded obituaries"; }
      render();
    }
  }

  async function callTranscribe(payload) {
    let res;
    try { res = await fetch("api/transcribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); }
    catch (e) { throw new Error("Couldn’t reach the text-scraping service."); }
    if (!res.ok) {
      let msg = "Text scraping failed (" + res.status + ").";
      try { msg = (await res.json()).error || msg; } catch (e) {}
      if (res.status === 404) msg = "Reading text from files needs the Vercel site.";
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
    // Text scraped from a screenshot / PDF — the durable, searchable copy.
    if (doc.text && (doc.kind === "image" || doc.kind === "pdf")) {
      bodyHtml += `<div class="scraped-label">Scraped text</div><pre>${escapeHtml(doc.text)}</pre>`;
    }
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
    return { title: state.title, subtitle: state.subtitle, persons: state.persons, unions: state.unions, links: state.links, manual: state.manual, hidden: state.hidden, focus: state.focus, version: state.version || 0, photoMigrated: !!state.photoMigrated };
  }
  function loadObject(obj) {
    state = Object.assign(blankState(), {
      title: obj.title || "Family Tree", subtitle: obj.subtitle || "",
      persons: obj.persons || [], unions: obj.unions || [], links: obj.links || [], manual: obj.manual || {}, hidden: obj.hidden || {},
      focus: Array.isArray(obj.focus) ? obj.focus : [], version: obj.version || 0,
      photoMigrated: !!obj.photoMigrated,
    });
  }
  function savedVersion() { try { const s = localStorage.getItem(STORE_KEY); return s ? (JSON.parse(s).version || 0) : 0; } catch (e) { return 0; } }
  function downloadFile(name, content, type) {
    const blob = new Blob([content], { type: type || "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(exportObject())); } catch (e) { console.warn("save failed", e); } scheduleBackup(); }

  /* -------- durable backup: commit the encrypted tree to the repo -------- */
  let backupTimer = null;
  const BACKUP_ON = () => { try { return localStorage.getItem("familyTree.backupOn") === "1"; } catch (e) { return false; } };
  function setBackupStatus(state, msg) {
    const el = $("#backupStatus"); if (!el) return;
    const map = { off: "Not set up yet", on: "Auto-backup on ✓", pending: "Saving to repo soon…", saving: "Backing up…", saved: "Backed up to repo ✓", error: "Backup failed" };
    el.textContent = (map[state] || "") + (msg ? " — " + msg : "");
    el.className = "hint backup-" + state;
  }
  function scheduleBackup() {
    if (readonly || !BACKUP_ON()) return;
    clearTimeout(backupTimer);
    setBackupStatus("pending");
    backupTimer = setTimeout(() => backupToRepo(false), 8000);   // coalesce a burst of edits into one commit
  }
  async function backupToRepo(manual) {
    if (readonly) return;
    let fam = ""; try { fam = localStorage.getItem("familyTree.familyPass") || ""; } catch (e) {}
    if (!fam) {
      if (!manual) return;
      fam = prompt("Your family password (encrypts the backup & the family view):") || "";
      if (!fam) return;
      try { localStorage.setItem("familyTree.familyPass", fam); } catch (e) {}
    }
    let pass = ""; try { pass = localStorage.getItem("familyTree.importPass") || ""; } catch (e) {}
    if (!pass) { if (!manual) return; pass = prompt("One-time import passcode (set as IMPORT_PASSCODE on the Vercel site):") || ""; if (!pass) return; try { localStorage.setItem("familyTree.importPass", pass); } catch (e) {} }
    try { localStorage.setItem("familyTree.backupOn", "1"); } catch (e) {}   // enable auto-backup from now on
    setBackupStatus("saving");
    try {
      const payload = await encryptState(fam);
      const content = "/* Encrypted family tree — auto-backed up from the editor. */\nwindow.FAMILY_TREE_DATA = " + JSON.stringify(payload) + ";\n";
      const res = await fetch("api/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passcode: pass, content }) });
      if (!res.ok) { let msg = "failed (" + res.status + ")"; try { msg = (await res.json()).error || msg; } catch (e) {} if (res.status === 404) msg = "needs the Vercel site + a GitHub token"; throw new Error(msg); }
      setBackupStatus("saved");
      if (manual) toast("Backed up to the repo");
    } catch (e) {
      setBackupStatus("error", e.message);
      if (manual) toast(e.message || "Backup failed");
    }
  }
  function hasLocalData() { try { const s = localStorage.getItem(STORE_KEY); return s && JSON.parse(s).persons && JSON.parse(s).persons.length; } catch (e) { return false; } }
  function loadLocal() { try { const s = localStorage.getItem(STORE_KEY); if (s) loadObject(JSON.parse(s)); } catch (e) { console.warn(e); } }
  // When a newer starter replaces the saved copy, keep everything the user made
  // their own from that old copy — the tree's name, dragged positions, hidden
  // people, the focus centre, any pictures / obituaries they added, and anyone
  // they added themselves — so an update never wipes their work.
  function carryOverLocalPrefs() {
    let old = null;
    try { const s = localStorage.getItem(STORE_KEY); if (s) old = JSON.parse(s); } catch (e) {}
    if (!old) return;
    const ids = new Set(state.persons.map((p) => p.id));
    // the tree's own name / subtitle (their rename wins over the built-in default)
    if (typeof old.title === "string" && old.title.trim()) state.title = old.title;
    if (typeof old.subtitle === "string") state.subtitle = old.subtitle;
    if (old.manual && typeof old.manual === "object") {
      const m = {}; for (const id in old.manual) if (ids.has(id)) m[id] = old.manual[id];
      state.manual = m;
    }
    if (old.hidden && typeof old.hidden === "object") {
      const h = {}; for (const id in old.hidden) if (ids.has(id) && old.hidden[id]) h[id] = true;
      state.hidden = h;
    }
    if (Array.isArray(old.focus)) {
      const f = old.focus.filter((id) => ids.has(id));
      if (f.length) state.focus = f;
    }
    // pictures & attached records the user added to people who still exist
    const oldById = {};
    (old.persons || []).forEach((pp) => { if (pp && pp.id) oldById[pp.id] = pp; });
    state.persons.forEach((pp) => {
      const o = oldById[pp.id]; if (!o) return;
      if (!pp.photo && o.photo) pp.photo = o.photo;
      if (!pp.birthDate && o.birthDate) pp.birthDate = o.birthDate;   // exact dates the user filled in
      if (!pp.deathDate && o.deathDate) pp.deathDate = o.deathDate;
      if (Array.isArray(o.docs) && o.docs.length) {
        const have = new Set((pp.docs || []).map((d) => d && d.id));
        const extra = o.docs.filter((d) => d && !have.has(d.id));
        if (extra.length) pp.docs = (pp.docs || []).concat(extra);
      }
    });
    // people the user added themselves (ids not in the built-in tree), plus the
    // unions and links that connect them — added on top, never overwriting.
    (old.persons || []).forEach((pp) => { if (pp && pp.id && !ids.has(pp.id)) { state.persons.push(pp); ids.add(pp.id); } });
    const haveUnions = new Set(state.unions.map((u) => u.id));
    (old.unions || []).forEach((u) => { if (u && u.id && !haveUnions.has(u.id)) { state.unions.push(u); haveUnions.add(u.id); } });
    const linkKey = (l) => l.union + ">" + (l.child || "");
    const haveLinks = new Set(state.links.map(linkKey));
    (old.links || []).forEach((l) => { if (l && !haveLinks.has(linkKey(l))) { state.links.push(l); haveLinks.add(linkKey(l)); } });
    if (old.photoMigrated) state.photoMigrated = true;
  }

  // Auto-heal duplicate parentage that would draw a child's descent line twice:
  //  1. merge unions that are the SAME couple entered twice,
  //  2. drop exact duplicate child links,
  //  3. when a child is under both "Parent alone" and "Parent + spouse", keep the
  //     couple and drop the redundant single-parent link,
  //  4. remove leftover empty single-parent unions.
  // Genuinely different couples (e.g. a child's birth vs adoptive parents) are two
  // distinct partner-sets and are left untouched.
  function dedupeParentUnions() {
    let changed = false;
    const partners = (u) => [u.a, u.b].filter((v) => v != null);
    const keyOf = (u) => partners(u).slice().sort().join("|");

    // 1. merge identical-partner unions → keep the first, repoint the rest
    const seen = {}, remap = {};
    state.unions.forEach((u) => { const k = keyOf(u); if (!k) return; if (seen[k]) remap[u.id] = seen[k]; else seen[k] = u.id; });
    if (Object.keys(remap).length) {
      state.links.forEach((l) => { if (remap[l.union]) { l.union = remap[l.union]; changed = true; } });
      state.unions = state.unions.filter((u) => !remap[u.id]);
    }

    // 2. drop exact duplicate links (same union + child)
    const linkSeen = new Set();
    state.links = state.links.filter((l) => { const kk = l.union + ">" + l.child; if (linkSeen.has(kk)) { changed = true; return false; } linkSeen.add(kk); return true; });

    // 3. subset cleanup: single-parent link redundant next to a couple with that parent
    const uById = {}; state.unions.forEach((u) => (uById[u.id] = u));
    const pset = (u) => new Set(partners(u));
    const subset = (small, big) => { for (const v of small) if (!big.has(v)) return false; return true; };
    const byChild = {};
    state.links.forEach((l) => { if (uById[l.union]) (byChild[l.child] = byChild[l.child] || []).push(l); });
    const removeLink = new Set();
    Object.values(byChild).forEach((links) => {
      if (links.length < 2) return;
      links.forEach((Li) => {
        if (removeLink.has(Li.id)) return;
        const Pi = pset(uById[Li.union]);
        if (!Pi.size) return;
        links.forEach((Lj) => {
          if (Li === Lj || removeLink.has(Lj.id)) return;
          const Pj = pset(uById[Lj.union]);
          if (Pi.size < Pj.size && subset(Pi, Pj)) removeLink.add(Li.id);   // Li's union is the smaller (redundant) one
        });
      });
    });
    if (removeLink.size) { state.links = state.links.filter((l) => !removeLink.has(l.id)); changed = true; }

    // 4. remove leftover single-parent unions that no longer have any children
    const childCount = {};
    state.links.forEach((l) => (childCount[l.union] = (childCount[l.union] || 0) + 1));
    const before = state.unions.length;
    state.unions = state.unions.filter((u) => !(u.b == null && !childCount[u.id]));
    if (state.unions.length !== before) changed = true;

    return changed;
  }

  function relayoutAndSave() { dedupeParentUnions(); autoLayout(); render(); save(); syncTitle(); }

  /* -------- undo / redo (Cmd/Ctrl+Z) -------- */
  function snapshot() { return JSON.stringify(exportObject()); }
  // Record the state BEFORE a change so it can be undone. Pass the pre-change
  // snapshot if you captured it earlier (e.g. before a drag), else it snapshots now.
  function pushUndo(pre) { undoStack.push(pre != null ? pre : snapshot()); if (undoStack.length > 80) undoStack.shift(); redoStack = []; }
  function restoreSnapshot(s) {
    try { loadObject(JSON.parse(s)); } catch (e) { return false; }
    selection = new Set(); marquee = null; updateMarquee();
    autoLayout(); render(); save(); syncTitle(); updateHiddenChip();
    return true;
  }
  function undo() {
    if (!undoStack.length) { toast("Nothing to undo"); return; }
    const cur = snapshot();
    if (restoreSnapshot(undoStack.pop())) { redoStack.push(cur); toast("Undone"); }
  }
  function redo() {
    if (!redoStack.length) { toast("Nothing to redo"); return; }
    const cur = snapshot();
    if (restoreSnapshot(redoStack.pop())) { undoStack.push(cur); toast("Redone"); }
  }
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return; // let text fields keep their own undo
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
  });

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

  // Group hidden people by the VISIBLE person their branch hangs off of, so each
  // hidden branch can show one "eye-with-a-slash" marker next to that person.
  function hiddenGroups() {
    const hidden = state.persons.filter((p) => isHidden(p.id)).map((p) => p.id);
    if (!hidden.length) return [];
    const hiddenSet = new Set(hidden);
    const vis = (id) => personById(id) && !isHidden(id);
    const parentsOf = (id) => {
      const out = [];
      parentLinksOfPerson(id).forEach((l) => { const u = unionById(l.union); if (u) { if (u.a) out.push(u.a); if (u.b) out.push(u.b); } });
      return out;
    };
    const spousesOf = (id) => state.unions.filter((u) => u.a === id || u.b === id).map((u) => (u.a === id ? u.b : u.a)).filter(Boolean);
    const anchorFor = (start) => {
      const seen = new Set(); const stack = [start];
      while (stack.length) {
        const cur = stack.pop(); if (seen.has(cur)) continue; seen.add(cur);
        const pars = parentsOf(cur); for (const pa of pars) if (vis(pa)) return pa;
        const sps = spousesOf(cur); for (const sp of sps) if (vis(sp)) return sp;
        [...pars, ...sps].forEach((n) => { if (hiddenSet.has(n) && !seen.has(n)) stack.push(n); });
      }
      return null;
    };
    const byAnchor = {};
    hidden.forEach((h) => { const a = anchorFor(h); if (a) (byAnchor[a] = byAnchor[a] || []).push(h); });
    return Object.keys(byAnchor).map((a) => ({ anchor: a, hidden: byAnchor[a] }));
  }

  function renderHiddenBadges() {
    hiddenGroups().forEach((grp) => {
      const pos = posOf(grp.anchor);
      const g = el("g", { class: "hidden-badge", "data-anchor": grp.anchor, transform: `translate(${pos.x + HALF + 14},${pos.y + HALF + 6})` });
      g.appendChild(el("circle", { class: "hidden-badge-bg", r: 13, cx: 0, cy: 0 }));
      // eye outline + pupil + slash
      g.appendChild(el("path", { class: "hidden-badge-mark", d: "M-7 0 Q0 -5.5 7 0 Q0 5.5 -7 0 Z", fill: "none" }));
      g.appendChild(el("circle", { class: "hidden-badge-pupil", cx: 0, cy: 0, r: 1.9 }));
      g.appendChild(el("line", { class: "hidden-badge-slash", x1: -7.5, y1: 6.5, x2: 7.5, y2: -6.5 }));
      g.appendChild(el("title", null, txt(grp.hidden.length + " hidden here — click to view")));
      gNodes.appendChild(g);
    });
  }

  // Lay out a small subset (the anchor + its hidden people) into its own mini
  // family tree: filter to the members, compute generations, then place each
  // couple over the centre of their children.
  function layoutMini(members) {
    const set = new Set(members);
    const persons = members.map(personById).filter(Boolean);
    const unions = state.unions.filter((u) => set.has(u.a) && (u.b == null || set.has(u.b)));
    const uById = {}; unions.forEach((u) => (uById[u.id] = u));
    const links = state.links.filter((l) => set.has(l.child) && uById[l.union]);
    const gen = computeGenerations(persons, unions, links, uById);
    const minG = Math.min(...persons.map((p) => gen[p.id] || 0));
    const genOf = (id) => (gen[id] || 0) - minG;
    const spouseOf = (id) => { const u = unions.find((uu) => (uu.a === id || uu.b === id) && uu.b != null); return u ? (u.a === id ? u.b : u.a) : null; };
    const childrenVia = (id) => { const us = unions.filter((u) => u.a === id || u.b === id).map((u) => u.id); return links.filter((l) => us.includes(l.union)).map((l) => l.child); };

    const COLW = 118, ROWH = 118;
    const x = {}; let cursor = 0; const placed = new Set();
    function placePerson(id) {
      if (placed.has(id)) return;
      placed.add(id);
      const sp = spouseOf(id); if (sp) placed.add(sp);
      const kids = [...new Set([...childrenVia(id), ...(sp ? childrenVia(sp) : [])])].filter((c) => set.has(c) && !placed.has(c));
      if (kids.length) {
        kids.forEach(placePerson);
        const cxs = kids.map((k) => x[k] || 0);
        const center = (Math.min(...cxs) + Math.max(...cxs)) / 2;
        if (sp) { x[id] = center - COLW / 2; x[sp] = center + COLW / 2; } else x[id] = center;
      } else if (sp) { x[id] = cursor; x[sp] = cursor + COLW; cursor += COLW * 2 + 34; }
      else { x[id] = cursor; cursor += COLW + 34; }
    }
    members.filter((id) => genOf(id) === 0).forEach(placePerson);
    members.forEach((id) => { if (!placed.has(id)) placePerson(id); });
    const pos = {}; members.forEach((id) => (pos[id] = { x: x[id] || 0, y: genOf(id) * ROWH }));
    return { pos, unions, links, uById, persons, COLW };
  }

  function renderMiniTreeSVG(members, anchorId) {
    const L = layoutMini(members);
    const NS = 17;
    const svg = el("svg", { class: "mini-tree" });
    const gL = el("g"), gN = el("g"); svg.appendChild(gL); svg.appendChild(gN);
    L.unions.forEach((u) => {
      const A = L.pos[u.a], B = u.b != null ? L.pos[u.b] : null; if (!A) return;
      let midX, midY, dropTop;
      if (B) {
        gL.appendChild(el("line", { class: "mini-link", x1: Math.min(A.x, B.x) + NS, y1: (A.y + B.y) / 2, x2: Math.max(A.x, B.x) - NS, y2: (A.y + B.y) / 2 }));
        midX = (A.x + B.x) / 2; midY = (A.y + B.y) / 2; dropTop = midY;
      } else { midX = A.x; midY = A.y; dropTop = A.y + NS; }
      const kids = L.links.filter((l) => l.union === u.id).map((l) => l.child).filter((c) => L.pos[c]);
      if (!kids.length) return;
      const busY = (dropTop + Math.min(...kids.map((c) => L.pos[c].y))) / 2;
      const kxs = kids.map((c) => L.pos[c].x);
      gL.appendChild(el("line", { class: "mini-link", x1: midX, y1: dropTop, x2: midX, y2: busY }));
      if (kids.length > 1) gL.appendChild(el("line", { class: "mini-link", x1: Math.min(...kxs), y1: busY, x2: Math.max(...kxs), y2: busY }));
      kids.forEach((c) => {
        const adopt = (L.links.find((l) => l.union === u.id && l.child === c) || {}).type === "adopted";
        gL.appendChild(el("line", { class: "mini-link" + (adopt ? " adopt" : ""), x1: L.pos[c].x, y1: busY, x2: L.pos[c].x, y2: L.pos[c].y - NS }));
      });
    });
    L.persons.forEach((p) => {
      const q = L.pos[p.id]; if (!q) return;
      const g = el("g", { class: "mini-node" + (p.id === anchorId ? " anchor" : ""), transform: `translate(${q.x},${q.y})` });
      let shape;
      if (p.sex === "female") shape = el("circle", { r: NS, cx: 0, cy: 0 });
      else if (p.sex === "unknown") shape = el("polygon", { points: `0,${-NS} ${NS},0 0,${NS} ${-NS},0` });
      else shape = el("rect", { x: -NS, y: -NS, width: NS * 2, height: NS * 2, rx: 4 });
      shape.setAttribute("class", "mini-shape");
      if (p.color) shape.setAttribute("style", "stroke:" + p.color);
      g.appendChild(shape);
      if (isDeceased(p)) g.appendChild(el("line", { class: "mini-deceased", x1: -NS, y1: NS, x2: NS, y2: -NS }));
      g.appendChild(el("text", { class: "mini-label", x: 0, y: NS + 13 }, txt(p.name)));
      gN.appendChild(g);
    });
    const xs = L.persons.map((p) => L.pos[p.id].x), ys = L.persons.map((p) => L.pos[p.id].y);
    const pad = 46;
    const minX = Math.min(...xs) - L.COLW / 2 - pad, maxX = Math.max(...xs) + L.COLW / 2 + pad;
    const minY = Math.min(...ys) - NS - pad, maxY = Math.max(...ys) + NS + 30 + pad;
    svg.setAttribute("viewBox", `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    return svg;
  }

  function openHiddenPopup(anchorId) {
    const grp = hiddenGroups().find((x) => x.anchor === anchorId);
    if (!grp) return;
    const anchor = personById(anchorId); if (!anchor) return;
    const members = [anchorId, ...grp.hidden];
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = `<div class="modal mini-modal"><h2>Hidden family</h2>
      <div class="hint">Connected to <b>${escapeHtml(anchor.name)}</b> but hidden from the main tree:</div>
      <div class="mini-wrap"></div>
      <div class="btn-row"><button class="btn" data-cancel>Close</button><button class="btn primary" data-ok>Show them on the tree</button></div></div>`;
    document.body.appendChild(back);
    back.querySelector(".mini-wrap").appendChild(renderMiniTreeSVG(members, anchorId));
    const close = () => back.remove();
    back.querySelector("[data-cancel]").onclick = close;
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    back.querySelector("[data-ok]").onclick = () => {
      grp.hidden.forEach((id) => { if (state.hidden) delete state.hidden[id]; });
      relayoutAndSave(); toast("Revealed " + grp.hidden.length + (grp.hidden.length === 1 ? " person" : " people")); close();
    };
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function syncTitle() {
    $("#treeTitle").textContent = state.title || "Family Tree";
    $("#treeSubtitle").textContent = state.subtitle || "";
    document.title = state.title || "Family Tree";
  }
  // The heading and subtitle double as rename fields: click to edit, Enter or
  // click-away to save, Esc to cancel. Off for read-only visitors.
  function setupTitleEditing() {
    [["#treeTitle", "title", "Name your family tree"], ["#treeSubtitle", "subtitle", "Add a subtitle (optional)"]].forEach(([sel, key, ph]) => {
      const el = $(sel); if (!el || el.dataset.editBound) return;
      el.dataset.editBound = "1";
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); el.blur(); }
        else if (e.key === "Escape") { e.preventDefault(); syncTitle(); el.blur(); }
      });
      el.addEventListener("blur", () => {
        const v = el.textContent.replace(/\s+/g, " ").trim();
        if ((state[key] || "") === v) { syncTitle(); return; }
        state[key] = v; save(); syncTitle();
        toast(key === "title" ? "Renamed" : "Subtitle updated");
      });
      el.dataset.ph = ph;
    });
    applyTitleEditability();
  }
  function applyTitleEditability() {
    ["#treeTitle", "#treeSubtitle"].forEach((sel) => {
      const el = $(sel); if (!el) return;
      el.setAttribute("contenteditable", readonly ? "false" : "true");
      el.setAttribute("spellcheck", "false");
      el.title = readonly ? "" : "Click to rename";
    });
  }

  /* wire toolbar + buttons */
  $("#tbAdd").onclick = () => { resetPersonForm(); $("#pName").focus(); ensurePanel(); };
  $("#tbUnion").onclick = openUnionModal;
  $("#tbChild").onclick = openChildModal;
  $("#tbArrange").onclick = () => { pushUndo(); state.manual = {}; selection = new Set(); relayoutAndSave(); fitView(); toast("Auto-arranged"); };
  $("#tbFit").onclick = fitView;
  $("#tbRearrange").onclick = () => setRearrange(!rearrange);
  $("#tbTidy").onclick = tidyUp;
  $("#tbMenu").onclick = () => {
    const tb = $("#toolbar"), collapsed = tb.classList.toggle("collapsed");
    $("#tbMenu").classList.toggle("active", !collapsed);
  };
  $("#sibLeftBtn").onclick = () => shiftSibling(-1);
  $("#sibRightBtn").onclick = () => shiftSibling(1);
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
  $("#backupBtn").onclick = () => backupToRepo(true);
  $("#importObitBtn").onclick = openImportModal;
  $("#scrapeAllBtn").onclick = scrapeAllObits;
  $("#tbImport").onclick = openImportModal;
  $("#addDocBtn").onclick = () => { const id = $("#personId").value; if (id) openAttachModal(id); };
  $("#obitPhotoBtn").onclick = () => { const id = $("#personId").value; if (id) usePhotoFromObit(personById(id)); };
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
    const imp = $("#tbImport"); if (imp) imp.style.display = "none";
    $("#tbArrange").style.display = "none";
    const tidy = $("#tbTidy"); if (tidy) tidy.style.display = "none";
    applyTitleEditability();
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
      $("#toolbar").classList.add("collapsed"); $("#tbMenu").classList.remove("active"); // tools tucked behind ☰
    }
    if (!readonly && dedupeParentUnions()) save();   // heal any duplicate parentage in existing data
    autoLayout(); render(); syncTitle(); setupTitleEditing();
    if (!readonly) setBackupStatus(BACKUP_ON() ? "on" : "off");
    // One-time: turn any already-attached obituary photos into node pictures.
    if (!readonly && !state.photoMigrated) {
      state.photoMigrated = true; save();
      migratePhotosFromObits().then((changed) => { if (changed) { save(); render(); } });
    }
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
    // normal editor. Prefer a newer published starter over an older saved copy:
    // when the built-in tree's version is higher than what's saved in this
    // browser, load the fresh tree (so updates always show and a stale local
    // copy — or a stray dragged node — can't get "stuck"). Local edits made
    // against the current version are still respected.
    const starter = window.FAMILY_TREE_STARTER;
    const starterV = (starter && typeof starter === "object" && starter.version) || 0;
    if (hasLocalData() && savedVersion() >= starterV) loadLocal();
    else if (starter && typeof starter === "object") {
      const hadLocal = hasLocalData();
      loadObject(starter);
      // A newer built-in tree just replaced the saved copy so name/data fixes
      // land — but carry over the user's own arrangements (dragged positions,
      // what they've hidden, where the view is centred) from the old local copy
      // so their rearranging isn't wiped by the update.
      if (hadLocal) { carryOverLocalPrefs(); save(); }
    }
    else if (hasLocalData()) loadLocal();
    boot();
  }

  init();
})();
