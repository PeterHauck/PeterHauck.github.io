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
    return { title: "Family Tree", subtitle: "", persons: [], unions: [], links: [], manual: {}, manualHidden: {}, hidden: {}, focus: [], version: 0 };
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
  // When `hiddenScope` is set the canvas shows ONLY that hidden branch (its seed
  // people + the hidden relatives hanging off them). Otherwise it shows everyone
  // who isn't hidden. Everything downstream (rendering, hover handles, the editor,
  // add/move) runs unchanged — only the visible set differs — so a hidden branch
  // behaves exactly like the main tree.
  let hiddenScope = null;
  const inView = (id) => hiddenScope ? hiddenScope.set.has(id) : !isHidden(id);
  const visiblePersons = () => state.persons.filter((p) => inView(p.id));
  const unionVisible = (u) => inView(u.a) && (u.b == null || inView(u.b));
  const visibleUnions = () => state.unions.filter(unionVisible);
  const visibleLinks = () => state.links.filter((l) => { const u = unionById(l.union); return inView(l.child) && u && unionVisible(u); });

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
  // Name parts <-> the display string on the tree.
  // Display order: First [Middle] ["Nickname"] [(Maiden)] Last.
  function composeName(p) {
    const bits = [];
    if (p.first) bits.push(p.first);
    if (p.middle) bits.push(p.middle);
    if (p.nickname) bits.push('"' + p.nickname + '"');
    if (p.maiden) bits.push("(" + p.maiden + ")");
    if (p.last) bits.push(p.last);
    return bits.join(" ").replace(/\s+/g, " ").trim();
  }
  // Compact label for the tree: the middle name is shortened to just its first
  // initial + a period ("Robert Steven Goos" → "Robert S. Goos"). Nickname and
  // maiden are kept as-is. People without stored name parts fall back to their
  // written name.
  function treeDisplayName(p) {
    if (p.first == null && p.last == null && p.middle == null) return p.name || "";
    const mid = (p.middle || "").trim();
    const initial = mid ? mid.charAt(0).toUpperCase() + "." : "";
    return composeName({ first: p.first, middle: initial, last: p.last, nickname: p.nickname, maiden: p.maiden }) || p.name || "";
  }
  // Split a written name into parts: pull a "nickname" and a (maiden), then take
  // the first token as first name, the last token as last name, the rest middle.
  function parseName(full) {
    let s = String(full || "");
    let nickname = "", maiden = "";
    const nick = s.match(/["“”'‘’]([^"“”'‘’]+)["“”'‘’]/); if (nick) { nickname = nick[1].trim(); s = s.replace(nick[0], " "); }
    const maid = s.match(/\(([^)]+)\)/); if (maid) { maiden = maid[1].trim(); s = s.replace(maid[0], " "); }
    const toks = s.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    const first = toks.shift() || "";
    const last = toks.length ? toks.pop() : "";
    const middle = toks.join(" ");
    return { first, middle, last, nickname, maiden };
  }
  // Resolve a person's name parts + display name from either explicit parts or a
  // plain `name` string.
  function nameParts(d) {
    const has = d.first || d.middle || d.last || d.nickname || d.maiden;
    const parts = has
      ? { first: d.first || "", middle: d.middle || "", last: d.last || "", nickname: d.nickname || "", maiden: d.maiden || "" }
      : parseName(d.name || "");
    parts.name = composeName(parts) || String(d.name || "").trim() || "Unnamed";
    return parts;
  }

  // One-time: fill First/Middle/Last/Nickname/Maiden on people that only have a
  // display name, by parsing quotes (nickname) and parentheses (maiden).
  function splitNames() {
    state.persons.forEach((p) => {
      if (p.first === undefined && p.last === undefined) {
        const np = parseName(p.name || "");
        p.first = np.first; p.middle = np.middle; p.last = np.last; p.nickname = np.nickname; p.maiden = np.maiden;
      }
    });
  }

  function addPerson(data) {
    const np = nameParts(data);
    const p = { id: uid(), name: np.name, first: np.first, middle: np.middle, last: np.last, nickname: np.nickname, maiden: np.maiden, birth: num(data.birth), death: num(data.death), birthDate: data.birthDate || null, deathDate: data.deathDate || null, deceased: !!data.deceased, sex: data.sex || "unknown", color: data.color || null, photo: data.photo || null, docs: data.docs || [] };
    state.persons.push(p);
    // Anyone added while inside a hidden branch stays hidden from the main tree.
    if (hiddenScope) { if (!state.hidden) state.hidden = {}; state.hidden[p.id] = true; }
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
    if (state.manualHidden) delete state.manualHidden[pid];
    if (state.hidden) delete state.hidden[pid];
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

  // Manual positions live in their own map per view: the main tree uses
  // state.manual; a hidden branch uses state.manualHidden. That keeps a branch
  // self-contained (its seed people don't drag their main-tree coordinates in)
  // and never disturbs the main layout.
  const posMap = () => hiddenScope ? (state.manualHidden || (state.manualHidden = {})) : state.manual;
  const posOf = (id) => posMap()[id] || layoutPos[id] || { x: 0, y: 0 };

  /* ============================================================= RENDER */
  function render() {
    // Inside a hidden branch, refresh which people belong to it (so ones you just
    // added show up) before drawing.
    if (hiddenScope) hiddenScope.set = new Set(hiddenMembersFrom(hiddenScope.seedIds).members);
    gNodes.textContent = "";
    gLinks.textContent = "";
    emptyState.style.display = state.persons.length ? "none" : "flex";

    busLevels = computeBusLevels();
    visibleUnions().forEach(renderUnion);
    visiblePersons().forEach(renderPerson);
    if (!hiddenScope) renderHiddenBadges();   // no eye-badges inside a hidden branch
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
    const lines = nameLines(treeDisplayName(p));
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

    // Four directional add-a-relative "+"s, revealed on hover (CSS). Left/right add
    // a spouse on that side; up adds a parent; down adds a child (below the label).
    if (!readonly) {
      const OFF = HALF + 20;
      const labelBottom = HALF + 6 + bgH;
      g.appendChild(dirPlus(p.id, "up", 0, -OFF, "Add a parent"));
      g.appendChild(dirPlus(p.id, "left", -OFF, 0, "Add a spouse / partner on the left"));
      g.appendChild(dirPlus(p.id, "right", OFF, 0, "Add a spouse / partner on the right"));
      g.appendChild(dirPlus(p.id, "down", 0, labelBottom + 18, "Add a child"));
      if (!hiddenScope) g.appendChild(hiddenPlus({ person: p.id }, OFF - 4, -OFF + 4));
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
  // Normalise a date the importer (or a person) hands us into strict ISO
  // "YYYY-MM-DD" — tolerant of unpadded months/days and written-out formats
  // ("1948-3-5", "1948/03/05", "March 5, 1948", "5 Mar 1948"). null if not a
  // real full date (year-only, blank, or unparseable — we never guess a day).
  const MONTHNUM = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12, jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  function mkISO(y, mo, da) {
    if (!(y >= 100 && mo >= 1 && mo <= 12 && da >= 1 && da <= 31)) return null;
    return y + "-" + String(mo).padStart(2, "0") + "-" + String(da).padStart(2, "0");
  }
  function normDate(s) {
    s = String(s == null ? "" : s).trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);            // 1948-3-5, 1948/03/05
    if (m) return mkISO(+m[1], +m[2], +m[3]);
    m = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/); // March 5, 1948
    if (m && MONTHNUM[m[1].toLowerCase()]) return mkISO(+m[3], MONTHNUM[m[1].toLowerCase()], +m[2]);
    m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})$/); // 5 March 1948
    if (m && MONTHNUM[m[2].toLowerCase()]) return mkISO(+m[3], MONTHNUM[m[2].toLowerCase()], +m[1]);
    return null;
  }

  // Find the first full date anywhere in a snippet (written-out, M/D/YYYY, or ISO).
  function firstDateIn(s) {
    s = String(s || "");
    let m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);   // Month D, YYYY
    if (m && MONTHNUM[m[1].toLowerCase()]) return mkISO(+m[3], MONTHNUM[m[1].toLowerCase()], +m[2]);
    m = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/);        // D Month YYYY
    if (m && MONTHNUM[m[2].toLowerCase()]) return mkISO(+m[3], MONTHNUM[m[2].toLowerCase()], +m[1]);
    m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);                                     // M/D/YYYY
    if (m) return mkISO(+m[3], +m[1], +m[2]);
    m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);                                       // YYYY-MM-DD
    if (m) return mkISO(+m[1], +m[2], +m[3]);
    return null;
  }
  // Pull a person's birth & death dates straight out of obituary TEXT, in the
  // browser — no server, no API cost. Obituaries phrase these very consistently:
  // a "born … <date>" clause, a "died / passed away … <date>" clause, and/or a
  // "<date> – <date>" header. Returns ISO dates + years ("" when not stated). We
  // never guess a day/month that isn't written; year-only stays year-only.
  const DATE_TOKEN = "(?:[A-Za-z]{3,9}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}\\/\\d{1,2}\\/\\d{4}|\\d{4}-\\d{1,2}-\\d{1,2})";
  function clauseDate(text, keywords) {
    // keyword … up to ~60 chars of anything ("on", "peacefully at home", etc.) … first date
    const re = new RegExp("(?:" + keywords + ")[\\s\\S]{0,60}?(" + DATE_TOKEN + ")", "i");
    const m = text.match(re);
    return m ? firstDateIn(m[1]) : null;
  }
  function parseObitDates(text) {
    text = String(text || "").replace(/\s+/g, " ");
    const out = { birthDate: "", deathDate: "", birthYear: "", deathYear: "" };
    if (!text) return out;
    // 1) explicit clauses take priority (most reliable, subject-specific)
    let birth = clauseDate(text, "born(?:\\s+on)?|date of birth|birth date");
    let death = clauseDate(text, "died|passed away|passed on|passed|entered into (?:rest|eternal rest)|departed this life|date of death|went home to|called home|went to be with");
    // 2) a "<date> – <date>" life-span header fills any gap
    const range = new RegExp("(" + DATE_TOKEN + ")\\s*[\\u2010-\\u2015~-]\\s*(" + DATE_TOKEN + ")");
    const rm = text.match(range);
    if (rm) { if (!birth) birth = firstDateIn(rm[1]); if (!death) death = firstDateIn(rm[2]); }
    if (birth) { out.birthDate = birth; out.birthYear = birth.slice(0, 4); }
    if (death) { out.deathDate = death; out.deathYear = death.slice(0, 4); }
    // 3) year-only life span "(1948 – 2025)" when no full dates were found
    if (!out.birthYear || !out.deathYear) {
      const yr = text.match(/\b(1[6-9]\d{2}|20\d{2})\s*[‐-―~-]\s*(1[6-9]\d{2}|20\d{2})\b/);
      if (yr) { if (!out.birthYear) out.birthYear = yr[1]; if (!out.deathYear) out.deathYear = yr[2]; }
    }
    return out;
  }
  function fmtDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ""); if (!m) return iso || "";
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return months[+m[2] - 1] + " " + (+m[3]) + ", " + m[1];
  }
  const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
  // Compact date for tight spots like the marriage line ("Jun 12, 1970").
  function fmtDateShort(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ""); if (!m) return iso || "";
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
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
    const kids = childLinksOfUnion(u.id).map((l) => l.child).filter((c) => personById(c) && inView(c));
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

  // Quick-add a child to a union: drop in a blank person, link them, and open the
  // form focused on the name so you just type and Save. Undoable.
  // ---- placing newly-added people next to their family (instead of off in auto-land) ----
  const hasPos = (id) => !!(posMap()[id] || layoutPos[id]);
  // Shift everyone at/right of x rightward by `width`, keeping their relative
  // positions, so a gap opens at x. Pins them so the shift survives re-layout.
  function makeRoomAt(x, width, exceptIds) {
    visiblePersons().forEach((p) => {
      if (exceptIds && exceptIds.has(p.id)) return;
      const q = posOf(p.id);
      if (q.x >= x) posMap()[p.id] = { x: q.x + width, y: q.y };
    });
  }
  const spotOccupied = (x, y, exceptId) => visiblePersons().some((p) => p.id !== exceptId && Math.abs(posOf(p.id).x - x) < COLW * 0.85 && Math.abs(posOf(p.id).y - y) < ROWH * 0.55);
  // Pin `id` at (x,y); if that spot is taken, open room by shifting the right side over.
  function placeAt(id, x, y) {
    if (spotOccupied(x, y, id)) makeRoomAt(x - COLW * 0.5, COLW, new Set([id]));
    posMap()[id] = { x, y };
  }
  const isManual = (id) => !!(id && posMap()[id]);
  // A new child goes next to the rightmost sibling (same row), or — if the first —
  // centred one row below the parents. Only pins a spot when that family is
  // MANUALLY arranged; for a purely auto-laid-out family, auto-layout already
  // places siblings correctly, so we leave the newcomer to it.
  function placeNewChild(u, childId) {
    const sibs = childLinksOfUnion(u.id).map((l) => l.child).filter((c) => c !== childId && personById(c) && inView(c));
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
    const pending = new Set(ids.filter((id) => personById(id) && inView(id)));
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

  // ---- shared add-a-relative actions (used by the tree + menu and the profile) ----
  const guessSpouseSex = (p) => (p && p.sex === "male") ? "female" : (p && p.sex === "female") ? "male" : "unknown";
  // Focus a freshly-added blank person so you can just type their name and Save.
  function focusNewPerson(np, msg) {
    selectedId = np.id;
    relayoutAndSave();
    ensurePanel(); fillPersonForm(np);
    const nameEl = $("#pFirst"); if (nameEl) { nameEl.focus(); nameEl.select(); }
    toast(msg || "Added — type their name and Save");
  }

  // Add a NEW blank spouse/partner on a chosen side of a person and name them.
  function quickAddSpouse(personId, side) {
    if (readonly) return;
    const p = personById(personId); if (!p) return;
    pushUndo();
    const sp = addPerson({ name: "New spouse", sex: guessSpouseSex(p) });
    addUnion(personId, sp.id, "married");
    const pp = posOf(personId);
    placeAt(sp.id, pp.x + (side === "left" ? -COLW : COLW), pp.y);   // pin to the clicked side
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

  // Add a NEW blank parent above a person. If they already have one known parent,
  // the new person becomes that parent's partner (second parent); otherwise a new
  // single-parent couple is created and the person is linked as its child.
  function quickAddParent(personId) {
    if (readonly) return;
    const p = personById(personId); if (!p) return;
    pushUndo();
    const par = addPerson({ name: "New parent", sex: "unknown" });
    const pu = parentLinksOfPerson(personId).map((l) => unionById(l.union)).find(Boolean);
    if (pu && pu.b == null && pu.a !== par.id) {
      pu.b = par.id;                                   // fill the empty second-parent slot
      const ax = posOf(pu.a); placeAt(par.id, ax.x + COLW, ax.y);
    } else {
      const u = addUnion(par.id, null, "married");
      addChild(u.id, personId, "bio");
      const pp = posOf(personId); placeAt(par.id, pp.x, pp.y - ROWH);
    }
    focusNewPerson(par, "Added parent — type their name and Save");
  }

  // Route a directional + (up/down/left/right) to the matching add action.
  function addInDirection(personId, dir) {
    if (dir === "up") return quickAddParent(personId);
    if (dir === "down") return quickAddChildOf(personId);
    return quickAddSpouse(personId, dir === "left" ? "left" : "right");
  }
  // The + on a couple's marriage line: add a child OF THAT MARRIAGE (attached to
  // the union, so it's linked to both parents at once).
  function quickAddChildToUnion(unionId) {
    if (readonly) return;
    const u = unionById(unionId); if (!u) return;
    pushUndo();
    const np = addPerson({ name: "New person", sex: "unknown" });
    addChild(u.id, np.id, "bio");
    placeNewChild(u, np.id);
    focusNewPerson(np);
  }
  function couplePlus(unionId, x, y) {
    const g = el("g", { class: "add-plus couple-plus", "data-union": unionId, transform: `translate(${x},${y})` });
    g.appendChild(el("circle", { class: "add-plus-hit", r: 20, cx: 0, cy: 0 }));
    g.appendChild(el("circle", { class: "add-plus-bg", r: 10, cx: 0, cy: 0 }));
    g.appendChild(el("line", { class: "add-plus-mark", x1: -5, y1: 0, x2: 5, y2: 0 }));
    g.appendChild(el("line", { class: "add-plus-mark", x1: 0, y1: -5, x2: 0, y2: 5 }));
    g.appendChild(el("title", null, txt("Add a child of this marriage")));
    return g;
  }
  // A "+hidden" handle: the eye-with-a-slash marker with a small + badge. Clicking
  // it starts a private sub-tree from the anchor person/couple — new people you add
  // there are kept off the main tree.
  function hiddenPlus(seed, x, y) {
    const attrs = { class: "add-plus hidden-plus", transform: `translate(${x},${y})` };
    if (seed.person) attrs["data-hidperson"] = seed.person;
    if (seed.union) attrs["data-hidunion"] = seed.union;
    const g = el("g", attrs);
    g.appendChild(el("circle", { class: "add-plus-hit", r: 20, cx: 0, cy: 0 }));
    g.appendChild(el("circle", { class: "add-plus-bg hidden-plus-bg", r: 11, cx: 0, cy: 0 }));
    g.appendChild(el("path", { class: "hidden-plus-mark", d: "M-6.5 0 Q0 -5 6.5 0 Q0 5 -6.5 0 Z", fill: "none" }));
    g.appendChild(el("circle", { class: "hidden-plus-pupil", cx: 0, cy: 0, r: 1.7 }));
    g.appendChild(el("line", { class: "hidden-plus-slash", x1: -7, y1: 6, x2: 7, y2: -6 }));
    g.appendChild(el("circle", { class: "hidden-plus-badge", cx: 9, cy: -9, r: 5.5 }));
    g.appendChild(el("line", { class: "hidden-plus-badgemark", x1: 6, y1: -9, x2: 12, y2: -9 }));
    g.appendChild(el("line", { class: "hidden-plus-badgemark", x1: 9, y1: -12, x2: 9, y2: -6 }));
    g.appendChild(el("title", null, txt("Start a hidden family here (kept off the main tree)")));
    return g;
  }
  // One directional + : a big invisible hit-circle (so it's easy to click and
  // bridges the gap from the node — no more "disappears as you reach for it") plus
  // the small visible badge.
  function dirPlus(personId, dir, x, y, label) {
    const g = el("g", { class: "add-plus dir-" + dir, "data-person": personId, "data-dir": dir, transform: `translate(${x},${y})` });
    g.appendChild(el("circle", { class: "add-plus-hit", r: 24, cx: 0, cy: 0 }));
    g.appendChild(el("circle", { class: "add-plus-bg", r: 11, cx: 0, cy: 0 }));
    g.appendChild(el("line", { class: "add-plus-mark", x1: -5, y1: 0, x2: 5, y2: 0 }));
    g.appendChild(el("line", { class: "add-plus-mark", x1: 0, y1: -5, x2: 0, y2: 5 }));
    g.appendChild(el("title", null, txt(label)));
    return g;
  }

  // When a child belongs to more than one parent couple (e.g. their birth parents
  // AND the relatives who adopted them), fan the descent lines across the top of
  // the shape so each is its own visible line — biological solid, adoptive dashed
  // — instead of stacking on top of each other.
  function childAttachX(childId, unionId, baseX) {
    const uids = [...new Set(parentLinksOfPerson(childId).map((l) => l.union))]
      .filter((uid) => { const u = unionById(uid); return u && inView(u.a) && (u.b == null || inView(u.b)); });
    if (uids.length <= 1) return baseX;
    const idx = Math.max(0, uids.indexOf(unionId));
    return baseX + (idx - (uids.length - 1) / 2) * 18;   // spread the attach points
  }

  function renderUnion(u) {
    const pa = personById(u.a); if (!pa) return;
    const pb = u.b != null ? personById(u.b) : null;
    const A = posOf(u.a), B = pb ? posOf(u.b) : null;
    const kids = childLinksOfUnion(u.id).map((l) => ({ l, p: personById(l.child) })).filter((k) => k.p && inView(k.p.id));
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
      // Marriage (and divorce) date, sitting just above the line.
      const dbits = [];
      if (u.marriage) dbits.push((u.status === "partners" ? "" : "m. ") + (isISODate(u.marriage) ? fmtDateShort(u.marriage) : u.marriage));
      if (u.status === "divorced" && u.divorce) dbits.push("div. " + u.divorce);
      if (dbits.length) {
        const dlabel = dbits.join("   ");
        gu.appendChild(el("rect", { class: "union-date-bg", x: midX - (dlabel.length * 3.3) - 4, y: y - 21, width: dlabel.length * 6.6 + 8, height: 15, rx: 4 }));
        gu.appendChild(el("text", { class: "union-date", x: midX, y: y - 10 }, txt(dlabel)));
      }
      if (!readonly) {
        // Hovering the marriage line reveals a + (add a child of this couple) and
        // a +hidden (start a private sub-tree from this couple). A wide invisible
        // hit-line keeps them reachable across the whole line.
        gu.appendChild(el("line", { class: "couple-hit", x1: left.x + HALF - 6, y1: y, x2: right.x - HALF + 6, y2: y }));
        gu.appendChild(couplePlus(u.id, midX, y));
        if (!hiddenScope) gu.appendChild(hiddenPlus({ union: u.id }, midX, y - 30));
      }
    } else {
      midX = A.x; midY = A.y; dropTop = A.y + HALF; // drop from the single parent's bottom
    }

    if (!kids.length) {
      // Childless couple: nothing to draw below. (Add a child from either
      // partner's "＋ child" handle.)
      gLinks.appendChild(gu);
      return;
    }

    // Colour the descent lines by the children's family so each set of lines is
    // traceable at a glance instead of a grey tangle.
    const famColor = kids.map((k) => k.p.color).find(Boolean) || (pa && pa.color) || (pb && pb.color) || null;
    const cstyle = famColor ? "stroke:" + famColor + ";stroke-width:2.8" : null;

    const childTops = kids.map((k) => ({ x: childAttachX(k.p.id, u.id, posOf(k.p.id).x), top: posOf(k.p.id).y - HALF - 8, type: k.l.type }));
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
    gLinks.appendChild(gu);
  }

  function txt(s) { return document.createTextNode(s); }

  /* ------------------------------------------------------- people list UI */
  function updatePeopleList() {
    const ul = $("#peopleList"); if (!ul) return; ul.textContent = "";
    const q = (($("#peopleFilter") && $("#peopleFilter").value) || "").trim().toLowerCase();
    // Default order: last name, then first name (then birth year).
    const lastOf = (p) => (p.last != null ? p.last : parseName(p.name).last || p.name || "").toLowerCase();
    const firstOf = (p) => (p.first != null ? p.first : parseName(p.name).first || "").toLowerCase();
    const sorted = state.persons.slice()
      .filter((p) => (hiddenScope ? inView(p.id) : true) && (!q || p.name.toLowerCase().includes(q)))
      .sort((a, b) => lastOf(a).localeCompare(lastOf(b)) || firstOf(a).localeCompare(firstOf(b)) || (a.birth || 9999) - (b.birth || 9999));
    if (!sorted.length) {
      const li = document.createElement("li"); li.className = "pm-empty";
      li.textContent = q ? "No one matches “" + q + "”." : "No people yet.";
      ul.appendChild(li); return;
    }
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
    const focus = ids.filter((id) => personById(id) && inView(id));
    if (!focus.length) return fitView();
    const fp = focus.map((id) => posOf(id));
    const cx = fp.reduce((s, p) => s + p.x, 0) / fp.length;
    const cy = fp.reduce((s, p) => s + p.y, 0) / fp.length;
    // gather the immediate family to size the zoom
    const set = new Set(focus);
    focus.forEach((id) => {
      unionsOfPerson(id).forEach((u) => {
        [u.a, u.b].forEach((x) => { if (x != null && inView(x)) set.add(x); });
        childLinksOfUnion(u.id).forEach((l) => { if (inView(l.child)) set.add(l.child); });
      });
      parentLinksOfPerson(id).forEach((l) => {
        const u = unionById(l.union); if (!u) return;
        [u.a, u.b].forEach((x) => { if (x != null && inView(x)) set.add(x); });
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
    if (plus && !readonly) {
      // Directional add / couple-child / hidden-branch: swallow the pointer so it
      // can't also start a pan/drag.
      try { svg.releasePointerCapture(e.pointerId); } catch (_) {}
      const dir = plus.getAttribute("data-dir");
      const cu = plus.getAttribute("data-union");
      const hp = plus.getAttribute("data-hidperson");
      const hu = plus.getAttribute("data-hidunion");
      if (dir) addInDirection(plus.getAttribute("data-person"), dir);
      else if (cu) quickAddChildToUnion(cu);
      else if (hp) startHiddenBranch([hp]);
      else if (hu) { const u = unionById(hu); if (u) startHiddenBranch([u.a, u.b].filter(Boolean)); }
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
      for (const pid in drag.starts) posMap()[pid] = { x: drag.starts[pid].x + wdx, y: drag.starts[pid].y + wdy };
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
      // a tap on a person (no real movement): on mobile, open their read-only
      // profile card; on desktop, select into the editor.
      else if (drag && drag.mode === "pan" && drag.tapId && !drag.moved) { if (isMobileView()) openProfileCard(drag.tapId); else selectPerson(drag.tapId); }
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
    const sibs = childLinksOfUnion(union).map((l) => l.child).filter((c) => personById(c) && inView(c));
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
    a.forEach(({ pid, p }) => (posMap()[pid] = { x: p.x + delta, y: p.y }));
    b.forEach(({ pid, p }) => (posMap()[pid] = { x: p.x - delta, y: p.y }));
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
        if (Math.abs(it.y - ty) > 0.5) { posMap()[it.id] = { x: it.x, y: ty }; moved++; }
      }
    }
    if (!moved) { toast("Everything's already lined up"); return; }
    pushUndo(pre);
    save(); render();
    toast("Tidied up " + moved + " " + (moved === 1 ? "person" : "people") + " (Cmd+Z to undo)");
  }
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
    // Fall back to parsing the display name for any person not yet split into parts.
    const np = (p.first !== undefined || p.last !== undefined || p.middle !== undefined) ? p : parseName(p.name);
    $("#pFirst").value = np.first || "";
    $("#pMiddle").value = np.middle || "";
    $("#pLast").value = np.last || "";
    $("#pNick").value = np.nickname || "";
    $("#pMaiden").value = np.maiden || "";
    $("#pName").value = p.name || "";
    $("#pBirth").value = p.birth == null ? "" : p.birth;
    $("#pDeath").value = p.death == null ? "" : p.death;
    $("#pBirthDate").value = p.birthDate || "";
    $("#pDeathDate").value = p.deathDate || "";
    // Expand the "Exact dates" section when there's a full date to show, so
    // imported day/month dates are visible without hunting for the toggle.
    const exd = document.querySelector(".exact-dates"); if (exd) exd.open = !!(p.birthDate || p.deathDate);
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
  // Marriage / divorce date (free text — a year like "1950" or a full date). Empty clears it.
  function relSetUnionField(unionId, field, val, personId) { pushUndo(); const u = unionById(unionId); if (u) { val = (val || "").trim(); if (val) u[field] = val; else delete u[field]; } refreshRel(personId); }
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
    pickPerson("Add a parent", "Pick an existing person as a parent, or create a new one. If this person already has one parent, the new one joins them as the second parent.",
      (pid) => {
        if (pid === personId) return toast("Pick someone else");
        pushUndo();
        const parId = pid || addPerson({ name: "New parent", sex: "unknown" }).id;
        const existing = parentLinksOfPerson(personId).map((l) => unionById(l.union)).find(Boolean);
        if (existing && existing.b == null && existing.a !== parId) existing.b = parId;   // fill the empty slot
        else { const u = unionsOfPerson(parId)[0] || addUnion(parId, null, "married"); addChild(u.id, personId, "bio"); }
        if (!pid) focusNewPerson(personById(parId), "Added parent — type their name and Save");
        else refreshRel(personId);
      }, [personId]);
  }
  function relAddSibling(personId) {
    const pl = parentLinksOfPerson(personId)[0];
    if (!pl) return toast("Add a parent first — siblings share a parent");
    relAddChild(pl.union, personId);
  }
  // Detach ONE parent (not the whole couple): if the other parent stays, the child
  // is re-pointed to a single-parent union of that other parent.
  function relRemoveParent(pid, parId, linkId) {
    const par = personById(parId);
    if (!confirm("Remove " + (par ? par.name : "this parent") + " as a parent of " + (personById(pid) || {}).name + "? Both people stay in the tree.")) return;
    pushUndo();
    const l = state.links.find((x) => x.id === linkId); if (!l) return;
    const u = unionById(l.union);
    const other = u ? (u.a === parId ? u.b : u.a) : null;
    if (!u || other == null) { deleteLink(l.id); }
    else { let ou = state.unions.find((x) => x.a === other && x.b == null); if (!ou) ou = addUnion(other, null, u.status || "married"); l.union = ou.id; }
    refreshRel(pid);
  }
  // Relationship nouns, gendered from the *other* person's sex.
  const nounParent = (s, adopted) => (adopted ? "Adoptive " : "") + (s === "male" ? (adopted ? "father" : "Father") : s === "female" ? (adopted ? "mother" : "Mother") : (adopted ? "parent" : "Parent"));
  const nounChild = (s, adopted) => (adopted ? "Adopted " : "") + (s === "male" ? (adopted ? "son" : "Son") : s === "female" ? (adopted ? "daughter" : "Daughter") : (adopted ? "child" : "Child"));
  const nounSibling = (s) => (s === "male" ? "Brother" : s === "female" ? "Sister" : "Sibling");
  const nounPartner = (s, status) => status === "divorced" ? (s === "male" ? "Ex-husband" : s === "female" ? "Ex-wife" : "Former partner")
    : status === "partners" ? "Partner" : (s === "male" ? "Husband" : s === "female" ? "Wife" : "Spouse");

  // The set of parent PEOPLE for a person (across all their parent unions).
  function parentsOf(pid) {
    const set = new Set();
    parentLinksOfPerson(pid).forEach((l) => { const u = unionById(l.union); if (u) { if (u.a) set.add(u.a); if (u.b) set.add(u.b); } });
    return set;
  }
  // Everyone who shares at least one parent with p (full or half siblings) — robust
  // even when parents are recorded through different unions.
  function siblingsOf(pid) {
    const mine = parentsOf(pid);
    if (!mine.size) return [];
    const set = new Set();
    state.persons.forEach((q) => {
      if (q.id === pid) return;
      const theirs = parentsOf(q.id);
      for (const x of theirs) { if (mine.has(x)) { set.add(q.id); break; } }
    });
    return [...set];
  }

  // Clean, scannable list of a person's DIRECT relations: one row per connected
  // person — their name (click to jump to them) and exactly what they are
  // (Father, Wife, Son, Sister…). Kind is an inline control where it's editable.
  function renderRelationships(p) {
    const sec = $("#relSection"), box = $("#relList"); if (!box || !sec) return;
    box.innerHTML = "";
    if (!p) { sec.hidden = true; return; }
    sec.hidden = false;
    const pid = p.id;

    const groupTitle = (t) => { const li = document.createElement("li"); li.className = "rel-group"; li.textContent = t; box.appendChild(li); };
    const nameBtn = (otherId) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "rel-nav";
      const q = personById(otherId); b.textContent = q ? q.name : "?";
      b.title = "Go to " + (q ? q.name : ""); b.onclick = () => { selectPerson(otherId); if (!isHidden(otherId)) centerOn(otherId); };
      return b;
    };
    const kindText = (label) => { const sp = document.createElement("span"); sp.className = "rel-kind static"; sp.textContent = label; return sp; };
    // Like kindText but clickable: shows the relationship as plain words (matching
    // the Siblings rows) and flips biological ⇄ adoptive on click.
    const kindToggle = (label, onToggle, title) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "rel-kind static toggle";
      b.textContent = label; b.title = title || "Click to switch between biological and adoptive";
      b.onclick = onToggle; return b;
    };
    const removeBtn = (fn) => { const b = document.createElement("button"); b.type = "button"; b.className = "rel-x"; b.textContent = "✕"; b.title = "Remove this relationship"; b.onclick = fn; return b; };
    const rowFor = (otherId, kindNode, xNode) => {
      const li = document.createElement("li"); li.className = "rel-item";
      li.appendChild(nameBtn(otherId)); li.appendChild(kindNode); if (xNode) li.appendChild(xNode);
      box.appendChild(li);
    };

    // ---- Parents ---- (one row per parent, gendered)
    const plinks = parentLinksOfPerson(pid);
    const parentRows = [];
    plinks.forEach((l) => {
      const u = unionById(l.union); if (!u) return;
      [u.a, u.b].forEach((parId) => {
        if (parId == null || !personById(parId)) return;
        parentRows.push({ parId, l });
      });
    });
    if (parentRows.length) {
      groupTitle("Parents");
      parentRows.forEach(({ parId, l }) => {
        const s = personById(parId).sex;
        const adopted = l.type === "adopted";
        const kn = kindToggle(nounParent(s, adopted), () => relSetChildType(l.id, adopted ? "bio" : "adopted", pid));
        rowFor(parId, kn, removeBtn(() => relRemoveParent(pid, parId, l.id)));
      });
    }

    // ---- Siblings ---- (derived; read-only)
    const sibs = siblingsOf(pid);
    if (sibs.length) {
      groupTitle("Siblings");
      sibs.forEach((sid) => rowFor(sid, kindText(nounSibling(personById(sid).sex)), null));
    }

    // ---- Partners ----
    const unions = unionsOfPerson(pid);
    if (unions.length) {
      groupTitle(unions.length > 1 ? "Partners" : "Partner");
      unions.forEach((u) => {
        const other = u.a === pid ? u.b : u.a;
        if (other == null || !personById(other)) return;
        const s = personById(other).sex;
        // Plain-text relationship word (matching Parents/Children/Siblings), click
        // to cycle married → partners → divorced.
        const stt = u.status || "married";
        const nextStatus = { married: "partners", partners: "divorced", divorced: "married" };
        const kn = kindToggle(nounPartner(s, stt), () => relSetStatus(u.id, nextStatus[stt], pid), "Click to change: married → partners → divorced");
        rowFor(other, kn, removeBtn(() => relUnlinkUnion(u.id, pid)));
        // marriage (exact date) / divorce (year only) for this couple, on their own line
        const st = u.status || "married";
        const dRow = document.createElement("li"); dRow.className = "rel-dates";
        const dateField = (label, field, type, val) => {
          const wrap = document.createElement("span"); wrap.className = "rel-date-field";
          const lab = document.createElement("span"); lab.className = "rel-date-label"; lab.textContent = label;
          const i = document.createElement("input");
          i.type = type; i.className = "rel-date" + (type === "date" ? " rel-date-full" : "");
          if (type === "text") i.placeholder = "year";
          i.value = val || "";
          i.onchange = () => relSetUnionField(u.id, field, i.value, pid);
          i.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); i.blur(); } };
          wrap.appendChild(lab); wrap.appendChild(i);
          return wrap;
        };
        // Marriage takes an exact date; only fill the picker from an ISO value
        // (a legacy year-only entry can't populate a date box but still shows on the tree).
        dRow.appendChild(dateField(st === "partners" ? "Together" : "Married", "marriage", "date", isISODate(u.marriage) ? u.marriage : ""));
        if (st === "divorced") dRow.appendChild(dateField("Divorced", "divorce", "text", u.divorce));
        box.appendChild(dRow);
      });
    }

    // ---- Children ----
    const kidLinks = [];
    unionsOfPerson(pid).forEach((u) => childLinksOfUnion(u.id).forEach((l) => { if (personById(l.child)) kidLinks.push(l); }));
    if (kidLinks.length) {
      groupTitle(kidLinks.length > 1 ? "Children" : "Child");
      kidLinks.forEach((l) => {
        const s = personById(l.child).sex;
        const adopted = l.type === "adopted";
        const kn = kindToggle(nounChild(s, adopted), () => relSetChildType(l.id, adopted ? "bio" : "adopted", pid));
        rowFor(l.child, kn, removeBtn(() => relRemoveLink(l.id, pid)));
      });
    }

    if (!parentRows.length && !sibs.length && !unions.length && !kidLinks.length) {
      const li = document.createElement("li"); li.className = "rel-none";
      li.textContent = "No relationships yet. Add one below, or use the ＋ handles on the tree.";
      box.appendChild(li);
    }

    // ---- Add buttons ----
    const addBar = document.createElement("li"); addBar.className = "rel-addbar";
    [["Parent", () => relAddParent(pid)], ["Sibling", () => relAddSibling(pid)], ["Partner", () => relAddPartner(pid)], ["Child", () => relAddChildOfPerson(pid)]]
      .forEach(([label, fn]) => { const b = document.createElement("button"); b.type = "button"; b.className = "btn small"; b.textContent = "＋ " + label; b.onclick = fn; addBar.appendChild(b); });
    box.appendChild(addBar);
  }
  // Add a child to this person; if they have no partner yet, a single-parent
  // union is created (only once the pick is confirmed, so cancelling adds nothing).
  function relAddChildOfPerson(personId) {
    pickPerson("Add a child", "Link an existing person as this person’s child, or create a new one.", (cid) => {
      if (cid === personId) return toast("Pick someone else");
      pushUndo();
      let u = unionsOfPerson(personId)[0];
      if (!u) u = addUnion(personId, null, "married");
      const childId = cid || addPerson({ name: "New person", sex: "unknown" }).id;
      addChild(u.id, childId, "bio");
      placeNewChild(u, childId);
      if (!cid) focusNewPerson(personById(childId));
      else { refreshRel(personId); toast("Child linked"); }
    }, [personId]);
  }

  function setSex(s) {
    formSex = s;
    document.querySelectorAll("#sexToggle button").forEach((b) => b.classList.toggle("active", b.dataset.sex === s));
    const mf = $("#maidenField"); if (mf) mf.hidden = (s !== "female");   // maiden name only for females
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
    const np = nameParts({ first: $("#pFirst").value.trim(), middle: $("#pMiddle").value.trim(), last: $("#pLast").value.trim(), nickname: $("#pNick").value.trim(), maiden: formSex === "female" ? $("#pMaiden").value.trim() : "" });
    const data = { name: np.name, birth: birthYear, death: deathYear, birthDate, deathDate, deceased: $("#pDeceased").checked, sex: formSex, color: formColor, photo: pendingPhoto };
    if (id) {
      const p = personById(id);
      Object.assign(p, { name: np.name, first: np.first, middle: np.middle, last: np.last, nickname: np.nickname, maiden: np.maiden, birth: num(data.birth), death: num(data.death), birthDate: data.birthDate, deathDate: data.deathDate, deceased: data.deceased, sex: data.sex, color: data.color || null, photo: data.photo });
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
  // Base64-encode a buffer in chunks. Spreading a big Uint8Array into
  // String.fromCharCode (or .apply) blows the call stack once the encrypted tree
  // includes photos — "Maximum call stack size exceeded" on backup. Chunking
  // keeps each call small and handles any size.
  function b64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    const CHUNK = 0x8000; // 32k bytes per call — safely under the arg limit
    for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    return btoa(bin);
  }
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const hasGzip = typeof CompressionStream === "function" && typeof DecompressionStream === "function";
  async function gzip(bytes) {
    const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  async function gunzip(bytes) {
    const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  async function encryptState(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    // Compress before encrypting so embedded photos/PDFs don't bloat the payload
    // (encrypted data can't be compressed afterwards). Single base64, not double —
    // together this roughly halves the size that goes to backup/publish, so big
    // trees stay under the server's request limit (413 Payload Too Large).
    let data = new TextEncoder().encode(JSON.stringify(exportObject()));
    let v = 1;
    if (hasGzip) { try { data = await gzip(data); v = 2; } catch (e) { v = 1; } }
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
    return JSON.stringify({ v, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
  }
  async function decryptState(password, payload) {
    // New payloads are a JSON object; older published data was wrapped in an extra
    // base64 layer (btoa) — accept both so anything already published still opens.
    const o = (typeof payload === "string" && payload.trim().charAt(0) === "{") ? JSON.parse(payload) : JSON.parse(atob(payload));
    const key = await deriveKey(password, unb64(o.salt));
    let pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(o.iv) }, key, unb64(o.ct)));
    if (o.v === 2) pt = await gunzip(pt);   // v2 = gzip-compressed before encryption
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
          const newIds = mergeExtraction(data);
          // Who is this obituary about? The existing person it's "for", else the
          // newly-added person named earliest in the text.
          let subj = forPerson;
          if (!subj && text && newIds && newIds.length) {
            const at = (id) => { const n = personById(id); return n ? text.toLowerCase().indexOf(n.name.trim().toLowerCase()) : -1; };
            const ranked = newIds.map((id) => ({ id, i: at(id) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i);
            subj = personById((ranked[0] || { id: newIds[0] }).id);
          }
          // Date backstop: if the extract didn't return the subject's exact dates,
          // read them precisely with the AI date-reader (handles the PDF/photo and
          // noisy prose correctly). Falls back to a rough text scan if it's offline.
          if (subj && (!subj.birthDate || !subj.deathDate)) {
            const src = text ? { text } : (payload.file ? { file: payload.file } : (url ? { url } : null));
            if (src) {
              status.textContent = "Reading " + subj.name + "’s dates…";
              try { applyObitDates(subj, await callDates(Object.assign({ passcode: pass, name: subj.name }, src))); }
              catch (e2) { if (e2.offline && text) applyObitDates(subj, parseObitDates(text)); }
            }
          }
          // An obituary means its subject has passed away.
          if (subj) subj.deceased = true;
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
    const yearOf = (year, date) => year || (date ? date.slice(0, 4) : "");
    (d.people || []).forEach((pp) => {
      const bDate = normDate(pp.birthDate), dDate = normDate(pp.deathDate);
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

  // Where a record's file lives for display/download: an embedded data-URL
  // (doc.content) OR a file committed to the repo (doc.path, served next to the
  // page). Externalising the binary to doc.path is what keeps the tree small so
  // it scales to any number of uploads.
  const docSrc = (doc) => (doc && (doc.content || (doc.path ? doc.path : "")));
  const extFor = (mt) => (mt === "application/pdf" ? "pdf" : mt === "image/png" ? "png" : mt === "image/webp" ? "webp" : mt === "image/gif" ? "gif" : "jpg");
  function shrinkImageDataUrl(dataUrl, max) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { try { resolve(downscale(img, max)); } catch (e) { resolve(dataUrl); } };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }
  // Store a record's binary in cloud storage (Vercel Blob) as its own file and
  // point the doc at its URL (clearing the in-tree copy). Returns true on success;
  // false means keep it embedded (cloud not set up / unreachable — nothing lost).
  async function storeRecordBinary(doc, dataUrl, pass) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || ""); if (!m) return false;
    const mt = m[1], b64 = m[2];
    const name = doc.id + "." + extFor(mt);
    try {
      const res = await fetch("api/store", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "putRecord", passcode: pass, name, base64: b64, contentType: mt }) });
      if (!res.ok) return false;
      const j = await res.json();
      if (!j || !j.url) return false;
      doc.path = j.url; doc.mediaType = mt; delete doc.content;   // path = public blob URL
      return true;
    } catch (e) { return false; }
  }

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

      // Make the node picture from the image BEFORE we externalise the file (we
      // need the pixels here; the stored record is downscaled separately).
      let setPic = false;
      if (!person.photo) {
        const picSrc = kind === "image" ? content : fetchedImage;
        if (picSrc) { const photo = await imageDataToPhoto(picSrc); if (photo) { person.photo = photo; setPic = true; } }
      }

      // Store the PDF/photo as its own repo file so the tree stays small and
      // scales to any number of uploads. Images are downscaled first. If the repo
      // isn't configured/reachable, the file stays embedded (still works).
      if ((kind === "pdf" || kind === "image") && content) {
        const toStore = kind === "image" ? await shrinkImageDataUrl(content, 1500) : content;
        let pass2 = ""; try { pass2 = localStorage.getItem("familyTree.importPass") || ""; } catch (e) {}
        let stored = false;
        if (pass2) {
          saveBtn.disabled = true; status.textContent = "Saving the file to your repository…";
          stored = await storeRecordBinary(doc, toStore, pass2);
          status.textContent = ""; saveBtn.disabled = false;
        }
        if (!stored) doc.content = toStore;   // keep it embedded as a fallback
      }

      if (!person.docs) person.docs = [];
      person.docs.push(doc);
      person.deceased = true;   // attaching an obituary means they've passed away
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
      const imgDoc = p.docs.find((d) => d && d.kind === "image" && docSrc(d));
      if (!imgDoc) continue;
      const photo = await imageDataToPhoto(docSrc(imgDoc));
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
    const imgDoc = docs.find((d) => d && d.kind === "image" && docSrc(d));
    if (imgDoc) {
      const photo = await imageDataToPhoto(docSrc(imgDoc));
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

  // Move every obituary file that's still embedded in the tree out to its own
  // file in cloud storage (Vercel Blob), shrinking the saved tree so it scales to
  // any number of uploads. Safe to re-run; needs the Blob store set up on Vercel.
  async function migrateRecordsToRepo() {
    if (readonly) return;
    const targets = [];
    state.persons.forEach((p) => (p.docs || []).forEach((d) => { if (d && (d.kind === "pdf" || d.kind === "image") && d.content && !d.path) targets.push(d); }));
    if (!targets.length) { toast("No embedded records to move — they're already stored as files"); return; }
    let pass = ""; try { pass = localStorage.getItem("familyTree.importPass") || ""; } catch (e) {}
    if (!pass) pass = prompt("One-time import passcode (set as IMPORT_PASSCODE on the Vercel site):") || "";
    if (!pass) return;
    try { localStorage.setItem("familyTree.importPass", pass); } catch (e) {}
    const btn = $("#migrateRecordsBtn"); if (btn) btn.disabled = true;
    let moved = 0, failed = 0;
    try {
      for (let i = 0; i < targets.length; i++) {
        const d = targets[i];
        if (btn) btn.textContent = "Moving records… (" + (i + 1) + " of " + targets.length + ")";
        const data = d.kind === "image" ? await shrinkImageDataUrl(d.content, 1500) : d.content;
        if (await storeRecordBinary(d, data, pass)) { moved++; save(); } else { failed++; }
      }
      if (moved) relayoutAndSave();   // re-save the (now smaller) tree; cloud save is scheduled from save()
      toast(moved ? ("Moved " + moved + " record" + (moved === 1 ? "" : "s") + " to your site" + (failed ? " (" + failed + " couldn’t be saved)" : "")) : "Couldn’t move records — is the Blob store set up on Vercel?");
    } catch (e) {
      toast(e.message || "Stopped");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "🗄️ Move records to cloud storage"; }
      render();
    }
  }

  // All obituary text we hold for a person (durable text copies + scraped text
  // from uploads), concatenated so date extraction can read across records.
  function obitTextOf(p) {
    return (p.docs || [])
      .map((d) => (d ? (d.text || (d.kind === "text" ? d.content : "")) : ""))
      .filter(Boolean).join("\n\n---\n\n").trim();
  }
  // Fill a person's date gaps from parsed obituary results ({birthDate, deathDate,
  // birthYear, deathYear}). Gap-only (never overwrites) and guarded: an exact
  // date is only accepted if its year matches any year already on the profile —
  // so a relative's date mentioned in the same obituary can't land on the wrong
  // person. Returns true if anything changed.
  function applyObitDates(p, r) {
    if (!p || !r) return false;
    let changed = false;
    const b = normDate(r.birthDate), dd = normDate(r.deathDate);
    const yearOk = (existing, iso) => existing == null || existing === +iso.slice(0, 4);
    if (!p.birthDate && b && yearOk(p.birth, b)) { p.birthDate = b; if (p.birth == null) p.birth = num(b.slice(0, 4)); changed = true; }
    if (!p.deathDate && dd && yearOk(p.death, dd)) { p.deathDate = dd; if (p.death == null) p.death = num(dd.slice(0, 4)); changed = true; }
    if (p.birth == null && r.birthYear && num(r.birthYear)) { p.birth = num(r.birthYear); changed = true; }
    if (p.death == null && r.deathYear && num(r.deathYear)) { p.death = num(r.deathYear); changed = true; }
    return changed;
  }
  // The best source we can hand the AI date-reader for a person: their obituary
  // text if we have it, else the raw PDF/image file, else a link to fetch.
  function obitSourceOf(p) {
    const docs = (p.docs || []).filter(Boolean);
    const text = obitTextOf(p);
    if (text) return { text };
    for (const d of docs) {
      if (d.kind !== "pdf" && d.kind !== "image") continue;
      const m = /^data:([^;]+);base64,(.*)$/.exec(d.content || "");
      if (m) return { file: { mediaType: m[1], data: m[2] } };
      if (d.path) return { url: new URL(d.path, location.href).href };   // externalised → let the server fetch it
    }
    const link = docs.find((d) => d.url);
    if (link) return { url: link.url };
    return null;
  }
  async function callDates(payload) {
    let res;
    try { res = await fetch("api/dates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); }
    catch (e) { const err = new Error("offline"); err.offline = true; throw err; }
    if (res.status === 404) { const err = new Error("no-server"); err.offline = true; throw err; }
    if (!res.ok) { let msg = "Reading dates failed (" + res.status + ")."; try { msg = (await res.json()).error || msg; } catch (e) {} throw new Error(msg); }
    return res.json();
  }

  // Read exact birth/death dates from every saved obituary and fill the gaps.
  // Uses the AI reader (api/dates) so it works on PDFs, photos and links too —
  // and correctly tells whose date is whose in a noisy obituary. Falls back to a
  // rough in-browser text parse only if the AI service can't be reached.
  async function backfillDatesFromObits() {
    if (readonly) return;
    const targets = state.persons.filter((p) => (!p.birthDate || !p.deathDate || p.birth == null || p.death == null) && obitSourceOf(p));
    if (!targets.length) { toast("No saved obituaries to read dates from"); return; }
    let pass = ""; try { pass = localStorage.getItem("familyTree.importPass") || ""; } catch (e) {}
    if (!pass) pass = prompt("One-time import passcode (set as IMPORT_PASSCODE on the Vercel site):") || "";
    if (!pass) return;
    try { localStorage.setItem("familyTree.importPass", pass); } catch (e) {}
    const btn = $("#backfillDatesBtn"); if (btn) btn.disabled = true;
    let filled = 0, offline = false, errMsg = "";
    try {
      for (let i = 0; i < targets.length; i++) {
        const p = targets[i];
        if (btn) btn.textContent = "Reading obituaries… (" + (i + 1) + " of " + targets.length + ")";
        const src = obitSourceOf(p);
        let r = null;
        try { r = await callDates(Object.assign({ passcode: pass, name: p.name }, src)); }
        catch (e) {
          if (e.offline) { offline = true; const t = obitTextOf(p); if (t) r = parseObitDates(t); }   // graceful degrade
          else if (/passcode/i.test(e.message || "")) throw e;
          else { errMsg = e.message; continue; }
        }
        if (r && applyObitDates(p, r)) { filled++; save(); }
      }
      const tail = offline ? " (AI reader offline — used a rough text scan; PDFs/links skipped)" : "";
      toast(filled ? ("Filled dates for " + filled + " " + (filled === 1 ? "person" : "people") + tail) : ("No new dates found" + (errMsg ? " — " + errMsg : tail)));
    } catch (e) {
      toast((e.message || "Stopped") + (filled ? " — filled " + filled + " first" : ""));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "📅 Fill dates from saved obituaries"; }
      const cur = personById(selectedId); if (cur) fillPersonForm(cur);
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
    const src = docSrc(doc);
    let bodyHtml;
    if (doc.kind === "text") bodyHtml = `<pre>${escapeHtml(doc.content || "")}</pre>`;
    else if (doc.kind === "pdf") bodyHtml = `<iframe src="${escapeHtml(src)}"></iframe>`;
    else if (doc.kind === "image") bodyHtml = `<img src="${escapeHtml(src)}" alt=""/>`;
    else bodyHtml = `<p class="hint">No archived copy is saved yet — open the original above, or edit this record to paste the text or upload a PDF for a permanent copy.</p>`;
    // Text scraped from a screenshot / PDF — the durable, searchable copy.
    if (doc.text && (doc.kind === "image" || doc.kind === "pdf")) {
      bodyHtml += `<div class="scraped-label">Scraped text</div><pre>${escapeHtml(doc.text)}</pre>`;
    }
    const srcLine = (doc.url ? `<a href="${escapeHtml(doc.url)}" target="_blank" rel="noopener">View original listing ↗</a> · ` : "") + "saved " + (doc.capturedAt || "");
    // Only ever one record viewer open, and it sits ABOVE the profile card.
    const prev = document.getElementById("docViewerBack"); if (prev) prev.remove();
    const back = document.createElement("div");
    back.className = "modal-backdrop docview-backdrop"; back.id = "docViewerBack";
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
    a.href = docSrc(doc);
    a.download = base + (doc.kind === "pdf" ? ".pdf" : "");
    a.click();
  }

  /* ================================================= read-only profile card (mobile) */
  const isMobileView = () => !!(window.matchMedia && window.matchMedia("(max-width: 720px)").matches);
  // The "owner" is a device holding the import passcode (the secret only used to
  // save the tree). Private notes are shown/edited only for the owner.
  const isOwner = () => { try { return !!(localStorage.getItem("familyTree.importPass") || "").trim(); } catch (e) { return false; } };
  function readFileDataURL(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file); }); }

  function personDatesLine(p) {
    const parts = [];
    if (p.birthDate) parts.push("Born " + fmtDate(p.birthDate));
    else if (p.birth != null) parts.push("Born " + p.birth);
    if (p.deathDate) parts.push("Died " + fmtDate(p.deathDate));
    else if (p.death != null) parts.push("Died " + p.death);
    else if (p.deceased) parts.push("Deceased");
    return parts.join("  ·  ");
  }
  function profileRelationships(pid) {
    const groups = [];
    const add = (title, items) => { if (items.length) groups.push({ title, items }); };
    const parents = [];
    parentLinksOfPerson(pid).forEach((l) => { const u = unionById(l.union); if (!u) return; [u.a, u.b].forEach((par) => { if (par != null && personById(par)) parents.push({ id: par, label: nounParent(personById(par).sex, l.type === "adopted") }); }); });
    add("Parents", parents);
    add("Siblings", siblingsOf(pid).map((sid) => ({ id: sid, label: nounSibling(personById(sid).sex) })));
    const partners = [];
    unionsOfPerson(pid).forEach((u) => { const o = u.a === pid ? u.b : u.a; if (o != null && personById(o)) partners.push({ id: o, label: nounPartner(personById(o).sex, u.status || "married") }); });
    add(partners.length > 1 ? "Partners" : "Partner", partners);
    const kids = [];
    unionsOfPerson(pid).forEach((u) => childLinksOfUnion(u.id).forEach((l) => { if (personById(l.child)) kids.push({ id: l.child, label: nounChild(personById(l.child).sex, l.type === "adopted") }); }));
    add(kids.length > 1 ? "Children" : "Child", kids);
    return groups;
  }
  function closeProfileCard() { const b = document.getElementById("profileCardBack"); if (b) b.remove(); }

  /* -------- comments: anyone with view access can leave a named comment -------- */
  function fmtCommentDate(at) { try { return new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); } catch (e) { return ""; } }
  async function loadComments(personId) {
    try { const r = await fetch("api/store?action=comments&personId=" + encodeURIComponent(personId)); if (!r.ok) return []; const j = await r.json(); return Array.isArray(j.comments) ? j.comments : []; }
    catch (e) { return null; }   // null = couldn't reach the server
  }
  async function deleteComment(personId, id, listEl) {
    if (!confirm("Delete this comment?")) return;
    let pass = ""; try { pass = localStorage.getItem("familyTree.importPass") || ""; } catch (e) {}
    try {
      await fetch("api/store", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "deleteComment", personId, id, passcode: pass }) });
      renderComments(listEl, personId, await loadComments(personId));
    } catch (e) { toast("Couldn’t delete"); }
  }
  function renderComments(listEl, personId, list) {
    listEl.innerHTML = "";
    if (list == null) { listEl.innerHTML = '<div class="pcard-subhint">Comments need the site to be online.</div>'; return; }
    if (!list.length) { listEl.innerHTML = '<div class="pcard-subhint">No comments yet — be the first.</div>'; return; }
    list.slice().sort((a, b) => (a.at || 0) - (b.at || 0)).forEach((c) => {
      const row = document.createElement("div"); row.className = "pcard-comment";
      const meta = document.createElement("div"); meta.className = "pcard-cmeta";
      meta.innerHTML = "<b>" + escapeHtml(c.name || "Someone") + "</b> <span>" + escapeHtml(fmtCommentDate(c.at)) + "</span>";
      const bodyEl = document.createElement("div"); bodyEl.className = "pcard-cbody"; bodyEl.textContent = c.text || "";
      row.appendChild(meta); row.appendChild(bodyEl);
      if (isOwner()) { const del = document.createElement("button"); del.className = "pcard-cdel"; del.textContent = "✕"; del.title = "Delete this comment"; del.onclick = () => deleteComment(personId, c.id, listEl); row.appendChild(del); }
      listEl.appendChild(row);
    });
  }
  function renderCommentComposer(personId, listEl) {
    const box = document.createElement("div"); box.className = "pcard-comment-new";
    let savedName = ""; try { savedName = localStorage.getItem("familyTree.commenterName") || ""; } catch (e) {}
    const nameInput = document.createElement("input"); nameInput.className = "pcard-cname"; nameInput.placeholder = "Your name"; nameInput.value = savedName; nameInput.maxLength = 60;
    const ta = document.createElement("textarea"); ta.className = "pcard-ctext"; ta.rows = 2; ta.placeholder = "Add a comment…"; ta.maxLength = 2000;
    const post = document.createElement("button"); post.className = "btn primary small"; post.textContent = "Post comment";
    post.onclick = async () => {
      const nm = nameInput.value.trim(), tx = ta.value.trim();
      if (!nm) { nameInput.focus(); toast("Add your name so others know who commented"); return; }
      if (!tx) { ta.focus(); return; }
      try { localStorage.setItem("familyTree.commenterName", nm); } catch (e) {}
      post.disabled = true;
      try {
        const res = await fetch("api/store", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "addComment", personId, name: nm, text: tx }) });
        if (!res.ok) { let m = "Couldn’t post the comment."; try { m = (await res.json()).error || m; } catch (e) {} toast(m); post.disabled = false; return; }
        ta.value = "";
        renderComments(listEl, personId, await loadComments(personId));
      } catch (e) { toast("Couldn’t reach the site to post"); }
      post.disabled = false;
    };
    box.appendChild(nameInput); box.appendChild(ta); box.appendChild(post);
    return box;
  }
  function openProfileCard(id) {
    const p = personById(id); if (!p) return;
    closeProfileCard();
    const back = document.createElement("div"); back.id = "profileCardBack"; back.className = "pcard-back";
    const card = document.createElement("div"); card.className = "pcard"; back.appendChild(card);
    // header
    const head = document.createElement("div"); head.className = "pcard-head";
    const av = document.createElement("div"); av.className = "pcard-photo " + (p.sex === "female" ? "f" : p.sex === "male" ? "m" : "u");
    if (p.photo) { const img = document.createElement("img"); img.src = p.photo; av.appendChild(img); } else av.textContent = "👤";
    if (isDeceased(p)) av.classList.add("deceased");
    head.appendChild(av);
    const hbox = document.createElement("div"); hbox.className = "pcard-headtext";
    const h = document.createElement("h2"); h.textContent = p.name || "Unnamed"; hbox.appendChild(h);
    const dline = personDatesLine(p); if (dline) { const d = document.createElement("div"); d.className = "pcard-dates"; d.textContent = dline; hbox.appendChild(d); }
    head.appendChild(hbox);
    const x = document.createElement("button"); x.className = "pcard-x"; x.setAttribute("aria-label", "Close"); x.textContent = "✕"; x.onclick = closeProfileCard; head.appendChild(x);
    card.appendChild(head);
    const body = document.createElement("div"); body.className = "pcard-body"; card.appendChild(body);
    const section = (title, cls) => { const s = document.createElement("div"); s.className = "pcard-section" + (cls ? " " + cls : ""); if (title) { const t = document.createElement("h3"); t.textContent = title; s.appendChild(t); } body.appendChild(s); return s; };
    // Photo — the owner can add/replace a picture from their phone. Photos that
    // came from an obituary (or the computer) are protected: they can't be removed
    // or replaced here, so saved obituary portraits are never lost by accident.
    if (isOwner()) {
      const s = section("Photo", "pcard-photo-sec");
      const mobileAdded = !!p.photoMobile;
      const fileInput = document.createElement("input"); fileInput.type = "file"; fileInput.accept = "image/*"; fileInput.style.display = "none";
      const setFromFile = async (file) => {
        if (!file) return;
        let photo = null; try { const dataUrl = await readFileDataURL(file); photo = await imageDataToPhoto(dataUrl); } catch (e) {}
        if (!photo) { toast("Couldn’t read that image"); return; }
        p.photo = photo; p.photoMobile = true;
        save(); try { cloudSaveTree(false); } catch (e) {}
        render(); openProfileCard(id); toast("Photo updated");
      };
      fileInput.onchange = () => setFromFile(fileInput.files[0]);
      const addBtn = (label) => { const b = document.createElement("button"); b.className = "btn small"; b.textContent = label; s.appendChild(b); return b; };
      if (!p.photo) {
        addBtn("📷 Add a photo").onclick = () => fileInput.click();
      } else if (mobileAdded) {
        addBtn("📷 Change photo").onclick = () => fileInput.click();
        const rm = addBtn("Remove photo"); rm.classList.add("danger");
        rm.onclick = () => {
          if (!confirm("Remove this photo?")) return;
          delete p.photo; delete p.photoMobile;
          save(); try { cloudSaveTree(false); } catch (e) {}
          render(); openProfileCard(id); toast("Photo removed");
        };
      } else {
        const note = document.createElement("div"); note.className = "pcard-subhint";
        note.textContent = "This photo is saved with their records and is protected here. You can change it on the computer.";
        s.appendChild(note);
      }
      s.appendChild(fileInput);
    }
    // relationships (read-only, tap a name to jump)
    const groups = profileRelationships(id);
    if (groups.length) {
      const s = section("Relationships");
      groups.forEach((g) => g.items.forEach((it) => {
        const row = document.createElement("div"); row.className = "pcard-rel";
        const nm = document.createElement("button"); nm.className = "pcard-relname"; nm.textContent = (personById(it.id) || {}).name || "?";
        nm.onclick = () => { const other = it.id; closeProfileCard(); if (!isHidden(other)) centerOn(other); openProfileCard(other); };
        const lb = document.createElement("span"); lb.className = "pcard-rellabel"; lb.textContent = it.label;
        row.appendChild(nm); row.appendChild(lb); s.appendChild(row);
      }));
    }
    // records / obituary
    const docs = (p.docs || []).filter(Boolean);
    if (docs.length) {
      const s = section(docs.length > 1 ? "Records" : "Record");
      docs.forEach((doc) => {
        const row = document.createElement("div"); row.className = "pcard-doc";
        const t = document.createElement("span"); t.textContent = doc.title || "Record";
        const v = document.createElement("button"); v.className = "btn small"; v.textContent = "View"; v.onclick = () => openDocViewer(doc);
        row.appendChild(t); row.appendChild(v); s.appendChild(row);
      });
    }
    // Notes — private to the owner
    if (isOwner()) {
      const s = section("Notes", "pcard-notes");
      const hint = document.createElement("div"); hint.className = "pcard-subhint"; hint.textContent = "Private — only you can see these."; s.appendChild(hint);
      const ta = document.createElement("textarea"); ta.className = "pcard-notes-input"; ta.rows = 4; ta.placeholder = "Add a private note about " + (p.first || p.name || "them") + "…"; ta.value = p.notes || ""; s.appendChild(ta);
      const bar = document.createElement("div"); bar.className = "pcard-notes-bar";
      const savedMsg = document.createElement("span"); savedMsg.className = "pcard-saved";
      const saveBtn = document.createElement("button"); saveBtn.className = "btn primary small"; saveBtn.textContent = "Save note";
      saveBtn.onclick = () => {
        const v = ta.value.trim(); if (v) p.notes = v; else delete p.notes;
        save(); try { cloudSaveTree(false); } catch (e) {}   // push so the note syncs to your other devices
        savedMsg.textContent = "Saved ✓"; setTimeout(() => { savedMsg.textContent = ""; }, 2500);
      };
      bar.appendChild(savedMsg); bar.appendChild(saveBtn); s.appendChild(bar);
    }
    // Comments — anyone with view access can leave one (prompted for a name)
    {
      const s = section("Comments", "pcard-comments");
      const listEl = document.createElement("div"); listEl.className = "pcard-comments-list";
      listEl.innerHTML = '<div class="pcard-subhint">Loading…</div>';
      s.appendChild(listEl);
      s.appendChild(renderCommentComposer(id, listEl));
      loadComments(id).then((list) => renderComments(listEl, id, list));
    }
    back.addEventListener("click", (e) => { if (e.target === back) closeProfileCard(); });
    document.body.appendChild(back);
  }

  /* ============================================================ IMPORT/EXPORT/SAVE */
  function exportObject() {
    return { title: state.title, subtitle: state.subtitle, persons: state.persons, unions: state.unions, links: state.links, manual: state.manual, manualHidden: state.manualHidden || {}, hidden: state.hidden, focus: state.focus, version: state.version || 0, photoMigrated: !!state.photoMigrated, namesSplit: !!state.namesSplit };
  }
  function loadObject(obj) {
    state = Object.assign(blankState(), {
      title: obj.title || "Family Tree", subtitle: obj.subtitle || "",
      persons: obj.persons || [], unions: obj.unions || [], links: obj.links || [], manual: obj.manual || {}, manualHidden: obj.manualHidden || {}, hidden: obj.hidden || {},
      focus: Array.isArray(obj.focus) ? obj.focus : [], version: obj.version || 0,
      photoMigrated: !!obj.photoMigrated,
      namesSplit: !!obj.namesSplit,
    });
  }
  /* -------- local storage: IndexedDB (roomy — holds photos/PDFs), with a
     localStorage fallback for tiny trees / private-mode browsers. This is what
     lets the tree live durably in your browser with no server and no GitHub. */
  const IDB = { db: "familyTreeDB", store: "kv", key: "tree.v1" };
  function idbOpen() {
    return new Promise((res, rej) => {
      let r; try { r = indexedDB.open(IDB.db, 1); } catch (e) { return rej(e); }
      r.onupgradeneeded = () => { try { r.result.createObjectStore(IDB.store); } catch (e) {} };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  function idbGet(key) { return idbOpen().then((db) => new Promise((res, rej) => { const q = db.transaction(IDB.store, "readonly").objectStore(IDB.store).get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); })); }
  function idbSet(key, val) { return idbOpen().then((db) => new Promise((res, rej) => { const tx = db.transaction(IDB.store, "readwrite"); tx.objectStore(IDB.store).put(val, key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); })); }
  function idbDel(key) { return idbOpen().then((db) => new Promise((res) => { const tx = db.transaction(IDB.store, "readwrite"); tx.objectStore(IDB.store).delete(key); tx.oncomplete = () => res(); tx.onerror = () => res(); })).catch(() => {}); }

  // The saved tree, read once at boot so the (synchronous) boot logic below can
  // consult it without awaiting.
  let localData = null;
  async function loadLocalData() {
    try { localData = (await idbGet(IDB.key)) || null; } catch (e) { localData = null; }
    if (!localData) {   // migrate an existing localStorage tree into IndexedDB (one time)
      let ls = null;
      try { const s = localStorage.getItem(STORE_KEY); if (s) ls = JSON.parse(s); } catch (e) {}
      if (ls && ls.persons) {
        localData = ls;
        try { await idbSet(IDB.key, ls); try { localStorage.removeItem(STORE_KEY); } catch (e) {} } catch (e) {}   // once safely in IDB, free localStorage
      }
    }
    // Ask the browser not to evict our data (best effort; no prompt in most browsers).
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  }

  function savedVersion() { return localData ? (localData.version || 0) : 0; }
  function downloadFile(name, content, type) {
    const blob = new Blob([content], { type: type || "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function save() {
    const obj = exportObject();
    localData = obj;
    const json = JSON.stringify(obj);
    idbSet(IDB.key, obj).catch((e) => console.warn("idb save failed", e));   // primary (roomy)
    try { localStorage.setItem(STORE_KEY, json); } catch (e) {}              // best-effort mirror (small trees)
    try { localStorage.setItem("familyTree.cloudDirty", "1"); } catch (e) {}  // local has edits not yet in the cloud
    scheduleCloudSave();   // durable copy to your site (Vercel Blob)
    scheduleBackup();      // optional legacy GitHub backup (only if turned on)
  }

  /* -------- durable cloud save: encrypted tree in Vercel Blob (no GitHub) ---- */
  let cloudTimer = null;
  const CLOUD_ON = () => { try { return localStorage.getItem("familyTree.cloudOn") === "1"; } catch (e) { return false; } };
  // A device that has BOTH the family password and the import passcode is the
  // owner and can push to the cloud — so their edits sync automatically without
  // needing to flip a separate "cloud on" switch first.
  const ownerCanCloud = () => { try { return !!((localStorage.getItem("familyTree.familyPass") || "") && (localStorage.getItem("familyTree.importPass") || "")); } catch (e) { return false; } };
  function setCloudStatus(st, msg) {
    const el = $("#cloudStatus"); if (!el) return;
    const map = { off: "Off — turn on to save a durable copy to your site", on: "On ✓ — saves automatically", pending: "Saving soon…", saving: "Saving to your site…", saved: "Saved to your site ✓", error: "Save failed" };
    el.textContent = (map[st] || "") + (msg ? " — " + msg : "");
    el.className = "hint backup-" + st;
  }
  function scheduleCloudSave() {
    if (readonly || (!CLOUD_ON() && !ownerCanCloud())) return;
    clearTimeout(cloudTimer);
    setCloudStatus("pending");
    cloudTimer = setTimeout(() => cloudSaveTree(false), 6000);   // coalesce a burst of edits
  }
  async function cloudSaveTree(manual) {
    if (readonly) return;
    let fam = ""; try { fam = localStorage.getItem("familyTree.familyPass") || ""; } catch (e) {}
    if (!fam) { if (!manual) return; fam = prompt("Choose a family password (used to encrypt your saved tree):") || ""; if (!fam) return; try { localStorage.setItem("familyTree.familyPass", fam); } catch (e) {} }
    let pass = ""; try { pass = localStorage.getItem("familyTree.importPass") || ""; } catch (e) {}
    if (!pass) { if (!manual) return; pass = prompt("One-time import passcode (set as IMPORT_PASSCODE on the Vercel site):") || ""; if (!pass) return; try { localStorage.setItem("familyTree.importPass", pass); } catch (e) {} }
    try { localStorage.setItem("familyTree.cloudOn", "1"); } catch (e) {}
    setCloudStatus("saving");
    try {
      const payload = await encryptState(fam);
      // Vercel caps a request body at ~4.5MB. Small trees go in one POST; larger
      // ones (lots of photos) are streamed up in parts and stitched server-side,
      // so saving keeps working no matter how big the tree gets.
      const CHUNK = 3_500_000;
      const post = async (b) => {
        const res = await fetch("api/store", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ passcode: pass }, b)) });
        if (!res.ok) { let msg = "failed (" + res.status + ")"; try { msg = (await res.json()).error || msg; } catch (e) {} if (res.status === 404) msg = "needs the Vercel site + a Blob store"; throw new Error(msg); }
        return res;
      };
      let done;
      if (payload.length <= CHUNK) {
        done = await post({ action: "saveTree", payload });
      } else {
        const total = Math.ceil(payload.length / CHUNK);
        for (let i = 0; i < total; i++) {
          await post({ action: "putPart", index: i, chunk: payload.slice(i * CHUNK, (i + 1) * CHUNK) });
          setCloudStatus("saving");
        }
        done = await post({ action: "commitTree", total, length: payload.length });
      }
      // Record the cloud's write time so this device knows it's in sync and won't
      // pull its own save back on the next load.
      try { const j = await done.json(); if (j && j.savedAt) localStorage.setItem("familyTree.cloudSavedAt", String(j.savedAt)); localStorage.setItem("familyTree.cloudDirty", "0"); } catch (e) {}
      setCloudStatus("saved");
      if (manual) toast("Saved to your site ✓");
    } catch (e) {
      setCloudStatus("error", e.message);
      // Surface the failure even for automatic saves — a silent push failure is
      // exactly what leaves other devices (your phone) stuck on an old copy.
      const now = Date.now();
      if (manual || now - lastCloudErrToast > 20000) { lastCloudErrToast = now; toast("Couldn’t save to your site: " + (e.message || "error")); }
    }
  }
  let lastCloudErrToast = 0;
  // Owner: pull the latest encrypted tree from the cloud and load it into the editor.
  async function cloudLoadTree() {
    let res; try { res = await fetch("api/store?action=getTree"); } catch (e) { toast("Couldn’t reach your site"); return false; }
    if (res.status === 404) { toast("No cloud copy saved yet"); return false; }
    if (!res.ok) { toast("Cloud load failed (" + res.status + ")"); return false; }
    let payload = "", savedAt = 0;
    try {
      const j = await res.json();
      payload = j.payload || ""; savedAt = j.savedAt || 0;
      // A big tree comes back as a direct Blob URL — fetch it straight from storage (cache-busted).
      if (!payload && j.url) { try { const rr = await fetch(bustUrl(j.url)); if (rr.ok) payload = await rr.text(); } catch (e) {} }
    } catch (e) {}
    if (!payload) { toast("No cloud copy found"); return false; }
    let fam = ""; try { fam = localStorage.getItem("familyTree.familyPass") || ""; } catch (e) {}
    if (!fam) fam = prompt("Your family password (to open the cloud copy):") || "";
    if (!fam) return false;
    try {
      const obj = await decryptState(fam, payload);
      try { localStorage.setItem("familyTree.familyPass", fam); localStorage.setItem("familyTree.cloudOn", "1"); if (savedAt) localStorage.setItem("familyTree.cloudSavedAt", String(savedAt)); } catch (e) {}
      loadObject(obj); relayoutAndSave(); fitView();
      toast("Loaded your latest tree from your site");
      return true;
    } catch (e) { toast("Wrong family password, or nothing to open"); return false; }
  }
  // Freshness probe: when did the cloud tree last change? (metadata only)
  async function cloudTreeInfo() {
    try { const r = await fetch("api/store?action=treeInfo"); if (!r.ok) return null; return await r.json(); }
    catch (e) { return null; }
  }
  // Manual "refresh from the cloud" (the ⟳ button). Pulls the latest cloud copy
  // and shows it — non-destructive: it never overwrites this device's saved copy,
  // so an owner can peek at the cloud without losing local edits. Also reports the
  // cloud's last-saved time so you can see how fresh it is.
  async function forcePullFromCloud() {
    toast("Checking your site for the latest…");
    const cp = await fetchCloudPayload();
    if (!cp || !cp.payload) { toast("No cloud copy found (your site may still be catching up)"); return; }
    let fam = ""; try { fam = localStorage.getItem("familyTree.familyPass") || ""; } catch (e) {}
    if (!fam) fam = prompt("Family password:") || "";
    if (!fam) return;
    try {
      const obj = await decryptState(fam, cp.payload);
      loadObject(obj);
      try { localStorage.setItem("familyTree.familyPass", fam); localStorage.setItem("familyTree.cloudSavedAt", String(cp.savedAt || 0)); } catch (e) {}
      autoLayout(); render(); fitView();
      let when = ""; try { when = cp.savedAt ? new Date(cp.savedAt).toLocaleString() : ""; } catch (e) {}
      toast(when ? ("Showing the latest — cloud saved " + when) : "Showing the latest from your site");
    } catch (e) {
      let when = ""; try { when = cp.savedAt ? new Date(cp.savedAt).toLocaleString() : ""; } catch (_) {}
      toast("That cloud copy didn’t open with your password" + (when ? " (cloud saved " + when + ")" : ""));
    }
  }
  // On boot, if the cloud copy is newer than what this device last synced, pull it
  // in — this is what makes edits on one device show up on the others (e.g. your
  // phone) instead of a stale browser copy sticking around. Returns true if it
  // loaded fresh cloud data (or took over the unlock flow).
  async function syncFromCloudIfNewer() {
    let synced = 0; try { synced = +(localStorage.getItem("familyTree.cloudSavedAt") || 0); } catch (e) {}
    let dirty = false; try { dirty = localStorage.getItem("familyTree.cloudDirty") === "1"; } catch (e) {}
    const info = await cloudTreeInfo();
    if (!info || !info.exists) return false;
    const newer = info.savedAt > synced;
    // When is it SAFE to replace this device's saved tree with the cloud copy?
    //  - a viewer's local is only a cache → replace whenever the cloud is newer.
    //  - the OWNER's local can hold real edits → only replace when we've genuinely
    //    tracked a newer cloud save (synced>0) AND have no unsynced local edits.
    //    This is what stops a reload from pulling an older/other cloud copy over
    //    the owner's current work.
    const safe = ownerCanCloud() ? (synced > 0 && newer && !dirty) : newer;
    if (!safe) return false;
    const cp = await fetchCloudPayload();
    if (!cp || !cp.payload) return false;
    const savedAt = cp.savedAt || info.savedAt;
    let fam = ""; try { fam = localStorage.getItem("familyTree.familyPass") || ""; } catch (e) {}
    if (fam) {
      try {
        const obj = await decryptState(fam, cp.payload);
        loadObject(obj);
        try { localStorage.setItem("familyTree.cloudSavedAt", String(savedAt)); } catch (e) {}
        try { await idbSet(IDB.key, exportObject()); } catch (e) {}   // refresh the local cache (no re-upload)
        return true;
      } catch (e) { return false; }   // wrong stored password → fall back to local
    }
    // Newer cloud data but no password on this device: unlock it into the editor.
    try { localStorage.setItem("familyTree.cloudSavedAt", String(savedAt)); } catch (e) {}
    showLock(true, cp.payload);
    return "lock";
  }
  // When you come back to the tab (or a phone restores a frozen page), quietly
  // pull the latest cloud copy if it's newer — so the tree stays current without
  // a manual refresh. Never clobbers an owner who has local edits not yet saved up.
  let refreshingBg = false;
  async function backgroundRefresh() {
    if (refreshingBg || document.hidden) return;
    if (!readonly) { try { if (localStorage.getItem("familyTree.cloudDirty") === "1") return; } catch (e) {} }
    refreshingBg = true;
    try {
      let synced = 0; try { synced = +(localStorage.getItem("familyTree.cloudSavedAt") || 0); } catch (e) {}
      let dirty = false; try { dirty = localStorage.getItem("familyTree.cloudDirty") === "1"; } catch (e) {}
      const info = await cloudTreeInfo();
      if (!info || !info.exists) return;
      const newer = info.savedAt > synced;
      // Same safety rule as syncFromCloudIfNewer: never replace the owner's local
      // tree unless the cloud is genuinely newer than our last tracked sync.
      const safe = ownerCanCloud() ? (synced > 0 && newer && !dirty) : newer;
      if (!safe) return;
      const cp = await fetchCloudPayload();
      if (!cp || !cp.payload) return;
      let fam = ""; try { fam = localStorage.getItem("familyTree.familyPass") || ""; } catch (e) {}
      if (!fam) return;
      const obj = await decryptState(fam, cp.payload);
      loadObject(obj);
      try { localStorage.setItem("familyTree.cloudSavedAt", String(cp.savedAt || info.savedAt)); } catch (e) {}
      autoLayout(); render();
      toast("Updated to the latest");
    } catch (e) {} finally { refreshingBg = false; }
  }
  // The live encrypted tree from the cloud (Vercel Blob) — where edits are saved —
  // with its server write time. Null if the cloud isn't set up/reachable.
  // Blob URLs are cache-busted (unique ts param) so the CDN can't hand back an
  // old overwritten copy — stale bytes won't decrypt with the current password.
  const bustUrl = (u) => u + (u.includes("?") ? "&" : "?") + "cb=" + Date.now();
  async function fetchCloudPayload() {
    try {
      const r = await fetch("api/store?action=getTree");
      if (!r.ok) return null;
      const j = await r.json();
      if (j.payload) return { payload: j.payload, savedAt: j.savedAt || 0 };
      if (j.big) {
        // Fast path: the direct blob URL. Some phones/browsers block this with
        // CORS (or it 403s), so only trust a clean 200; otherwise read the tree
        // back in slices through the function instead (always works).
        if (j.url) { try { const rr = await fetch(bustUrl(j.url)); if (rr.ok) { const t = await rr.text(); if (t && t.length === (j.size || t.length)) return { payload: t, savedAt: j.savedAt || 0 }; } } catch (e) {} }
        let out = "", total = j.size || Infinity;
        for (let s = 0; s < total; s += 3000000) {
          const pr = await fetch("api/store?action=getTreePart&start=" + s + "&len=3000000");
          if (!pr.ok) return null;
          const pj = await pr.json();
          if (typeof pj.size === "number") total = pj.size;
          if (!pj.chunk) break;
          out += pj.chunk;
        }
        return out ? { payload: out, savedAt: j.savedAt || 0 } : null;
      }
      if (j.url) { try { const rr = await fetch(bustUrl(j.url)); if (!rr.ok) return null; const t = await rr.text(); return t ? { payload: t, savedAt: j.savedAt || 0 } : null; } catch (e) { return null; } }
      return null;
    } catch (e) { return null; }
  }
  // The encrypted tree to unlock on a fresh device. Prefer the LIVE cloud copy
  // (that's where edits land); fall back to a committed family-data.js snapshot
  // only when the cloud isn't set up/reachable — otherwise a stale committed file
  // would keep overriding newer cloud edits.
  async function getPublishedPayload() {
    const cloud = await fetchCloudPayload();
    if (cloud) return cloud.payload;
    if (typeof window.FAMILY_TREE_DATA === "string" && window.FAMILY_TREE_DATA.length > 20) return window.FAMILY_TREE_DATA;
    return null;
  }

  /* -------- optional legacy backup: commit the encrypted tree to a GitHub repo -- */
  let backupTimer = null;
  const BACKUP_ON = () => { try { return localStorage.getItem("familyTree.backupOn") === "1"; } catch (e) { return false; } };
  function setBackupStatus(state, msg) {
    const el = $("#backupStatus"); if (!el) return;
    const map = { off: "Optional — off", on: "Auto-backup on ✓", pending: "Saving to repo soon…", saving: "Backing up…", saved: "Backed up to repo ✓", error: "Backup failed" };
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
  function hasLocalData() { return !!(localData && localData.persons && localData.persons.length); }
  function loadLocal() { if (localData) loadObject(localData); }
  // When a newer starter replaces the saved copy, keep everything the user made
  // their own from that old copy — the tree's name, dragged positions, hidden
  // people, the focus centre, any pictures / obituaries they added, and anyone
  // they added themselves — so an update never wipes their work.
  function carryOverLocalPrefs() {
    const old = localData;
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
    if (hiddenScope) { chip.hidden = true; return; }   // not meaningful inside a branch
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

  // A hidden sub-tree rooted at the given (visible) seed people: the seeds
  // themselves (plus any visible spouse so a couple shows together) and the whole
  // connected cluster of hidden relatives that hangs off them.
  function hiddenMembersFrom(seedIds) {
    const roots = new Set();
    (seedIds || []).forEach((id) => { if (personById(id)) roots.add(id); });
    [...roots].forEach((id) => {
      state.unions.forEach((u) => {
        if (u.a === id && u.b && !isHidden(u.b)) roots.add(u.b);
        if (u.b === id && u.a && !isHidden(u.a)) roots.add(u.a);
      });
    });
    const members = new Set(roots);
    const stack = [...roots];
    const neighbors = (id) => {
      const out = [];
      state.unions.forEach((u) => {
        if (u.a === id && u.b) out.push(u.b);
        if (u.b === id && u.a) out.push(u.a);
        if (u.a === id || u.b === id) childLinksOfUnion(u.id).forEach((l) => out.push(l.child));
      });
      parentLinksOfPerson(id).forEach((l) => { const u = unionById(l.union); if (u) { if (u.a) out.push(u.a); if (u.b) out.push(u.b); } });
      return out;
    };
    while (stack.length) {
      const cur = stack.pop();
      neighbors(cur).forEach((n) => {
        if (n == null || members.has(n) || !personById(n)) return;
        if (isHidden(n)) { members.add(n); stack.push(n); }   // only wander INTO hidden people
      });
    }
    return { members: [...members], roots: [...roots] };
  }

  // Entry point for the "+hidden" handles: open the editable pop-up rooted at the
  // clicked person or couple. New people added there are kept off the main tree.
  function startHiddenBranch(seedIds) {
    if (readonly) return;
    seedIds = (seedIds || []).filter((id) => personById(id));
    if (seedIds.length) enterHiddenScope(seedIds);
  }
  // The main-tree eye-badge opens the same hidden branch.
  function openHiddenPopup(anchorId) { if (personById(anchorId)) enterHiddenScope([anchorId]); }

  // Enter a hidden branch: the canvas now shows ONLY this branch — its seed
  // people plus the hidden relatives hanging off them — and behaves exactly like
  // the main tree (same node info, hover handles, editor, add/move). Everyone you
  // add while inside stays hidden from the main tree.
  function enterHiddenScope(seedIds) {
    hiddenScope = { seedIds: seedIds.slice(), set: new Set() };
    hiddenScope.set = new Set(hiddenMembersFrom(seedIds).members);
    selection = new Set(); marquee = null; drag = null;
    selectedId = null; resetPersonForm();
    const names = seedIds.map((id) => { const p = personById(id); return p ? p.name : ""; }).filter(Boolean);
    showHiddenBar(names.join(" & "));
    document.body.classList.add("in-hidden-scope");
    autoLayout(); render(); fitView();
  }
  function exitHiddenScope() {
    if (!hiddenScope) return;
    hiddenScope = null;
    const bar = document.getElementById("hiddenScopeBar"); if (bar) bar.hidden = true;
    document.body.classList.remove("in-hidden-scope");
    selection = new Set(); marquee = null; drag = null;
    selectedId = null; resetPersonForm();
    autoLayout(); render(); fitView();
  }
  function showHiddenBar(label) {
    let bar = document.getElementById("hiddenScopeBar");
    if (!bar) { bar = document.createElement("div"); bar.id = "hiddenScopeBar"; document.body.appendChild(bar); }
    bar.innerHTML = `<span class="hsb-eye" aria-hidden="true"></span>
      <span class="hsb-text">Hidden branch of <b>${escapeHtml(label || "")}</b> — anyone you add here stays off the main tree.</span>
      <button class="btn primary" id="hsbDone">Done — back to main tree</button>`;
    bar.querySelector("#hsbDone").onclick = exitHiddenScope;
    bar.hidden = false;
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
  $("#tbFit").onclick = fitView;
  { const sb = $("#tbSync"); if (sb) sb.onclick = forcePullFromCloud; }
  // Re-pull the latest when you return to the tab or a phone restores a frozen
  // page — keeps the view current without a manual refresh.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) backgroundRefresh(); });
  window.addEventListener("pageshow", (e) => { if (e.persisted) backgroundRefresh(); });
  window.addEventListener("focus", () => backgroundRefresh());
  $("#tbRearrange").onclick = () => setRearrange(!rearrange);
  $("#tbTidy").onclick = tidyUp;
  // ☰ opens the People list + menu (add a person, auto-arrange).
  function togglePeopleMenu(show) {
    const m = $("#peopleMenu"); if (!m) return;
    const vis = (show === undefined) ? m.hidden : show;
    m.hidden = !vis; $("#tbMenu").classList.toggle("active", vis);
    if (vis) { updatePeopleList(); const f = $("#peopleFilter"); if (f) setTimeout(() => f.focus(), 0); }
  }
  $("#tbMenu").onclick = () => togglePeopleMenu();
  $("#pmClose").onclick = () => togglePeopleMenu(false);
  $("#pmAdd").onclick = () => { togglePeopleMenu(false); resetPersonForm(); ensurePanel(); const n = $("#pFirst"); if (n) n.focus(); };
  $("#pmArrange").onclick = () => { pushUndo(); if (hiddenScope) state.manualHidden = {}; else state.manual = {}; selection = new Set(); relayoutAndSave(); fitView(); toast("Auto-arranged"); };
  $("#peopleFilter").addEventListener("input", () => updatePeopleList());
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
  // Prefill the family-password box with whatever this device currently uses.
  { const fp = $("#cloudFamilyPass"); if (fp) { try { fp.value = localStorage.getItem("familyTree.familyPass") || ""; } catch (e) {} } }
  $("#cloudSaveBtn").onclick = () => {
    // If the family password box is filled, adopt it before saving — this is how
    // you re-lock the cloud copy with the correct password so other devices open it.
    const fp = $("#cloudFamilyPass"); const v = fp ? fp.value.trim() : "";
    if (v) { try { localStorage.setItem("familyTree.familyPass", v); } catch (e) {} }
    cloudSaveTree(true);
  };
  $("#cloudLoadBtn").onclick = () => { if (confirm("Replace what's in this browser with the latest copy saved on your site?")) cloudLoadTree(); };
  $("#publishBtn").onclick = openPublishModal;
  $("#backupBtn").onclick = () => backupToRepo(true);
  $("#importObitBtn").onclick = openImportModal;
  $("#scrapeAllBtn").onclick = scrapeAllObits;
  $("#backfillDatesBtn").onclick = backfillDatesFromObits;
  $("#migrateRecordsBtn").onclick = migrateRecordsToRepo;
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
  $("#resetBtn").onclick = () => { if (confirm("Clear the entire tree from this browser?")) { state = blankState(); localData = null; try { localStorage.removeItem(STORE_KEY); } catch (e) {} idbDel(IDB.key); selectedId = null; resetPersonForm(); relayoutAndSave(); } };
  $("#panelToggle").onclick = () => $("#panel").classList.toggle("collapsed");
  function ensurePanel() { $("#panel").classList.remove("collapsed"); }
  function syncLegendToggle() { const l = $("#legend"); $("#legendToggle").textContent = l.classList.contains("min") ? "⌃" : "⌄"; }
  $("#legendToggle").onclick = (e) => { e.stopPropagation(); $("#legend").classList.toggle("min"); syncLegendToggle(); };
  // When collapsed to the centred pill, a click anywhere on it pulls the drawer up.
  $("#legend").addEventListener("click", () => { const l = $("#legend"); if (l.classList.contains("min")) { l.classList.remove("min"); syncLegendToggle(); } });
  $("#emptyAdd").onclick = () => { resetPersonForm(); $("#pFirst").focus(); };
  $("#emptyDemo").onclick = () => { loadObject(demoData()); relayoutAndSave(); fitView(); toast("Loaded example family"); };

  /* ============================================================ LOCK SCREEN */
  function showLock(intoEditor, payload) {
    // Try the entered password against EVERY copy we have — the live cloud copy
    // and any committed family-data.js snapshot — and open whichever it unlocks.
    // This keeps your password working even if one copy is newer, older, or was
    // saved with different settings.
    const committed = (typeof window.FAMILY_TREE_DATA === "string" && window.FAMILY_TREE_DATA.length > 20) ? window.FAMILY_TREE_DATA : null;
    const candidates = [];
    if (payload) candidates.push({ src: "cloud", data: payload });
    if (committed && committed !== payload) candidates.push({ src: "committed", data: committed });
    if (!candidates.length && committed) candidates.push({ src: "committed", data: committed });
    const lock = $("#lock"); lock.hidden = false;
    $("#lockForm").onsubmit = async (e) => {
      e.preventDefault();
      const pw = $("#lockPass").value;
      $("#lockErr").textContent = "";
      let obj = null, from = null;
      for (const c of candidates) { try { obj = await decryptState(pw, c.data); from = c.src; break; } catch (_) {} }
      if (!obj) { $("#lockErr").textContent = "Wrong password — try again."; return; }
      loadObject(obj);
      lock.hidden = true;
      try { localStorage.setItem("familyTree.familyPass", pw); } catch (e) {}
      // Only claim we're in sync with the cloud if the cloud copy is what opened.
      if (from === "cloud") cloudTreeInfo().then((info) => { if (info && info.savedAt) { try { localStorage.setItem("familyTree.cloudSavedAt", String(info.savedAt)); } catch (e) {} } });
      if (intoEditor) { readonly = false; save(); }
      else enterReadonly();
      boot();
    };
    $("#lockPass").focus();
  }
  function enterReadonly() {
    readonly = true;
    document.body.classList.add("readonly");
    // Hide the editing tools; leave ☰ (people list), fit and zoom for viewers.
    ["#tbImport", "#tbRearrange", "#tbTidy", "#pmAdd", "#pmArrange"].forEach((sel) => { const el = $(sel); if (el) el.style.display = "none"; });
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
      const l = $("#legend"); if (l) { l.classList.add("min"); const t = $("#legendToggle"); if (t) t.textContent = "⌃"; }
    }
    if (!readonly && dedupeParentUnions()) save();   // heal any duplicate parentage in existing data
    if (!readonly && !state.namesSplit) { splitNames(); state.namesSplit = true; save(); }   // one-time: split names into parts
    autoLayout(); render(); syncTitle(); setupTitleEditing();
    if (!readonly) { setCloudStatus(CLOUD_ON() ? "on" : "off"); setBackupStatus(BACKUP_ON() ? "on" : "off"); }
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

  async function init() {
    buildColorSwatches();
    setSex("male");
    setColor("");
    renderDocsForm(null);
    await loadLocalData();   // pull the saved tree out of IndexedDB (roomy, no server)
    const params = new URLSearchParams(location.search);
    const wantEdit = params.has("edit");
    // Cross-device sync: even when this browser has a local copy, check whether
    // the cloud has a newer one (e.g. edits made on another device) and pull it in
    // so the tree isn't a stale local snapshot. This is what makes updates show up
    // on your phone.
    if (hasLocalData()) {
      try {
        const r = await syncFromCloudIfNewer();
        if (r === "lock") return;             // unlocking newer cloud data took over
        if (r === true) { boot(); return; }   // loaded fresh cloud data
      } catch (e) {}
    }
    // The published tree can come from a committed family-data.js OR the cloud
    // copy (Vercel Blob) — so the family view and cross-device editing work with
    // no GitHub. Only look it up when this browser has no local copy.
    const published = hasLocalData() ? null : await getPublishedPayload();

    if (published && !hasLocalData() && !wantEdit) {
      // visitor: must unlock, read-only
      showLock(false, published);
      return;
    }
    if (published && wantEdit && !hasLocalData()) {
      // owner returning on another machine: unlock into the editor
      showLock(true, published);
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
    // Owner's editing device: if there are local edits that haven't reached the
    // cloud, push them once now so other devices — your phone — can pull the
    // latest. Only when this device actually has unsynced edits, so a device
    // holding a stale copy can never push it over good cloud data.
    if (!readonly && ownerCanCloud()) {
      let dirty = ""; try { dirty = localStorage.getItem("familyTree.cloudDirty") || ""; } catch (e) {}
      if (dirty === "1") setTimeout(() => cloudSaveTree(false), 1200);
    }
  }

  init();
})();
