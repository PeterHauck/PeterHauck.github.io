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
  let photoDirty = false;    // true only when the user changed/cleared the photo this edit
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
  let viewPreview = null;   // { view, set } while previewing a View on the canvas
  const inView = (id) => {
    if (viewPreview) return viewPreview.set.has(id);   // a view fully decides its own membership (may include chosen hidden branches)
    return hiddenScope ? hiddenScope.set.has(id) : !isHidden(id);
  };
  const visiblePersons = () => state.persons.filter((p) => inView(p.id));
  // A SIBLING GROUP is a union with nobody above it: brothers and sisters whose
  // parents aren't known. It has no couple, so it is visible through its members.
  const isSibGroup = (u) => !!u && u.a == null && u.b == null;
  const unionVisible = (u) => (isSibGroup(u)
    ? childLinksOfUnion(u.id).some((l) => inView(l.child))
    : inView(u.a) && (u.b == null || inView(u.b)));
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
  // Display order: First [Middle] ["Nickname"] [(Maiden)] Last [Suffix].
  function composeName(p) {
    const bits = [];
    if (p.first) bits.push(p.first);
    if (p.middle) bits.push(p.middle);
    if (p.nickname) bits.push('"' + p.nickname + '"');
    if (p.maiden) bits.push("(" + p.maiden + ")");
    if (p.last) bits.push(p.last);
    if (p.suffix) bits.push(p.suffix);
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
    return composeName({ first: p.first, middle: initial, last: p.last, nickname: p.nickname, maiden: p.maiden, suffix: p.suffix }) || p.name || "";
  }
  // Split a written name into parts: pull a "nickname" and a (maiden), peel a
  // trailing generational suffix (Jr., Sr., III, …), then take the first token
  // as first name, the last token as last name, the rest middle.
  function parseName(full) {
    let s = String(full || "");
    let nickname = "", maiden = "", suffix = "";
    const nick = s.match(/["“”'‘’]([^"“”'‘’]+)["“”'‘’]/); if (nick) { nickname = nick[1].trim(); s = s.replace(nick[0], " "); }
    const maid = s.match(/\(([^)]+)\)/); if (maid) { maiden = maid[1].trim(); s = s.replace(maid[0], " "); }
    const toks = s.replace(/,/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (toks.length > 2 && /^(jr|sr|ii|iii|iv|v|vi|vii)\.?$/i.test(toks[toks.length - 1])) suffix = toks.pop();
    const first = toks.shift() || "";
    const last = toks.length ? toks.pop() : "";
    const middle = toks.join(" ");
    return { first, middle, last, nickname, maiden, suffix };
  }
  // Resolve a person's name parts + display name from either explicit parts or a
  // plain `name` string.
  function nameParts(d) {
    const has = d.first || d.middle || d.last || d.nickname || d.maiden || d.suffix;
    const parts = has
      ? { first: d.first || "", middle: d.middle || "", last: d.last || "", nickname: d.nickname || "", maiden: d.maiden || "", suffix: d.suffix || "" }
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
        p.first = np.first; p.middle = np.middle; p.last = np.last; p.nickname = np.nickname; p.maiden = np.maiden; p.suffix = np.suffix;
      }
    });
  }

  function addPerson(data) {
    const np = nameParts(data);
    const p = { id: uid(), name: np.name, first: np.first, middle: np.middle, last: np.last, nickname: np.nickname, maiden: np.maiden, suffix: np.suffix, birth: num(data.birth), death: num(data.death), birthDate: data.birthDate || null, deathDate: data.deathDate || null, deceased: !!data.deceased, causeOfDeath: data.causeOfDeath || undefined, sex: data.sex || "unknown", color: data.color || null, photo: data.photo || null, docs: data.docs || [] };
    state.persons.push(p);
    // Anyone added while inside a hidden branch stays hidden from the main tree.
    if (hiddenScope) { if (!state.hidden) state.hidden = {}; state.hidden[p.id] = true; }
    return p;
  }
  const isDeceased = (p) => p.death != null || !!p.deceased;
  function num(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }

  // A merge folds in whatever the other copy has, so "I don't have them" and
  // "I got rid of them" have to be told apart — otherwise a deletion is undone
  // by the next sync. Every deliberate removal leaves a mark with the time, and
  // a merge honours marks from either side.
  const tombs = () => state.removed || (state.removed = {});
  const tombKey = { person: (id) => "p:" + id, union: (id) => "u:" + id, link: (u, c) => "l:" + u + ">" + c };
  const isRemoved = (key, map) => !!(map || state.removed || {})[key];
  function markRemoved(key) { tombs()[key] = Date.now(); }
  function deletePerson(pid) {
    markRemoved(tombKey.person(pid));
    state.persons = state.persons.filter((p) => p.id !== pid);
    // drop unions & links referencing this person
    const goneUnions = state.unions.filter((u) => u.a === pid || u.b === pid).map((u) => u.id);
    goneUnions.forEach((id) => markRemoved(tombKey.union(id)));
    state.links.forEach((l) => { if (l.child === pid || goneUnions.includes(l.union)) markRemoved(tombKey.link(l.union, l.child)); });
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
    markRemoved(tombKey.union(uid_));
    state.links.forEach((l) => { if (l.union === uid_) markRemoved(tombKey.link(l.union, l.child)); });
    state.unions = state.unions.filter((u) => u.id !== uid_);
    state.links = state.links.filter((l) => l.union !== uid_);
  }

  function addChild(unionId, childId, type) {
    if (state.links.some((l) => l.union === unionId && l.child === childId)) return;
    state.links.push({ id: uid(), union: unionId, child: childId, type: type || "bio" });
  }
  function deleteLink(id) {
    const l = state.links.find((x) => x.id === id);
    if (l) markRemoved(tombKey.link(l.union, l.child));
    state.links = state.links.filter((x) => x.id !== id);
  }

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
  // Where dragged positions are stored depends on what's on the canvas: the
  // master tree, a hidden branch, or a VIEW. Each view keeps its own private
  // arrangement — moving someone inside a view never moves them on the master
  // tree (and vice versa: unmoved people follow the master's arrangement).
  function unionDateLabel(u) {
    const dbits = [];
    if (u.marriage) dbits.push((u.status === "partners" ? "" : "m. ") + (isISODate(u.marriage) ? fmtDateShort(u.marriage) : u.marriage));
    if (u.status === "divorced" && u.divorce) dbits.push("div. " + u.divorce);
    return dbits.length ? dbits.join("   ") : "";
  }
  const unionBetween = (aId, bId) => state.unions.find((u) => (u.a === aId && u.b === bId) || (u.a === bId && u.b === aId));
  // The standard spacing for a couple: a consistent base, widened just enough
  // that this couple's marriage/divorce label always fits between their shapes.
  function coupleStandardGap(u) {
    const dlabel = unionDateLabel(u);
    const labelW = dlabel ? dlabel.length * 6.6 + 8 : 0;
    return Math.max(COLW + 12, labelW + 2 * HALF + 24);
  }
  // Two snap presets, chained left to right (the leftmost person stays put,
  //  everyone else lines up level beside the previous person):
  //   Snap wide  — the roomier standard, widened per couple so marriage/
  //                divorce dates always fit between the shapes.
  //   Snap close — a tighter standard for rows of siblings/children.
  // Both respect the same floors: shapes never overlap, and a couple can never
  // get closer than its date label needs.
  const SIBLING_GAP = 140;
  // The exact spacing "Snap close" / "Snap wide" would use between two people —
  // shared with the drag gravity so a hand-drag lands on the very same spot.
  function standardGap(aNk, bNk, mode) {
    const u = unionBetween(pidOf(aNk), pidOf(bNk));
    const dlabel = u ? unionDateLabel(u) : "";
    const floor = dlabel ? dlabel.length * 6.6 + 8 + 2 * HALF + 16 : 2 * HALF + 12;
    const base = mode === "sibling" ? SIBLING_GAP : (u ? coupleStandardGap(u) : COLW + 12);
    return Math.max(floor, base);
  }
  // Gravity while dragging: when the person lands within a whisker of a snap
  // spacing beside a neighbour on their row, ease exactly onto it. Hold Alt to
  // place them freely.
  const GRAVITY = 16;
  function gravityDX(nk, px, py, dragging) {
    const pid = pidOf(nk);
    let best = null, bd = GRAVITY;
    const consider = (oNk, q) => {
      if (dragging[oNk] !== undefined || pidOf(oNk) === pid) return;
      if (Math.abs(q.y - py) > HALF * 1.5) return;   // only people on this row
      ["sibling", "couple"].forEach((mode) => {
        const g = standardGap(nk, oNk, mode);
        [q.x + g, q.x - g].forEach((c) => { const d = Math.abs(c - px); if (d < bd) { bd = d; best = c; } });
      });
    };
    visiblePersons().forEach((p) => consider(p.id, posOf(p.id)));
    Object.keys(copyPos).forEach((k) => consider(k, copyPos[k]));
    return best == null ? 0 : best - px;
  }
  function snapChainSpacing(mode) {
    const ids = [...selection].filter((nk) => personById(pidOf(nk)));
    if (ids.length < 2) return;
    pushUndo();
    const rows = ids.map((id) => ({ id, p: nkPos(id) })).sort((a, b) => a.p.x - b.p.x);
    const gapFor = (aId, bId) => standardGap(aId, bId, mode);
    // A 🔒 locked person in the selection becomes the anchor: everyone else
    // snaps OUTWARD from them. Two locked people would fight over the spacing,
    // so that's refused outright. With no lock, the leftmost anchors as before.
    const lockedCount = rows.filter((r) => isLocked(r.id)).length;
    if (lockedCount >= 2) { toast("⚠️ Can't snap — this selection has " + lockedCount + " locked people. Unlock all but one first."); return; }
    const anchorIdx = rows.findIndex((r) => isLocked(r.id));
    const start = anchorIdx >= 0 ? anchorIdx : 0;
    const moves = [];
    let x = rows[start].p.x;
    const y = rows[start].p.y;
    for (let i = start + 1; i < rows.length; i++) {
      x += gapFor(rows[i - 1].id, rows[i].id);
      moves.push({ id: rows[i].id, x, y, dx: x - rows[i].p.x });
    }
    x = rows[start].p.x;
    for (let i = start - 1; i >= 0; i--) {
      x -= gapFor(rows[i].id, rows[i + 1].id);
      moves.push({ id: rows[i].id, x, y, dx: x - rows[i].p.x });
    }
    applyToolMoves(moves, ids);
    save(); render();
    toast((mode === "sibling" ? "Snapped close" : "Snapped wide") + (anchorIdx >= 0 ? " around 🔒 " + (((personById(pidOf(rows[anchorIdx].id)) || {}).first) || "the locked person") : "") + " — " + rows.length + " people");
  }
  // Slide a couple sideways (keeping their own spacing) so they sit centered
  // over their children.
  function centerCoupleOnChildren(u, aNk, bNk) {
    aNk = aNk || u.a; bNk = bNk || u.b;
    // Work on the children this couple is actually joined to on screen: inside a
    // repeat, that cluster's copies; on the main tree, whichever appearance hangs
    // off this family's connector — which for a repeated child is their copy
    // here, not their main spot somewhere else entirely.
    const inCluster = isCopyKey(aNk);
    const kids = childLinksOfUnion(u.id).map((l) => l.child).filter((id) => personById(id) && inView(id))
      .map((id) => (inCluster ? nkFor(id, aNk) : nkInUnion(id, u.id)));
    if (!kids.length) { toast("This couple has no children to center on"); return; }
    pushUndo();
    // A repeat that hasn't been dragged sits wherever the family's branch puts
    // it — which shifts when the couple moves. Pin those where they are first,
    // so centring lands exactly and pressing it twice changes nothing.
    kids.forEach((nk) => { if (isCopyKey(nk) && !((state.echoPos || {})[nk])) { const q = nkPos(nk); if (q) (state.echoPos || (state.echoPos = {}))[nk] = { x: q.x, y: q.y }; } });
    const xs = kids.map((nk) => nkPos(nk).x);
    const target = (Math.min(...xs) + Math.max(...xs)) / 2;
    const A = nkPos(aNk), B = nkPos(bNk);
    const dx = target - (A.x + B.x) / 2;
    applyToolMoves([{ id: aNk, x: A.x + dx, y: A.y, dx }, { id: bNk, x: B.x + dx, y: B.y, dx }], kids);
    save(); render();
    toast("Centered over their children");
  }
  // Pinned people: their position is fixed — no drag, no layout tool, no
  // auto-arrange moves them until they're unlocked.
  const isLocked = (id) => !!(state.locked && state.locked[id]);
  /* -------- groups: people locked together at their current offsets -------- */
  const groupOf = (pid) => (state.groups || []).find((g) => g.members.includes(pid));
  const groupMatesOf = (nk) => { const g = groupOf(nk); return g ? g.members.filter((m) => m !== nk && personById(pidOf(m))) : []; };
  function makeGroup(ids) {
    if (!state.groups) state.groups = [];
    state.groups.forEach((g) => { g.members = g.members.filter((m) => !ids.includes(m)); });   // leave any old group first
    state.groups = state.groups.filter((g) => g.members.length >= 2);
    state.groups.push({ id: "g" + Math.random().toString(36).slice(2, 8), members: ids.slice() });
    save();
  }
  function ungroup(ids) {
    if (!state.groups) return;
    state.groups.forEach((g) => { g.members = g.members.filter((m) => !ids.includes(m)); });
    state.groups = state.groups.filter((g) => g.members.length >= 2);
    save();
  }
  // Layout tools call this instead of writing positions directly: each listed
  // person lands on their target, and their group-mates slide sideways by the
  // same distance so grouped people keep their set spacing. The anchors of an
  // action (e.g. the children being centered on) never get dragged along.
  function applyToolMoves(moves, anchorIds) {
    const done = new Set(moves.map((m) => m.id));
    const skip = new Set(anchorIds || []);
    moves.forEach((m) => { if (!isLocked(m.id)) nkSetPos(m.id, { x: m.x, y: m.y }); });
    moves.forEach((m) => {
      if (!m.dx || isLocked(m.id)) return;
      groupMatesOf(m.id).forEach((f) => {
        if (done.has(f) || skip.has(f) || isLocked(f)) return;
        done.add(f);
        const q = nkPos(f); nkSetPos(f, { x: q.x + m.dx, y: q.y });
      });
    });
  }

  // The parent couple every selected person has in common. A married-in spouse
  // counts through their partner — ALWAYS, even when their own parents are in
  // the tree — so adding a spouse to the selection can never cancel the match
  // (selecting a couple must still offer "Center on parents").
  function commonParentUnion(ids) {
    const pids = ids.map(pidOf);
    const inSel = new Set(pids);
    const ownUnions = (id) => parentLinksOfPerson(id).map((l) => l.union);
    const unionsFor = (id) => {
      const set = new Set(ownUnions(id));
      unionsOfPerson(id).forEach((u) => {
        const o = u.a === id ? u.b : u.a;
        if (o != null && inSel.has(o)) ownUnions(o).forEach((x) => set.add(x));
      });
      return set;
    };
    let common = null;
    for (const id of pids) {
      const us = unionsFor(id);
      if (!us.size) return null;
      if (common === null) common = us;
      else { common = new Set([...common].filter((x) => us.has(x))); if (!common.size) return null; }
    }
    const cands = [...common].map(unionById).filter(Boolean);
    if (cands.length < 2) return cands[0] || null;
    // Both spouses' families qualify (each partner counts through the other):
    // prefer the couple whose OWN children are in the selection, then the one
    // drawn nearest — never a family parked across the canvas.
    const anchor = ids[0];
    const xOf = (pid) => nkPos(nkFor(pid, anchor)).x;
    const selX = pids.reduce((s, id) => s + xOf(id), 0) / pids.length;
    const score = (u) => childLinksOfUnion(u.id).filter((l) => inSel.has(l.child)).length;
    const dist = (u) => Math.abs((u.b != null ? (xOf(u.a) + xOf(u.b)) / 2 : xOf(u.a)) - selX);
    return cands.slice().sort((a, b) => score(b) - score(a) || dist(a) - dist(b))[0];
  }
  // Slide the selected children sideways as a group (keeping their spacing)
  // so they sit centered under their parents.
  function centerSelectionOnParents() {
    const ids = [...selection].filter((nk) => personById(pidOf(nk)));
    const u = commonParentUnion(ids);
    if (!u) { toast("Select children who share the same parents"); return; }
    pushUndo();
    // parents resolved in the selection's context (a copy's parents may be the
    // cluster's copies, or main nodes — whichever appearance is drawn there)
    const aNk = nkFor(u.a, ids[0]), bNk = u.b != null ? nkFor(u.b, ids[0]) : null;
    const A = nkPos(aNk), B = bNk ? nkPos(bNk) : null;
    const target = B ? (A.x + B.x) / 2 : A.x;
    const xs = ids.map((nk) => nkPos(nk).x);
    const dx = target - (Math.min(...xs) + Math.max(...xs)) / 2;
    applyToolMoves(ids.map((nk) => { const q = nkPos(nk); return { id: nk, x: q.x + dx, y: q.y, dx }; }), [aNk, bNk].filter((x) => x != null));
    save(); render();
    toast("Centered under their parents");
  }
  // Evenly distribute the selected people: leftmost and rightmost stay put,
  // everyone between them gets equal spacing (each keeps their own row).
  function distributeSelection() {
    const ids = [...selection].filter((nk) => personById(pidOf(nk)));
    if (ids.length < 3) { toast("Select at least three people to space evenly"); return; }
    pushUndo();
    const rows = ids.map((id) => ({ id, p: nkPos(id) })).sort((a, b) => a.p.x - b.p.x);
    const first = rows[0].p.x, last = rows[rows.length - 1].p.x;
    const step = (last - first) / (rows.length - 1);
    applyToolMoves(rows.map((r, i) => ({ id: r.id, x: first + step * i, y: r.p.y, dx: first + step * i - r.p.x })), ids);
    save(); render();
    toast("Spaced evenly");
  }

  // Effective family colour: a person's own colour if set, otherwise inherited
  // from their FATHER's line (falling back to the mother's) — so newly added
  // people take their family's colour automatically without hand-painting.
  let colorMemo = null;
  function effColor(pid, seen) {
    if (!colorMemo) colorMemo = new Map();
    if (colorMemo.has(pid)) return colorMemo.get(pid);
    seen = seen || new Set();
    if (seen.has(pid)) return null;
    seen.add(pid);
    const p = personById(pid); if (!p) return null;
    let c = p.color || null;
    if (!c) {
      const parents = [];
      parentLinksOfPerson(pid).forEach((l) => {
        const u = unionById(l.union); if (!u) return;
        [u.a, u.b].forEach((x) => { const pp = x != null && personById(x); if (pp && !parents.includes(pp)) parents.push(pp); });
      });
      const father = parents.find((x) => x.sex === "male");
      const others = parents.filter((x) => x !== father);
      c = (father ? effColor(father.id, seen) : null) || others.map((x) => effColor(x.id, seen)).find(Boolean) || null;
    }
    colorMemo.set(pid, c);
    return c;
  }
  const posMap = () => {
    if (viewPreview) { const v = viewPreview.view; return v.manual || (v.manual = {}); }
    return hiddenScope ? (state.manualHidden || (state.manualHidden = {})) : state.manual;
  };
  // A view is its own tidy tree: people you haven't placed inside the view are
  // laid out compactly from the view's own members, rather than inheriting the
  // master's coordinates (which leaves big holes wherever a relative is absent).
  let viewLayout = null, viewLayoutKey = "";
  function viewAutoPos() {
    if (!viewPreview) return null;
    const ids = [...viewPreview.set].filter((id) => personById(id)).sort();
    const key = viewPreview.view.id + "|" + ids.join(",");
    if (viewLayoutKey === key && viewLayout) return viewLayout;
    const persons = state.persons.filter((p) => viewPreview.set.has(p.id));
    const unions = state.unions.filter((u) => viewPreview.set.has(u.a) && (u.b == null || viewPreview.set.has(u.b)));
    const uById = {}; unions.forEach((u) => (uById[u.id] = u));
    const links = state.links.filter((l) => uById[l.union] && viewPreview.set.has(l.child));
    let pos = {};
    try {
      const gen = computeGenerations(persons, unions, links, uById);
      pos = layoutComponent(new Set(persons.map((p) => p.id)), persons, unions, links, uById, gen).pos || {};
    } catch (e) { pos = {}; }
    viewLayout = pos; viewLayoutKey = key;
    return viewLayout;
  }
  const posOf = (id) => posMap()[id] || (viewPreview ? (viewAutoPos() || {})[id] : null) || layoutPos[id] || { x: 0, y: 0 };
  // Dragged connector heights live with the arrangement they were dragged in:
  // a View lays the same family out with its own rows, so a height measured on
  // the master tree means nothing there (and vice versa).
  const busMap = () => {
    if (viewPreview) { const v = viewPreview.view; return v.busOff || (v.busOff = {}); }
    return state.busOff || (state.busOff = {});
  };
  // …and so does where a repeated person was dragged to. A View puts the same
  // family somewhere else entirely, so one arrangement's coordinates are
  // meaningless in the other.
  const echoMap = () => {
    if (viewPreview) { const v = viewPreview.view; return v.echoPos || (v.echoPos = {}); }
    return state.echoPos || (state.echoPos = {});
  };
  // NODE KEYS: every APPEARANCE on the canvas has its own key — a main node is
  // just the person id, a copy across a jump is "unionId:personId". Selection,
  // locks, groups, drags and every layout tool work on appearances, so an
  // original and its copy are handled identically — and independently.
  const isCopyKey = (nk) => nk.indexOf(":") >= 0;
  const pidOf = (nk) => (isCopyKey(nk) ? nk.slice(nk.indexOf(":") + 1) : nk);
  let copyPos = {};   // where every copy actually drew this pass (nk -> {x,y})
  const nkPos = (nk) => (isCopyKey(nk) ? (copyPos[nk] || echoMap()[nk] || { x: 0, y: 0 }) : posOf(nk));
  const nkSetPos = (nk, q) => { if (isCopyKey(nk)) echoMap()[nk] = q; else posMap()[nk] = q; };
  // The appearance of `pid` in the same context as `likeNk`: inside a copy
  // cluster prefer that cluster's copy of pid; otherwise the main node.
  // The appearance of `pid` that union `uid` actually DRAWS: its repeat on that
  // family's branch when there is one, otherwise the main node. The lines on
  // screen connect these, so this is what the centring tools have to measure —
  // a child repeated under their parents is metres from their main spot.
  const nkInUnion = (pid, uid) => {
    const k = uid + ":" + pid;
    return (copyPos[k] || (state.echoPos || {})[k]) ? k : pid;
  };
  const nkFor = (pid, likeNk) => {
    if (likeNk && isCopyKey(likeNk)) {
      const k = likeNk.slice(0, likeNk.indexOf(":") + 1) + pid;
      if (copyPos[k] || echoMap()[k]) return k;
    }
    return pid;
  };

  /* ============================================================= RENDER */
  function render() {
    // Inside a hidden branch, refresh which people belong to it (so ones you just
    // added show up) before drawing.
    colorMemo = null;   // family colours recompute each draw (inheritance is live)
    if (hiddenScope) hiddenScope.set = new Set(hiddenMembersFrom(hiddenScope.seedIds).members);
    if (viewPreview) viewPreview.set = viewMembers(viewPreview.view.rules, viewPreview.view.withHidden, viewPreview.view.hide);
    gNodes.textContent = "";
    gLinks.textContent = "";
    emptyState.style.display = state.persons.length ? "none" : "flex";

    busLevels = computeBusLevels();
    copyPlacements = []; copySpots = {}; copyPos = {};   // repopulated by the unions below
    visibleUnions().forEach(renderUnion);
    visiblePersons().forEach((p) => renderPerson(p));
    copyPlacements.forEach((c) => renderPerson(c.p, c));   // copies are full person nodes
    if (!hiddenScope) renderHiddenBadges();   // no eye-badges inside a hidden branch
    updatePeopleList();
    $("#peopleCount").textContent = state.persons.length;
    updateHiddenChip();
    updateSelBar();
    updateViewSwitcher();
    { const b = $("#pmEnableEdit"); if (b) b.hidden = readonly || isOwner(); }
  }

  // Floating action bar for a group selection (Rearrange mode: drag a box
  // around people, or shift-click them). Lets the whole group be hidden at once.
  function updateSelBar() {
    let bar = document.getElementById("selBar");
    // Inside a hidden branch too: it's the same canvas and the same arranging
    // tools, and its layout is stored alongside the main tree's.
    const show = rearrange && !readonly && selection.size > 0;
    if (!show) { if (bar) bar.remove(); return; }
    if (!bar) { bar = document.createElement("div"); bar.id = "selBar"; document.body.appendChild(bar); }
    bar.textContent = "";
    const txtEl = document.createElement("span"); txtEl.className = "sb-text";
    txtEl.innerHTML = "<b>" + selection.size + "</b> selected"; bar.appendChild(txtEl);
    const btn = (label, fn) => { const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.onclick = fn; bar.appendChild(b); return b; };
    // Context actions: a selected COUPLE gets spacing/centering, 3+ get distribution.
    const ids = [...selection];
    const cu = ids.length === 2 ? unionBetween(pidOf(ids[0]), pidOf(ids[1])) : null;
    if (ids.length >= 2) {
      { const b = btn("⇤ Snap close", () => snapChainSpacing("sibling")); b.title = "Hotkey: C"; }
      { const b = btn("⇔ Snap wide", () => snapChainSpacing("couple")); b.title = "Hotkey: W"; }
    }
    if (cu && childLinksOfUnion(cu.id).length) { const b = btn("⌖ Center on children", () => centerCoupleOnChildren(cu, ids.find((k) => pidOf(k) === cu.a), ids.find((k) => pidOf(k) === cu.b))); b.title = "Hotkey: K"; }
    if (commonParentUnion(ids)) { const b = btn("⌖ Center on parents", centerSelectionOnParents); b.title = "Hotkey: P"; }
    if (ids.length >= 3) btn("↔ Space evenly", distributeSelection);
    if (ids.some((id) => !isLocked(id))) btn("🔒 Lock", () => {
      if (!state.locked) state.locked = {};
      ids.forEach((id) => { state.locked[id] = true; });
      save(); render(); toast("Locked in place — nothing moves them until you unlock");
    });
    if (ids.some((id) => isLocked(id))) btn("🔓 Unlock", () => {
      ids.forEach((id) => { if (state.locked) delete state.locked[id]; });
      save(); render(); toast("Unlocked — they can move again");
    });
    { const b = btn("⤒ Row up", () => nudgeGeneration(-1)); b.title = "Move up one row — hotkey: ["; }
    { const b = btn("⤓ Row down", () => nudgeGeneration(1)); b.title = "Move down one row — hotkey: ]"; }
    if (ids.length >= 2) btn("🔗 Group", () => { makeGroup(ids); render(); toast("Grouped — they now move together (any tool, any drag)"); });
    if (ids.some((id) => groupOf(id))) btn("⛓ Ungroup", () => { ungroup(ids); render(); toast("Ungrouped — they move separately again"); });
    // A repeated person selected here can be taken off the canvas without being
    // taken off the tree — the copy goes, the person stays.
    if (ids.some((nk) => removableCopy(nk))) btn("⧉ Remove copy", () => {
      const n = removeCopies(ids);
      selection = new Set(); render();
      toast(n ? (n === 1 ? "Copy removed — they're drawn in one place now" : n + " copies removed") : "Nothing to remove here");
    }).title = "Stop repeating them here — they stay on the tree, drawn in one place";
    if (viewPreview) btn("🚫 Hide from this view", () => {
      const v = viewPreview.view;
      pushUndo();
      if (!Array.isArray(v.hide)) v.hide = [];
      const pids = [...new Set(ids.map(pidOf))].filter((id) => personById(id));
      pids.forEach((id) => { if (!v.hide.includes(id)) v.hide.push(id); });
      selection = new Set();
      save(); render();
      toast(pids.length + " hidden from this view only — the master tree keeps them");
    });
    // (nothing to hide INSIDE a hidden branch — everyone here is already hidden)
    if (!viewPreview && !hiddenScope) btn("Hide selected", () => {
      pushUndo();
      if (!state.hidden) state.hidden = {};
      const n = selection.size;
      selection.forEach((nk) => { const pid = pidOf(nk); state.hidden[pid] = true; if (pid === selectedId) { selectedId = null; resetPersonForm(); } });
      selection = new Set();
      relayoutAndSave(); fitView();
      toast("Hid " + n + " people — the counter chip at the top brings everyone back");
    });
    const clr = btn("Clear", () => { selection = new Set(); render(); });
    clr.id = "sbClear";
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

  // ---- jumping between a person's appearances ----------------------------
  // Every place a person is drawn is a destination: their main spot plus each
  // copy across a jump. Each one is named by the family whose branch it sits on.
  const surnameOfPerson = (p) => (p && (p.last != null ? p.last : parseName(p.name || "").last)) || "";
  function familyNameOfUnion(uid) {
    const u = unionById(uid); if (!u) return "";
    const s = surnameOfPerson(personById(u.a)) || (u.b != null ? surnameOfPerson(personById(u.b)) : "");
    return s ? s + " family" : "";
  }
  const unionCoupleNames = (uid) => {
    const u = unionById(uid); if (!u) return "";
    const nm = (x) => (x ? (x.first || x.name || "") : "");
    return [nm(personById(u.a)), u.b != null ? nm(personById(u.b)) : ""].filter(Boolean).join(" & ");
  };
  // Everywhere this person can be jumped TO from the appearance they're on now
  // (curUid = null on their main node, else the union of the copy clicked).
  // The main spot is named as such — naming it by family would collide with the
  // copy sitting on that very family's branch.
  function jumpTargets(pid, curUid) {
    const out = [];
    if (curUid) { const q = posOf(pid); out.push({ label: "Their main spot", x: q.x, y: q.y, uid: null }); }
    (copySpots[pid] || []).forEach((s) => {
      if (s.uid === curUid) return;
      out.push({ label: familyNameOfUnion(s.uid) || "another branch", x: s.x, y: s.y, uid: s.uid });
    });
    // two branches of the same surname: tell them apart by the couple's names
    out.forEach((d, i) => {
      if (d.uid && out.some((o, j) => j !== i && o.label === d.label)) {
        const who = unionCoupleNames(d.uid);
        if (who) d.label += " (" + who + ")";
      }
    });
    return out;
  }
  // Switch OFF the copies named by these appearance keys: each one's
  // parent-child link is pinned to "never repeat here", so the person is drawn
  // in one place again. The person, their family and their links are untouched.
  const copyLinkOf = (pid, uid) => ((state.links || []).find((x) => x.child === pid && x.union === uid) || null);
  // Whose jump is responsible for the copy of `pid` sitting on union `uid`.
  const copyAnchorOf = (pid, uid) => (((copySpots[pid] || []).find((c) => c.uid === uid) || {}).anchor) || pid;
  const removableCopy = (nk) => {
    if (!isCopyKey(nk)) return null;
    const uid = nk.slice(0, nk.indexOf(":")), pid = pidOf(nk);
    return copyLinkOf(copyAnchorOf(pid, uid), uid);
  };
  function removeCopies(nks) {
    const lids = [...new Set([...nks].map((nk) => { const l = removableCopy(nk); return l && l.id; }).filter(Boolean))];
    if (!lids.length) return 0;
    pushUndo();
    if (!state.portals) state.portals = {};
    lids.forEach((id) => { state.portals[id] = false; });
    save(); render();
    return lids.length;
  }
  function centerAt(x, y) {
    const r = stage.getBoundingClientRect();
    view.tx = r.width / 2 - x * view.scale;
    view.ty = r.height / 2 - y * view.scale;
    applyView();
  }
  function openJumpPicker(name, dests) {
    const back = document.createElement("div"); back.className = "modal-backdrop";
    const m = document.createElement("div"); m.className = "modal";
    const h = document.createElement("h2"); h.textContent = "Jump to…"; m.appendChild(h);
    const hint = document.createElement("div"); hint.className = "hint";
    hint.textContent = name + " appears in " + (dests.length + 1) + " places. Which one do you want to see?";
    m.appendChild(hint);
    const list = document.createElement("div"); list.className = "jump-list";
    dests.forEach((d) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "btn wide";
      b.textContent = "⤴ " + d.label;
      b.onclick = () => { back.remove(); centerAt(d.x, d.y); };
      list.appendChild(b);
    });
    m.appendChild(list);
    const row = document.createElement("div"); row.className = "btn-row";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn"; cancel.textContent = "Cancel";
    cancel.onclick = () => back.remove();
    row.appendChild(cancel); m.appendChild(row);
    back.appendChild(m); document.body.appendChild(back);
    back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
    return back;
  }

  function renderPerson(p, inst) {
    // `inst` = this node is a COPY of the person placed across a jump: same
    // full profile, its own spot (state.echoPos), tagged so drags know which
    // appearance moved.
    const pos = inst ? inst : posOf(p.id);
    // this appearance's own key — selection/locks highlight per appearance
    const nk = inst ? inst.uid + ":" + p.id : p.id;
    const g = el("g", { class: "person" + (p.id === selectedId ? " selected" : "") + (selection.has(nk) ? " multi" : ""), transform: `translate(${pos.x},${pos.y})`, "data-id": p.id });
    if (inst) g.setAttribute("data-inst", inst.uid);
    // Hover tooltip carries the exact dates when known (the label stays year-only).
    if (p.birthDate || p.deathDate) {
      const tip = [p.name];
      if (p.birthDate) tip.push("Born " + fmtDate(p.birthDate));
      if (p.deathDate) tip.push("Died " + fmtDate(p.deathDate));
      g.appendChild(el("title", null, txt(tip.join("\n"))));
    }

    const clip = { male: "clip-male", female: "clip-female", unknown: "clip-unknown" }[p.sex] || "clip-unknown";
    const decd = isDeceased(p);
    const ph = photoOf(p);                       // cached dataURL (or null while an externalised photo loads)
    const hasPhoto = !!(p.photo || p.photoRef);
    if (ph) {
      // For a photo, the deceased slash goes BEHIND the picture so it never
      // crosses the face — only its tips peek out past the edges.
      if (decd) g.appendChild(el("line", { class: "deceased", x1: -HALF - 9, y1: HALF + 9, x2: HALF + 9, y2: -HALF - 9 }));
      g.appendChild(el("image", { href: ph, x: -HALF, y: -HALF, width: HALF * 2, height: HALF * 2, preserveAspectRatio: "xMidYMid slice", "clip-path": `url(#${clip})` }));
    } else {
      g.appendChild(el("text", { class: "placeholder-emoji", x: 0, y: 2 }, txt("👤")));
    }
    // shape outline on top
    g.appendChild(shapeOutline(p.sex, !!ph, effColor(p.id)));
    // deceased slash — drawn across the empty symbol (the classic mark) only when
    // there's no photo; photo nodes get the behind-the-picture version above.
    if (decd && !ph) g.appendChild(el("line", { class: "deceased", x1: -HALF, y1: HALF, x2: HALF, y2: -HALF }));

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

    // served: a small star, bottom-right of their shape (records sit top-right,
    // the lock top-left, the jump badge bottom-left)
    if (servedInMilitary(p)) {
      const mb = el("g", { class: "mil-badge", transform: `translate(${HALF - 5},${HALF - 5})` });
      mb.appendChild(el("circle", { class: "mil-badge-bg", r: 9, cx: 0, cy: 0 }));
      mb.appendChild(el("path", { class: "mil-badge-mark", d: "M0 -5.6 L1.6 -1.8 L5.6 -1.8 L2.4 0.7 L3.6 4.6 L0 2.2 L-3.6 4.6 L-2.4 0.7 L-5.6 -1.8 L-1.6 -1.8 Z" }));
      const who = militaryLine(p);
      mb.appendChild(el("title", null, txt(who ? "Served — " + who : "Served in the military")));
      g.appendChild(mb);
    }
    if (isLocked(nk)) {
      const lk = el("text", { class: "lock-badge", x: -HALF + 2, y: -HALF + 12 }, txt("🔒"));
      lk.appendChild(el("title", null, txt("Locked in place")));
      g.appendChild(lk);
    }

    // ⤴ hop badge: a person appearing in several places gets one on EACH node.
    // With exactly one other appearance it jumps straight there; when someone
    // sits on three or more branches it asks which family to jump to.
    const spots = copySpots[p.id] || [];
    const dests = jumpTargets(p.id, inst ? inst.uid : null);
    if (inst || spots.length) {
      const jb = el("g", { class: "jump-badge", transform: `translate(${-HALF + 5},${HALF - 5})` });
      jb.appendChild(el("circle", { class: "jump-badge-bg", r: 9, cx: 0, cy: 0 }));
      jb.appendChild(el("text", { class: "jump-badge-mark", x: 0, y: 3.5 }, txt("⤴")));
      jb.appendChild(el("title", null, txt(dests.length > 1
        ? "They appear in " + (dests.length + 1) + " places — click to choose where to jump"
        : "They also appear on another branch — click to jump there")));
      jb.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation(); ev.preventDefault();
        if (!dests.length) return;
        if (dests.length === 1) centerAt(dests[0].x, dests[0].y);
        else openJumpPicker(treeDisplayName(p), dests);
      });
      // right-click the badge removes a hand-made jump (automatic ones explain themselves)
      jb.addEventListener("contextmenu", (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        if (readonly) return;
        const lid = (state.links.find((l) => l.child === p.id && (!inst || l.union === inst.uid)) || {}).id;
        if (!lid) return;
        pushUndo();
        (state.portals || (state.portals = {}))[lid] = false;   // never repeat them here
        save(); render();
        toast("Copy removed — they're drawn in one place now");
      });
      g.appendChild(jb);
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
  // How old they are — at death for someone who has passed, today for everyone
  // else. Null when it can't be known (no birth, or gone with no date to stop
  // the clock at). Months come back too when both ends are dated precisely
  // enough to count them, and null when all we have is years — which can't tell
  // a newborn from an eleven-month-old.
  function ageInfo(p) {
    if (!p) return null;
    const at = (exact, year) => {
      if (exact && /^\d{4}-\d{2}-\d{2}$/.test(exact)) return { y: +exact.slice(0, 4), m: +exact.slice(5, 7), d: +exact.slice(8, 10) };
      if (year != null && Number.isFinite(+year)) return { y: +year, m: null, d: null };
      return null;
    };
    const b = at(p.birthDate, p.birth); if (!b) return null;
    let e;
    if (isDeceased(p)) { e = at(p.deathDate, p.death); if (!e) return null; }
    else { const n = new Date(); e = { y: n.getFullYear(), m: n.getMonth() + 1, d: n.getDate() }; }
    if (b.m != null && e.m != null) {
      let mo = (e.y - b.y) * 12 + (e.m - b.m);
      if (e.d < b.d) mo--;                                   // the day of the month hasn't come round yet
      if (mo < 0 || mo > 130 * 12) return null;
      return { years: Math.floor(mo / 12), months: mo };
    }
    const a = e.y - b.y;
    return a < 0 || a > 130 ? null : { years: a, months: null };
  }
  // How old they are, in words: years once they've had a first birthday, months
  // before that — and an honest "<1 yr" when only the years are on record, which
  // can't say how many months.
  function ageLabel(p) {
    const a = ageInfo(p); if (!a) return "";
    if (a.years >= 1) return String(a.years);
    if (a.months == null) return "<1 yr";
    return a.months >= 1 ? a.months + " mo" : "<1 mo";
  }
  // Military service lives in p.military: its presence IS the "they served" flag,
  // and it carries the branch, rank and notes.
  const servedInMilitary = (p) => !!(p && p.military);
  const militaryLine = (p) => {
    const m = (p && p.military) || null; if (!m) return "";
    return [m.branch, m.rank].filter(Boolean).join(" · ");
  };
  function dateStr(p) {
    // Both ends known: the tree carries how old they were when they died.
    const age = ageLabel(p), tag = age ? " (" + age + ")" : "";
    if (p.birth != null && p.death != null) return p.birth + "–" + p.death + tag;
    if (p.birth != null) return "b. " + p.birth + (isDeceased(p) ? " · d." : "") + tag;
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
  // 🔒 Locked people shift too: a lock protects someone's PLACE IN THE LAYOUT
  // from arranging tools — when the whole tree slides over to make room for a
  // new person, locked people must ride along or the layout tears around them.
  function makeRoomAt(x, width, exceptIds) {
    visiblePersons().forEach((p) => {
      if (exceptIds && exceptIds.has(p.id)) return;
      const q = posOf(p.id);
      if (q.x >= x) posMap()[p.id] = { x: q.x + width, y: q.y };
    });
  }
  const spotOccupied = (x, y, exceptId) => visiblePersons().some((p) => p.id !== exceptId && Math.abs(posOf(p.id).x - x) < COLW * 0.85 && Math.abs(posOf(p.id).y - y) < ROWH * 0.55);
  // Pin `id` at (x,y); if that spot is taken, open room by shifting the right side over.
  // Linking someone who is already on the canvas must never teleport them: pin
  // the spot they are standing on before the structure changes underneath.
  function pinInPlace(id) { if (id && !isManual(id) && personById(id)) { const q = posOf(id); posMap()[id] = { x: q.x, y: q.y }; } }
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
      if (u.a == null) return;   // a sibling group has nobody to sit under
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
    g.appendChild(el("circle", { class: "add-plus-hit", r: 26, cx: 0, cy: 0 }));   // as generous a target as the + handles
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

  // People repeated across a jump this render: registered while the unions
  // draw, then drawn as ORDINARY person nodes after them — a copy is the same
  // full profile, dragging/selecting/editing exactly like anyone else. The
  // only extra is a ⤴ badge for hopping between a person's appearances.
  let copyPlacements = [], copySpots = {};
  // The far-away child REPEATED on their parents' side — them, their spouse(s),
  // and their WHOLE descendant branch (children, children's spouses,
  // grandchildren, …) so each side reads complete on its own. Each copy
  // starts at a tidy default spot but can be dragged anywhere (stored per
  // jump+person in state.echoPos); the connecting lines follow the shapes.
  function renderEchoCluster(gu, uid, childId, cx, rowY) {
    // Where this copy was last dragged to — kept as-is, however the family has
    // been rearranged around it, EXCEPT when the spot isn't within reach of
    // this branch at all. That means it was saved against a different
    // arrangement (a View puts the same family somewhere else entirely), and
    // honouring it would fling them across the board; they go back to their
    // automatic place beside the family instead.
    const ECHO_FAR = 8000;   // far wider than any cluster — only nonsense trips it
    const spot = (id, dx, dy) => {
      const q = echoMap()[uid + ":" + id];
      if (q && Math.abs(q.x - cx) < ECHO_FAR && Math.abs(q.y - rowY) < ECHO_FAR) return q;
      return { x: dx, y: dy };
    };
    const SLOT = COLW + 22, GAPC = 40;
    const seen = new Set();
    // measure the branch: a unit = person + their spouse(s) + kid units below
    const unitOf = (pid) => {
      if (seen.has(pid)) return null;
      seen.add(pid);
      const p = personById(pid); if (!p) return null;
      const spouses = spouseIdsOf(pid).map(personById).filter((sp) => sp && inView(sp.id) && !seen.has(sp.id)).slice(0, 2);
      spouses.forEach((sp) => seen.add(sp.id));
      const kids = [...new Set(unionsOfPerson(pid).flatMap((u2) => childLinksOfUnion(u2.id).map((l) => l.child)))]
        .filter((k) => personById(k) && inView(k)).map(unitOf).filter(Boolean);
      const rowW = (1 + spouses.length) * SLOT;
      const kidsW = kids.reduce((s, k) => s + k.w, 0) + GAPC * Math.max(0, kids.length - 1);
      return { p, spouses, kids, w: Math.max(rowW, kidsW) };
    };
    const root = unitOf(childId); if (!root) return { anchorX: cx, anchorTop: rowY - HALF - 8, width: COLW };
    // `anchor` is the child whose jump created this cluster: a spouse or
    // grandchild repeated inside it belongs to that one copy, so removing any
    // of them means removing the cluster the anchor brought.
    const reg = (pp, v) => { copyPlacements.push({ p: pp, uid, x: v.x, y: v.y }); (copySpots[pp.id] = copySpots[pp.id] || []).push({ uid, x: v.x, y: v.y, anchor: childId }); copyPos[uid + ":" + pp.id] = { x: v.x, y: v.y }; };
    // place a unit centred on centerX: first spouse to the right, a second to
    // the left; each spouse ties to THIS person (never spouse-to-spouse); kids
    // hang from a mini bus below the couple, each centred over their own branch
    const place = (unit, centerX, y) => {
      const q = spot(unit.p.id, centerX, y);
      const sq = unit.spouses.map((sp, i) => spot(sp.id, centerX + (i === 0 ? SLOT : -SLOT), y));
      sq.forEach((s, i) => {
        const a = s.x <= q.x ? s : q, b = s.x <= q.x ? q : s;
        const u2 = unionBetween(unit.p.id, unit.spouses[i].id);
        gu.appendChild(el("line", { class: "link echo-link", x1: a.x + HALF - 6, y1: a.y, x2: b.x - HALF + 6, y2: b.y, "stroke-dasharray": u2 && u2.status === "partners" ? "6 5" : null }));
        if (u2) {
          // same dressing as the main marriage line: date label + divorce ticks
          const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
          if (u2.status === "divorced") [-7, 5].forEach((dx) => gu.appendChild(el("line", { class: "divorce-tick", x1: midX + dx + 5, y1: midY - 11, x2: midX + dx - 5, y2: midY + 11 })));
          const dlabel = unionDateLabel(u2);
          if (dlabel) {
            gu.appendChild(el("rect", { class: "union-date-bg", x: midX - dlabel.length * 3.3 - 4, y: midY - 21, width: dlabel.length * 6.6 + 8, height: 15, rx: 4 }));
            gu.appendChild(el("text", { class: "union-date", x: midX, y: midY - 10 }, txt(dlabel)));
          }
        }
      });
      if (unit.kids.length) {
        const pmx = sq.length ? (q.x + sq[0].x) / 2 : q.x;   // bus hangs between the couple
        const pby = Math.max(q.y, ...sq.map((v) => v.y));
        const kb = pby + 120, kidY = y + ROWH;
        let kx = centerX - (unit.kids.reduce((s, k) => s + k.w, 0) + GAPC * (unit.kids.length - 1)) / 2;
        const kqs = unit.kids.map((k) => { const c = kx + k.w / 2; kx += k.w + GAPC; return place(k, c, kidY); });
        gu.appendChild(el("line", { class: "link echo-link", x1: pmx, y1: pby, x2: pmx, y2: kb }));
        const bxs = [pmx, ...kqs.map((v) => v.x)];
        if (Math.min(...bxs) !== Math.max(...bxs))
          gu.appendChild(el("line", { class: "link echo-link", x1: Math.min(...bxs), y1: kb, x2: Math.max(...bxs), y2: kb }));
        kqs.forEach((v) => gu.appendChild(el("line", { class: "link echo-link", x1: v.x, y1: kb, x2: v.x, y2: v.y - HALF - 8 })));
      }
      reg(unit.p, q); unit.spouses.forEach((sp, i) => reg(sp, sq[i]));
      return q;
    };
    const rootQ = place(root, cx + root.w / 2, rowY);   // cx is the branch's left edge
    return { anchorX: rootQ.x, anchorTop: rootQ.y - HALF - 8, width: root.w };
  }

  // Drag a family's child connector up or down. It stays clear of the couple
  // above and the children below, so the drop lines can never invert.
  function startBusDrag(ev, u, busBase, busY, nearTops) {
    ev.stopPropagation(); ev.preventDefault();
    const sy = ev.clientY, pre = snapshot();
    const start = busY - busBase;
    const lo = HALF + 24;
    const hi = Math.max(lo, Math.min(...nearTops.map((c) => c.top)) - busBase - 8);
    let moved = false;
    const mv = (e2) => {
      if (!moved && Math.abs(e2.clientY - sy) > 3) moved = true;
      if (!moved) return;
      const dy = (e2.clientY - sy) / view.scale;
      busMap()[u.id] = Math.max(lo, Math.min(hi, start + dy));
      render();
    };
    const up = () => {
      window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
      if (moved) { pushUndo(pre); save(); render(); toast("Connector moved — right-click it to go back to automatic"); }
    };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  }

  function renderUnion(u) {
    const sibGroup = isSibGroup(u);
    const pa = personById(u.a); if (!pa && !sibGroup) return;
    const pb = u.b != null ? personById(u.b) : null;
    const A = sibGroup ? null : posOf(u.a), B = pb ? posOf(u.b) : null;
    const kids = childLinksOfUnion(u.id).map((l) => ({ l, p: personById(l.child) })).filter((k) => k.p && inView(k.p.id));
    const gu = el("g", { class: "union", "data-union": u.id });   // group so hover reveals the +

    let midX, midY, dropTop, dropXO = null;
    if (pb) {
      const left = A.x < B.x ? A : B, right = A.x < B.x ? B : A;
      const leftId = A.x < B.x ? u.a : u.b, rightId = A.x < B.x ? u.b : u.a;
      // Multi-spouse fan: when someone has several spouses on the same side,
      // several lines leave that side of their shape — evenly spaced within its
      // height, the LOWEST line to the nearest spouse, higher lines to spouses
      // further away (mirroring how multiple parent lines fan on a child).
      const sideFan = (pid, dir) => {
        const me = posOf(pid);
        const list = unionsOfPerson(pid).filter((uu) => {
          const oid = uu.a === pid ? uu.b : uu.a;
          if (oid == null || !inView(oid) || !personById(oid)) return false;
          const q = posOf(oid);
          return (q.x - me.x) * dir > 0 && Math.abs(q.y - me.y) < HALF * 1.5;   // that side, same generation row
        }).sort((ua, ub) =>
          Math.abs(posOf(ua.a === pid ? ua.b : ua.a).x - me.x) -
          Math.abs(posOf(ub.a === pid ? ub.b : ub.a).x - me.x));
        return { k: list.length, r: Math.max(0, list.findIndex((x) => x.id === u.id)) };
      };
      const fL = sideFan(leftId, +1), fR = sideFan(rightId, -1);
      const yOff = (f) => (f.k <= 1 ? 0 : HALF - (2 * HALF * (f.r + 1)) / (f.k + 1));
      const yL = left.y + yOff(fL), yR = right.y + yOff(fR);
      const x1 = left.x + HALF - 6, x2 = right.x - HALF + 6;
      const dash = u.status === "partners" ? "6 5" : null;
      // Anyone standing between the couple on this row means the line must hop
      // over them instead of cutting through their shape.
      const blockers = state.persons
        .filter((pp) => pp.id !== u.a && pp.id !== u.b && inView(pp.id))
        .map((pp) => posOf(pp.id))
        .filter((q) => q.x > left.x && q.x < right.x && Math.abs(q.y - (left.y + right.y) / 2) < HALF * 1.5);
      let segX1, segX2, segY;   // the long horizontal stretch (labels, ticks, + live here)
      if (!blockers.length) {
        // A clear run stays ONE straight line: at the couple's average height
        // when neither side needs a fan (shapes dragged slightly off-level must
        // not create a jog), or at the fanned side's height when one side has
        // several spouses. Only two fanned sides ever need a mid-line step.
        let yA = yL, yB = yR;
        if (fL.k <= 1 && fR.k <= 1) yA = yB = (left.y + right.y) / 2;
        else if (fL.k > 1 && fR.k <= 1) yB = yA;
        else if (fR.k > 1 && fL.k <= 1) yA = yB;
        segX1 = x1; segX2 = x2; segY = Math.min(yA, yB);
        const d = yA === yB
          ? `M ${x1} ${yA} L ${x2} ${yB}`
          : `M ${x1} ${yA} L ${(x1 + x2) / 2} ${yA} L ${(x1 + x2) / 2} ${yB} L ${x2} ${yB}`;
        gu.appendChild(el("path", { class: "link", d, fill: "none", "stroke-dasharray": dash }));
        midX = (x1 + x2) / 2; midY = segY; dropTop = segY;
      } else {
        // Hop: out of the shape at this union's fan height, up over everyone in
        // between, down into the far spouse at their fan height.
        const rank = Math.max(fL.r, fR.r);
        const stub = 12 + 6 * rank;
        const top = Math.min(left.y, right.y, ...blockers.map((q) => q.y)) - HALF - 18 - 14 * Math.max(0, rank - 1);
        // The descending leg normally lands INSIDE the couple, beside the far
        // spouse. When their children sit BEYOND that spouse, it comes down on
        // the far spouse's outer side instead and enters from that edge — so a
        // child just past a parent connects straight up, never doubling back
        // underneath them. Only when that outer lane is clear air.
        const kidXs = kids.map((k) => posOf(k.p.id).x);
        const outward = kidXs.length && Math.min(...kidXs) > right.x + HALF;
        const outLane = right.x + HALF - 6 + stub;
        const laneClear = outward && !state.persons.some((pp) => {
          if (pp.id === u.a || pp.id === u.b || !inView(pp.id)) return false;
          const q = posOf(pp.id);
          return Math.abs(q.y - right.y) < HALF * 1.5 && Math.abs(q.x - outLane) < HALF + 8;
        }) && !unionsOfPerson(rightId).some((uu) => {
          if (uu.id === u.id) return false;
          const oid = uu.a === rightId ? uu.b : uu.a;
          if (oid == null || !inView(oid) || !personById(oid)) return false;
          const q = posOf(oid);
          return q.x > right.x && Math.abs(q.y - right.y) < HALF * 1.5;   // a spouse already uses that side
        });
        const xEnd = laneClear ? right.x + HALF - 6 : x2;      // which edge the line enters
        const xLeg = laneClear ? outLane : x2 - stub;          // where it comes down
        const d = `M ${x1} ${yL} L ${x1 + stub} ${yL} L ${x1 + stub} ${top} L ${xLeg} ${top} L ${xLeg} ${yR} L ${xEnd} ${yR}`;
        gu.appendChild(el("path", { class: "link", d, fill: "none", "stroke-dasharray": dash }));
        segX1 = x1 + stub; segX2 = xLeg; segY = top;
        midX = (x1 + x2) / 2; midY = top;
        // Children of a hopped marriage drop from that descending leg — through
        // clear air, never through anyone's shape.
        dropXO = xLeg; dropTop = yR;
      }
      if (u.status === "divorced") {
        [-7, 5].forEach((dx) => gu.appendChild(el("line", { class: "divorce-tick", x1: midX + dx + 5, y1: segY - 11, x2: midX + dx - 5, y2: segY + 11 })));
      }
      // Marriage (and divorce) date, sitting just above the line.
      {
        const dlabel = unionDateLabel(u);
        if (dlabel) {
        gu.appendChild(el("rect", { class: "union-date-bg", x: midX - (dlabel.length * 3.3) - 4, y: segY - 21, width: dlabel.length * 6.6 + 8, height: 15, rx: 4 }));
        gu.appendChild(el("text", { class: "union-date", x: midX, y: segY - 10 }, txt(dlabel)));
        }
      }
      if (!readonly) {
        // Hovering the marriage line reveals a + (add a child of this couple) and
        // a +hidden (start a private sub-tree from this couple). A wide invisible
        // hit-line keeps them reachable across the whole line.
        gu.appendChild(el("line", { class: "couple-hit", x1: segX1, y1: segY, x2: segX2, y2: segY }));
        gu.appendChild(couplePlus(u.id, midX, segY));
        if (!hiddenScope) gu.appendChild(hiddenPlus({ union: u.id }, midX, segY - 30));
      }
    } else if (sibGroup) {
      midX = midY = dropTop = null;   // no parents: filled in from the siblings themselves
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
    const famColor = kids.map((k) => effColor(k.p.id)).find(Boolean) || (pa && effColor(pa.id)) || (pb && effColor(pb.id)) || null;
    const cstyle = famColor ? "stroke:" + famColor + ";stroke-width:2.8" : null;

    const childTops = kids.map((k) => ({ id: k.p.id, lid: k.l.id, first: k.p.first || k.p.name || "?", x: childAttachX(k.p.id, u.id, posOf(k.p.id).x), top: posOf(k.p.id).y - HALF - 8, type: k.l.type }));
    // Siblings with no parents centre their own bar over themselves.
    if (sibGroup) { const xs = childTops.map((c) => c.x); midX = (Math.min(...xs) + Math.max(...xs)) / 2; }
    const dropX = dropXO != null ? dropXO : midX;
    // The connector's depth hangs from the couple's ROW (not a hopped line's
    // top) — or wherever you dragged this family's line to.
    const busAuto = 120 + (busLevels[u.id] || 0) * 15;
    // A sibling group has no couple to hang from, so its bar sits the same
    // distance above the siblings that a family bar sits above its children.
    const busBase = sibGroup ? Math.min(...childTops.map((c) => c.top)) - 76 - busAuto
      : (pb ? (A.y + B.y) / 2 : midY);
    const busOv = busMap()[u.id];
    let busY = busBase + (busOv != null ? busOv : busAuto);
    // PORTALS: a child drawn far off with their own marital family (a
    // married-in spouse) gets NO cross-canvas line — a stub + echo instead.
    // "Far" means separated from the family cluster by a big EMPTY gap, not
    // merely distant from the drop point: siblings chain together, so a wide
    // row where each sibling sits near the next all stays wired to the bus.
    // Copies are three-way per parent-child link: true = always show a copy
    // here, false = never (draw the line however long), unset = automatic.
    const pFlag = (c) => (state.portals || {})[c.lid];
    // A View is redrawn from scratch as one clean tree, so a jump forced by
    // hand on the master tree would only repeat someone who is already standing
    // right there. Views let the empty-gap rule decide for itself; "never
    // repeat here" still counts, because that is a request for one copy only.
    const forcedJump = (c) => pFlag(c) === true && !viewPreview;
    const PORTAL_GAP = 2200;
    const nearSet = new Set();
    let nLo = dropX, nHi = dropX, grew = true;
    while (grew) {
      grew = false;
      childTops.forEach((c) => {
        if (nearSet.has(c.id) || forcedJump(c)) return;
        if (c.x >= nLo - PORTAL_GAP && c.x <= nHi + PORTAL_GAP) { nearSet.add(c.id); nLo = Math.min(nLo, c.x); nHi = Math.max(nHi, c.x); grew = true; }
      });
    }
    const nearTops = childTops.filter((c) => !forcedJump(c) && (nearSet.has(c.id) || pFlag(c) === false));
    const nearIds = new Set(nearTops.map((c) => c.id));
    const farTops = childTops.filter((c) => !nearIds.has(c.id));
    // Keep the connector in the corridor between the couple and the highest
    // child it feeds. Without this, a height carried over from a layout with
    // taller rows lands below the children and every drop line runs down past
    // them and back up.
    if (nearTops.length) {
      const loY = busBase + HALF + 24, hiY = Math.min(...nearTops.map((c) => c.top)) - 8;
      if (hiY > loY) busY = Math.min(Math.max(busY, loY), hiY);
    }
    if (nearTops.length) {
      if (!sibGroup) gu.appendChild(el("line", { class: "link", x1: dropX, y1: dropTop, x2: dropX, y2: busY, style: cstyle }));
      const minX = Math.min(dropX, ...nearTops.map((c) => c.x));
      const maxX = Math.max(dropX, ...nearTops.map((c) => c.x));
      if (nearTops.length > 1 || minX !== maxX)
        gu.appendChild(el("line", { class: "link", x1: minX, y1: busY, x2: maxX, y2: busY, style: cstyle }));
      if (!readonly) {
        const h1 = Math.min(dropX, minX) - 30, h2 = Math.max(dropX, maxX) + 30;
        const bh = el("line", { class: "bus-hit", x1: h1, y1: busY, x2: h2, y2: busY });
        bh.appendChild(el("title", null, txt("Drag to move this family's connector up or down · right-click to reset")));
        bh.addEventListener("pointerdown", (ev) => startBusDrag(ev, u, busBase, busY, nearTops));
        bh.addEventListener("contextmenu", (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          if (busMap()[u.id] != null) { pushUndo(); delete busMap()[u.id]; save(); render(); toast("Connector back to its automatic height"); }
          else toast("This connector is already at its automatic height");
        });
        gu.appendChild(bh);
      }
      nearTops.forEach((c) => {
        gu.appendChild(el("line", { class: "link" + (c.type === "adopted" ? " adopt" : ""), x1: c.x, y1: busY, x2: c.x, y2: c.top, style: c.type === "adopted" ? null : cstyle }));
        if (!readonly) {
          // Wide invisible strip over the child's drop line: right-click turns
          // this connection into a jump (stub + echo) by hand.
          const hit = el("line", { class: "drop-hit", x1: c.x, y1: busY, x2: c.x, y2: c.top });
          hit.appendChild(el("title", null, txt("Right-click to turn " + c.first + "'s connection into a jump")));
          hit.addEventListener("contextmenu", (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            pushUndo();
            (state.portals || (state.portals = {}))[c.lid] = true;
            save(); render();
            toast("↷ Jump created for " + c.first + " — right-click their ⤴ badge to undo");
          });
          gu.appendChild(hit);
        }
      });
    }
    if (farTops.length) {
      // the far child gets no line at their own end — the ⤴ badge on each of
      // their appearances is the way across. The parents' end gets the child
      // REPEATED here with spouse & children, hooked to the family bus.
      const rowY2 = (pb ? (A.y + B.y) / 2 : A.y) + ROWH;
      let ex = nearTops.length ? Math.max(dropX, ...nearTops.map((c) => c.x)) + 300 : dropX;
      const echoAnchors = [];
      farTops.forEach((c) => {
        const r = renderEchoCluster(gu, u.id, c.id, ex, rowY2);
        echoAnchors.push(r);
        ex += r.width + 160;
      });
      if (!nearTops.length && !sibGroup) gu.appendChild(el("line", { class: "link", x1: dropX, y1: dropTop, x2: dropX, y2: busY, style: cstyle }));
      const bmin = Math.min(dropX, ...echoAnchors.map((r) => r.anchorX)), bmax = Math.max(dropX, ...echoAnchors.map((r) => r.anchorX));
      if (bmin !== bmax) gu.appendChild(el("line", { class: "link", x1: bmin, y1: busY, x2: bmax, y2: busY, style: cstyle }));
      echoAnchors.forEach((r) => gu.appendChild(el("line", { class: "link", x1: r.anchorX, y1: busY, x2: r.anchorX, y2: r.anchorTop, style: cstyle })));
    }
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
        // Every appearance — original or copy — goes through the SAME path,
        // addressed by its node key. Copies mix freely into any selection.
        const id = personEl.getAttribute("data-id");
        const instU = personEl.getAttribute("data-inst");
        const nk = instU ? instU + ":" + id : id;
        // Shift-click toggles an appearance in/out of the group selection without
        // moving anything — build up a set, then drag any of them to move all.
        if (e.shiftKey) {
          if (selection.has(nk)) selection.delete(nk); else selection.add(nk);
          render();
          if (selection.size) toast(selection.size + " selected — drag any of them to move the group");
          return;
        }
        if (isLocked(nk)) toast("🔒 Locked in place — unlock them to move them");
        if (!selection.has(nk)) { selection = new Set([nk, ...groupMatesOf(nk)]); render(); }
        const starts = {};
        selection.forEach((k) => { const p = nkPos(k); starts[k] = { x: p.x, y: p.y }; });
        drag = { mode: "group", id: nk, startX: e.clientX, startY: e.clientY, starts, moved: false, pre: snapshot() };
      } else {
        const w = toWorld(e.clientX, e.clientY);
        drag = { mode: "marquee", startX: e.clientX, startY: e.clientY, moved: false, baseSel: e.shiftKey ? [...selection] : null };
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
      let wdx = dx / view.scale;
      const wdy = e.shiftKey ? 0 : dy / view.scale;   // Shift = hold the row (horizontal-only move)
      if (!e.altKey && drag.id && drag.starts[drag.id]) {
        const s0 = drag.starts[drag.id];
        wdx += gravityDX(drag.id, s0.x + wdx, s0.y + wdy, drag.starts);
      }
      for (const nk in drag.starts) { if (isLocked(nk)) continue; nkSetPos(nk, { x: drag.starts[nk].x + wdx, y: drag.starts[nk].y + wdy }); }
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
      if (drag && drag.mode === "group") { if (drag.moved) { pushUndo(drag.pre); save(); } else if (drag.id) selectPerson(pidOf(drag.id)); }
      else if (drag && drag.mode === "marquee") {
        if (drag.moved && marquee) {
          const x0 = Math.min(marquee.x0, marquee.x1), x1 = Math.max(marquee.x0, marquee.x1);
          const y0 = Math.min(marquee.y0, marquee.y1), y1 = Math.max(marquee.y0, marquee.y1);
          selection = new Set(drag.baseSel || []);   // shift+box = ADD to the selection
          visiblePersons().forEach((p) => { const q = posOf(p.id); if (q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1) selection.add(p.id); });
          // copies are appearances like any other — the box picks them up too
          Object.keys(copyPos).forEach((nk) => { const q = nkPos(nk); if (q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1) selection.add(nk); });
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
    if (!rearrange) { selection = new Set(); marquee = null; updateMarquee(); }
    render();   // the generation row lines appear/disappear with the mode
    toast(rearrange ? "Rearrange mode ON — drag a person, or drag a box to select several. Dragging eases onto the snap spacings; hold Alt to place freely." : "Rearrange mode off");
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
    a.forEach(({ pid, p }) => { if (!isLocked(pid)) posMap()[pid] = { x: p.x + delta, y: p.y }; });
    b.forEach(({ pid, p }) => { if (!isLocked(pid)) posMap()[pid] = { x: p.x - delta, y: p.y }; });
    save(); render();
  }

  // "Tidy up": line up people who already sit at roughly the same height so
  // they share one clean horizontal line — WITHOUT disturbing anyone the user
  // deliberately placed on a very different level. People are grouped into
  // horizontal bands (each within BAND_T px of the band's running centre); any
  // band with two or more people is snapped to that band's median height.
  // Someone sitting far from everyone else forms a band of one and never moves.
  // ------------------------------------------------------------- generations
  // The grid every row sits on. Its spacing is one row (ROWH); its height is
  // chosen to match where people ALREADY are, so tidying keeps the arrangement
  // you built and only closes the small gaps.
  function rowGrid() {
    const ys = visiblePersons().map((p) => posOf(p.id).y)
      .concat(Object.keys(copyPos).map((k) => copyPos[k].y));
    if (!ys.length) return { phase: 0, lineFor: (y) => y };
    const wrap = (v) => ((v % ROWH) + ROWH) % ROWH;
    let best = 0, bestCost = Infinity;
    for (let p0 = 0; p0 < ROWH; p0 += 5) {   // the height that moves the fewest people
      let c = 0;
      ys.forEach((y) => { const d = wrap(y - p0); c += Math.min(d, ROWH - d); });
      if (c < bestCost) { bestCost = c; best = p0; }
    }
    const offs = ys.map((y) => { const d = wrap(y - best); return d > ROWH / 2 ? d - ROWH : d; }).sort((x, y) => x - y);
    const phase = best + offs[Math.floor(offs.length / 2)];
    return { phase, lineFor: (y) => phase + Math.round((y - phase) / ROWH) * ROWH };
  }
  // A connector you dragged snaps onto the family line beside it, so two
  // hand-placed connectors end up sharing one height instead of nearly.
  function alignBusLines() {
    const lv = computeBusLevels();
    const buses = [];
    state.unions.forEach((u) => {
      if (!personById(u.a) || !inView(u.a)) return;
      if (!childLinksOfUnion(u.id).some((l) => personById(l.child) && inView(l.child))) return;
      const A = posOf(u.a), B = u.b != null && personById(u.b) && inView(u.b) ? posOf(u.b) : null;
      const base = B ? (A.y + B.y) / 2 : A.y;
      const ov = busMap()[u.id];
      buses.push({ id: u.id, base, ov: ov != null, y: base + (ov != null ? ov : 120 + (lv[u.id] || 0) * 15) });
    });
    const TOL = 100;   // "the one next to it" — never a different generation's
    let n = 0;
    buses.filter((b) => b.ov).forEach((b) => {
      const near = buses.filter((o) => o !== b && Math.abs(o.y - b.y) <= TOL);
      if (!near.length) return;
      // an untouched family line is the one to line up WITH; else meet in the middle
      const autos = near.filter((o) => !o.ov);
      const ys = (autos.length ? autos : near).map((o) => o.y).sort((x, y) => x - y);
      const target = ys[Math.floor(ys.length / 2)];
      if (Math.abs(target - b.y) > 0.5) { busMap()[b.id] = target - b.base; b.y = target; n++; }
    });
    return n;
  }
  function tidyUp() {
    // Snap everyone onto the nearest line of the family grid — the rows you
    // arranged stay yours, the near-misses close up, and nobody is relocated to
    // a different part of the tree. Left–right positions are never touched.
    // Uniform spacing matters more than pinning here, so even 🔒 locked people
    // get their HEIGHT aligned (every other tool still refuses to move them).
    const people = visiblePersons();
    if (people.length < 2) { toast("Nothing to tidy yet"); return; }
    const grid = rowGrid();
    let moved = 0, movedLocked = 0, worst = 0;
    const pre = snapshot();
    people.forEach((p) => {
      const q = posOf(p.id), ty = grid.lineFor(q.y);
      if (Math.abs(q.y - ty) > 0.5) { posMap()[p.id] = { x: q.x, y: ty }; moved++; worst = Math.max(worst, Math.abs(q.y - ty)); if (isLocked(p.id)) movedLocked++; }
    });
    Object.keys(copyPos).forEach((nk) => {
      const q = nkPos(nk), ty = grid.lineFor(q.y);
      if (Math.abs(q.y - ty) > 0.5) { echoMap()[nk] = { x: q.x, y: ty }; moved++; worst = Math.max(worst, Math.abs(q.y - ty)); if (isLocked(nk)) movedLocked++; }
    });
    const busFixed = alignBusLines();   // dragged connectors line up with their neighbours
    const busNote = busFixed ? " · " + busFixed + " connector" + (busFixed > 1 ? "s" : "") + " aligned" : "";
    if (!moved && !busFixed) { save(); render(); toast("Everything's already lined up — every row is level"); return; }
    if (!moved) { pushUndo(pre); save(); render(); toast("Connectors aligned" + busNote.replace(/^ · /, " — ")); return; }
    pushUndo(pre);
    save(); render();
    toast("Tidied up " + moved + " " + (moved === 1 ? "person" : "people") + " onto level rows (nudged " + Math.round(worst) + "px at most)" + (movedLocked ? " · " + movedLocked + " locked, heights only" : "") + busNote + " (Cmd+Z to undo)");
  }
  // Move the selected people one row up or down. Tidy Up keeps them there,
  // because it works from where people are rather than re-deriving the tree.
  function nudgeGeneration(dir) {
    const ids = [...selection];
    if (!ids.length) return;
    pushUndo();
    ids.forEach((nk) => { const q = nkPos(nk); nkSetPos(nk, { x: q.x, y: q.y + dir * ROWH }); });
    save(); render();
    const one = ids.length === 1 ? ((personById(pidOf(ids[0])) || {}).first || "They") : ids.length + " people";
    toast(one + " moved a row " + (dir < 0 ? "up" : "down"));
  }
  stage.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY); }, { passive: false });

  /* ============================================================ FORMS */
  function selectPerson(id) {
    selectedId = id;
    const p = personById(id);
    if (p && !readonly) { fillPersonForm(p); showPersonView(p); }
    render();
  }
  // The panel has two faces for the same person: their profile, and the form
  // that edits it. Everything that isn't a form field — their notes, photos,
  // relationships and records — sits below both, so it's there either way.
  let panelEditing = false;
  function showPersonView(p) {
    panelEditing = false;
    const view = $("#personView"), form = $("#personForm"), pencil = $("#personEditBtn");
    if (!view || !form) return;
    renderPersonHead(p);
    view.hidden = false; form.hidden = true;
    if (pencil) pencil.hidden = false;
    const t = $("#personTitle"); if (t) t.textContent = p.name || "Unnamed";
  }
  function showPersonForm(p) {
    panelEditing = true;
    const view = $("#personView"), form = $("#personForm"), pencil = $("#personEditBtn");
    if (!view || !form) return;
    const head = $("#pvHead"); if (head) head.hidden = true;   // the form has these fields itself
    view.hidden = !p;            // with nobody selected there's nothing to show below
    form.hidden = false;
    if (pencil) pencil.hidden = true;
    const t = $("#personTitle"); if (t) t.textContent = p ? ("Editing " + (p.first || p.name || "them")) : "Add a person";
  }
  // Their picture, name, dates and age — the things worth seeing first.
  function renderPersonHead(p) {
    const host = $("#pvHead"); if (!host) return;
    host.hidden = false;
    host.textContent = "";
    const row = document.createElement("div"); row.className = "pv-row";
    const av = document.createElement("div"); av.className = "pv-photo " + (p.sex === "female" ? "f" : p.sex === "male" ? "m" : "u");
    const ph = photoOf(p);
    const placeholder = () => { const q = document.createElement("span"); q.textContent = "👤"; av.appendChild(q); return q; };
    if (ph) { const im = document.createElement("img"); im.src = ph; av.appendChild(im); }
    else if (p.photoRef) { const q = placeholder(); mediaGet(p.photoRef).then((u) => { if (u && av.isConnected) { q.remove(); const im = document.createElement("img"); im.src = u; av.insertBefore(im, av.firstChild); } }).catch(() => {}); }
    else placeholder();
    if (isDeceased(p)) av.classList.add("deceased");
    if (!readonly && isOwner()) {
      av.classList.add("tappable"); av.title = "Change their picture";
      const cam = document.createElement("span"); cam.className = "pcard-photo-cam"; cam.textContent = "📷"; av.appendChild(cam);
      av.onclick = () => openPhotoMenu(p, () => { const cur = personById(p.id); if (cur) { renderPersonHead(cur); renderGalleryPanel(cur); } });
    }
    row.appendChild(av);
    const txt2 = document.createElement("div"); txt2.className = "pv-text";
    const nm = document.createElement("div"); nm.className = "pv-name"; nm.textContent = p.name || "Unnamed"; txt2.appendChild(nm);
    const dl = personDatesLine(p);
    if (dl) { const d = document.createElement("div"); d.className = "pv-dates"; d.textContent = dl; txt2.appendChild(d); }
    { const a = ageLabel(p); if (a) { const d = document.createElement("div"); d.className = "pv-age"; d.textContent = (isDeceased(p) ? "Age at death " : "Age ") + a; txt2.appendChild(d); } }
    if (isDeceased(p) && p.causeOfDeath) { const d = document.createElement("div"); d.className = "pv-sub"; d.textContent = p.causeOfDeath; txt2.appendChild(d); }
    if (servedInMilitary(p)) { const d = document.createElement("div"); d.className = "pv-sub"; d.textContent = "★ " + (militaryLine(p) || "Served in the military"); txt2.appendChild(d); }
    row.appendChild(txt2);
    host.appendChild(row);
  }
  function renderGalleryPanel(p) {
    const host = $("#galleryStrip"); if (host) renderGallery(host, p, () => { const cur = personById($("#personId").value); if (cur) { renderGalleryPanel(cur); renderPersonHead(cur); } });
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
    $("#pSuffix").value = np.suffix || "";
    renderNotesPanel(p);
    renderGalleryPanel(p);
    { const box = $("#galleryBox"); if (box) box.hidden = readonly; }
    $("#pName").value = p.name || "";
    $("#pBirth").value = p.birth == null ? "" : p.birth;
    $("#pDeath").value = p.death == null ? "" : p.death;
    $("#pCause").value = p.causeOfDeath || "";
    $("#causeField").hidden = !isDeceased(p);
    $("#pBirthDate").value = p.birthDate || "";
    $("#pDeathDate").value = p.deathDate || "";
    // Expand the "Exact dates" section when there's a full date to show, so
    // imported day/month dates are visible without hunting for the toggle.
    const exd = document.querySelector(".exact-dates"); if (exd) exd.open = !!(p.birthDate || p.deathDate);
    $("#pDeceased").checked = isDeceased(p);
    { const m = p.military || null;
      $("#pMilitary").checked = !!m;
      $("#pMilBranch").value = (m && m.branch) || "";
      $("#pMilRank").value = (m && m.rank) || "";
      $("#pMilNotes").value = (m && m.notes) || "";
      $("#militaryFields").hidden = !m; }
    syncAgeLine(p);
    setSex(p.sex);
    setColor(p.color || "");
    photoDirty = false; photoReplaced = false;
    pendingPhoto = photoOf(p);
    // An externalised photo may still be loading — fill the preview when it lands.
    if (!pendingPhoto && p.photoRef) mediaGet(p.photoRef).then((u) => {
      if (u && $("#personId").value === p.id && !photoDirty) { pendingPhoto = u; updatePhotoPreview(); }
    }).catch(() => {});
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
    $("#causeField").hidden = true;
    $("#militaryFields").hidden = true;
    photoDirty = false; photoReplaced = false;
    showPersonForm(null);
    syncAgeLine(null);
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
    renderNotesPanel(null);
  }

  // Private notes in the editor panel: read-only text until "Edit notes" is
  // clicked, so a stray keystroke can't change a saved note.
  function renderNotesPanel(p) {
    const sec = $("#notesSection"); if (!sec) return;
    sec.hidden = !p;
    if (!p) return;
    $("#notesEditBox").hidden = true;
    $("#notesEditBtn").hidden = false;
    const v = $("#notesView");
    v.textContent = p.notes || "No notes yet.";
    v.classList.toggle("empty", !p.notes);
    v.hidden = false;
  }
  $("#notesEditBtn").addEventListener("click", () => {
    const p = personById($("#personId").value); if (!p) return;
    $("#notesText").value = p.notes || "";
    $("#notesEditBox").hidden = false; $("#notesEditBtn").hidden = true; $("#notesView").hidden = true;
  });
  $("#notesCancelBtn").addEventListener("click", () => renderNotesPanel(personById($("#personId").value)));
  $("#notesSaveBtn").addEventListener("click", () => {
    const p = personById($("#personId").value); if (!p) return;
    const v = $("#notesText").value.trim(); if (v) p.notes = v; else delete p.notes;
    save(); renderNotesPanel(p); toast("Notes saved");
  });

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
      const canPhoto = docs.some((d) => isObitDoc(d) && (((d.kind === "image" || d.kind === "pdf") && (d.content || d.ref)) || d.url));
      photoBtn.hidden = !canPhoto;
      photoBtn.textContent = (p.photo || p.photoRef) ? "📷 Replace picture from obituary" : "📷 Use photo from obituary";
    }
    // Offer to (re)read birth & death dates when an obituary is attached but the
    // exact dates are still missing — fixes people uploaded before the automatic
    // date reading existed.
    const datesBtn = $("#obitDatesBtn");
    if (datesBtn) datesBtn.hidden = !(docs.some(isObitDoc) && (!p.birthDate || !p.deathDate));
    if (!docs.length) hint.textContent = "Attach an obituary or any other record (an article, award, certificate…) — paste the text, upload a PDF/photo, or save a link. Kept with the tree so it survives even if the original goes offline.";
    else hint.textContent = "";
    docs.forEach((doc) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="badge">${docIcon(doc.kind)}</span>
        <span class="t">${escapeHtml(doc.title || "Untitled")} <span class="kind">${doc.kind === "link" ? "link only" : doc.kind}</span></span>
        <button data-view>View</button><button class="rm" data-rm>✕</button>`;
      li.querySelector("[data-view]").onclick = () => openDocViewer(doc, p.id);
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
  // Date/year fields update QUIETLY while focused: the browser fires `change`
  // on a date input at every keystroke once all segments are filled, and a
  // form rebuild mid-typing would destroy the input under the user's cursor.
  // So: write the value + repaint the tree label live, coalesce the whole
  // typing burst into ONE undo step, and rebuild the form only on blur.
  let relFieldUndoKey = null;
  function relSetUnionField(unionId, field, val, personId, quiet) {
    const u = unionById(unionId); if (!u) { if (!quiet) refreshRel(personId); return; }
    val = (val || "").trim();
    if (val === (u[field] || "")) { if (!quiet) refreshRel(personId); return; }
    const key = unionId + "/" + field;
    if (relFieldUndoKey !== key) { pushUndo(); relFieldUndoKey = key; }
    if (val) u[field] = val; else delete u[field];
    if (quiet) { save(); render(); }
    else { relFieldUndoKey = null; refreshRel(personId); }
  }
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
      pinInPlace(personId);
      if (!partnerId) partnerId = addPerson({ name: "New spouse", sex: guessSpouseSex(personById(personId)) }).id;
      else pinInPlace(partnerId);
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
      else pinInPlace(childId);   // an existing person keeps the spot they're on
      addChild(unionId, childId, "bio");
      // only a brand-new child gets placed under these parents
      if (!cid) { const u = unionById(unionId); if (u) placeNewChild(u, childId); }
      if (!cid) focusNewPerson(personById(childId));
      else { refreshRel(personId); toast("Child linked"); }
    }, [personId]);
  }
  function relAddParent(personId) {
    pickPerson("Add a parent", "Pick an existing person as a parent, or create a new one. If this person already has one parent, the new one joins them as the second parent.",
      (pid) => {
        if (pid === personId) return toast("Pick someone else");
        pushUndo();
        pinInPlace(personId);   // gaining a parent must not move them
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
    if (pl) return relAddChild(pl.union, personId);
    // Parents unknown: they can still be recorded as brother and sister. They go
    // in a sibling group and get the same family bar as everyone else — lines up
    // from each of them, joined above, with nothing over the top.
    pickPerson("Add a sibling", "Pick an existing person, or create a new one. Their parents aren’t known, so they’ll simply be joined as siblings.", (cid) => {
      if (cid === personId) return toast("Pick someone else");
      pushUndo();
      let g = sibGroupOf(personId);
      if (!g) { g = addUnion(null, null, "siblings"); addChild(g.id, personId, "bio"); }
      const sibId = cid || addPerson({ name: "New person", sex: "unknown" }).id;
      if (cid) pinInPlace(sibId);   // an existing person keeps the spot they're on
      addChild(g.id, sibId, "bio");
      if (!cid) { placeNewChild(g, sibId); focusNewPerson(personById(sibId), "Added sibling — type their name and Save"); }
      else { refreshRel(personId); toast("Sibling linked"); }
    }, [personId]);
  }
  // Take someone back out of a sibling group (the group itself is tidied away
  // once it has nobody left to join up).
  function relRemoveSibling(pid, sibId) {
    const g = sibGroupOf(pid); if (!g) return;
    if (!state.links.some((l) => l.union === g.id && l.child === sibId)) return;
    const other = personById(sibId);
    if (!confirm("Remove " + (other ? other.name : "them") + " as a sibling? Both people stay in the tree.")) return;
    pushUndo();
    markRemoved(tombKey.link(g.id, sibId));
    state.links = state.links.filter((l) => !(l.union === g.id && l.child === sibId));
    refreshRel(pid);
    toast("Sibling removed");
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
    const set = new Set();
    // anyone hanging off the same family bar — including a sibling group, where
    // the bar is all there is because the parents aren't known
    const mineU = new Set(parentLinksOfPerson(pid).map((l) => l.union));
    if (mineU.size) state.links.forEach((l) => { if (l.child !== pid && mineU.has(l.union) && personById(l.child)) set.add(l.child); });
    const mine = parentsOf(pid);
    if (mine.size) state.persons.forEach((q) => {
      if (q.id === pid || set.has(q.id)) return;
      const theirs = parentsOf(q.id);
      for (const x of theirs) { if (mine.has(x)) { set.add(q.id); break; } }
    });
    return [...set];
  }
  // The sibling group pid belongs to, if any (parents unknown).
  const sibGroupOf = (pid) => state.unions.find((u) => isSibGroup(u) && state.links.some((l) => l.union === u.id && l.child === pid)) || null;

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
      // One person can appear in more than one place: repeat them (with their
      // spouse and children) beside these parents, while their main spot stays
      // wherever you put it.
      [...new Set(parentRows.map((r) => r.l.id))].forEach((lid) => {
        const l = state.links.find((x) => x.id === lid); if (!l) return;
        const flag = (state.portals || {})[lid];
        const shown = flag === true || (flag !== false && (copySpots[pid] || []).some((c) => c.uid === l.union));
        const li = document.createElement("li"); li.className = "rel-copy";
        const b = document.createElement("button"); b.type = "button"; b.className = "btn small";
        b.textContent = shown ? "⧉ Also shown here — remove this copy" : "⧉ Also show a copy here";
        b.title = shown
          ? "Stop repeating them beside these parents — the line is drawn instead, however long"
          : "Repeat them here — with their spouse and children — while their main spot stays where it is";
        b.onclick = () => {
          pushUndo();
          (state.portals || (state.portals = {}))[lid] = !shown;
          save(); render(); refreshRel(pid);
          toast(shown ? "Copy removed — they're drawn in one place now" : "Now shown in both places — drag either one wherever you like");
        };
        li.appendChild(b); box.appendChild(li);
      });
    }

    // ---- Siblings ---- (derived from shared parents, so read-only — except
    // the ones joined by hand in a sibling group, which can be undone here)
    const sibs = siblingsOf(pid);
    if (sibs.length) {
      groupTitle("Siblings");
      const g = sibGroupOf(pid);
      const inGroup = new Set(g ? state.links.filter((l) => l.union === g.id).map((l) => l.child) : []);
      sibs.forEach((sid) => rowFor(sid, kindText(nounSibling(personById(sid).sex)),
        inGroup.has(sid) ? removeBtn(() => relRemoveSibling(pid, sid)) : null));
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
          i.onchange = () => relSetUnionField(u.id, field, i.value, pid, true);   // quiet: typing must not rebuild the form
          i.onblur = () => { relFieldUndoKey = null; refreshRel(pid); };
          i.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); i.blur(); } };
          wrap.appendChild(lab); wrap.appendChild(i);
          return wrap;
        };
        // Marriage takes an exact date; only fill the picker from an ISO value
        // (a legacy year-only entry can't populate a date box but still shows on the tree).
        dRow.appendChild(dateField(st === "partners" ? "Together" : "Married", "marriage", "date", isISODate(u.marriage) ? u.marriage : ""));
        // …or just a year when the exact day isn't known (either box works;
        // whichever was filled last wins)
        {
          const yWrap = document.createElement("span"); yWrap.className = "rel-date-field";
          const yLab = document.createElement("span"); yLab.className = "rel-date-label"; yLab.textContent = "or year";
          const yi = document.createElement("input"); yi.type = "text"; yi.className = "rel-date"; yi.placeholder = "year";
          yi.value = !isISODate(u.marriage) ? (u.marriage || "") : "";
          yi.onchange = () => { relSetUnionField(u.id, "marriage", yi.value, pid, true); const di = dRow.querySelector('input[type="date"]'); if (di && yi.value.trim()) di.value = ""; };
          yi.onblur = () => { relFieldUndoKey = null; refreshRel(pid); };
          yi.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); yi.blur(); } };
          const di = dRow.querySelector('input[type="date"]');
          if (di) di.addEventListener("change", () => { if (di.value) yi.value = ""; });
          yWrap.appendChild(yLab); yWrap.appendChild(yi);
          dRow.appendChild(yWrap);
        }
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
    const np = nameParts({ first: $("#pFirst").value.trim(), middle: $("#pMiddle").value.trim(), last: $("#pLast").value.trim(), nickname: $("#pNick").value.trim(), maiden: formSex === "female" ? $("#pMaiden").value.trim() : "", suffix: $("#pSuffix").value.trim() });
    const data = { name: np.name, first: np.first, middle: np.middle, last: np.last, nickname: np.nickname, maiden: np.maiden, suffix: np.suffix, birth: birthYear, death: deathYear, birthDate, deathDate, deceased: $("#pDeceased").checked, causeOfDeath: $("#pCause").value.trim() || null, sex: formSex, color: formColor, photo: pendingPhoto };
    if (id) {
      const p = personById(id);
      Object.assign(p, { name: np.name, first: np.first, middle: np.middle, last: np.last, nickname: np.nickname, maiden: np.maiden, suffix: np.suffix, birth: num(data.birth), death: num(data.death), birthDate: data.birthDate, deathDate: data.deathDate, deceased: data.deceased, sex: data.sex, color: data.color || null });
      const cause = $("#pCause").value.trim();
      if (cause) p.causeOfDeath = cause; else delete p.causeOfDeath;
      if ($("#pMilitary").checked) {
        p.military = { branch: $("#pMilBranch").value.trim(), rank: $("#pMilRank").value.trim(), notes: $("#pMilNotes").value.trim() };
      } else delete p.military;
      // The photo only changes when the user actually changed it — an
      // externalised photo that hadn't finished loading is never wiped.
      if (photoDirty) {
        // a different picture taking over: the old one joins their gallery
        if (pendingPhoto && photoReplaced) archiveTreePicture(p);
        delete p.photoSrcRef;   // the kept original belongs to the picture being replaced
        if (pendingPhoto) { p.photo = pendingPhoto; delete p.photoRef; scheduleSweep(); }
        else { delete p.photo; delete p.photoRef; }
      }
    } else {
      const p = addPerson(data); selectedId = p.id;
    }
    const saved = personById(selectedId);
    resetPersonForm();
    if (saved) { fillPersonForm(saved); showPersonView(saved); }   // back to their profile
    relayoutAndSave();
    toast("Saved");
  });
  // Entering a full date fills in (and keeps in sync) the year that shows on the tree.
  $("#pBirthDate").addEventListener("change", () => { const v = $("#pBirthDate").value; if (v) $("#pBirth").value = v.slice(0, 4); });
  $("#pDeathDate").addEventListener("change", () => { const v = $("#pDeathDate").value; if (v) { $("#pDeath").value = v.slice(0, 4); $("#pDeceased").checked = true; } syncCauseVis(); });
  // The cause-of-death box shows only once the form says they've passed away.
  function syncCauseVis() { $("#causeField").hidden = !($("#pDeceased").checked || $("#pDeath").value || $("#pDeathDate").value); }
  // Their age, from whatever the boxes say right now — at death once they've
  // passed away, today's age while they're living.
  function syncAgeLine(p) {
    const el2 = $("#ageLine"); if (!el2) return;
    const src = p || {
      birth: $("#pBirth").value ? parseInt($("#pBirth").value, 10) : null,
      death: $("#pDeath").value ? parseInt($("#pDeath").value, 10) : null,
      birthDate: $("#pBirthDate").value || null,
      deathDate: $("#pDeathDate").value || null,
      deceased: $("#pDeceased").checked,
    };
    const a = ageLabel(src);
    el2.hidden = !a;
    el2.textContent = !a ? "" : (isDeceased(src) ? "Age at death: " + a : "Age: " + a);
  }
  ["#pBirth", "#pDeath", "#pBirthDate", "#pDeathDate", "#pDeceased"].forEach((sel) => {
    const n = $(sel); if (n) { n.addEventListener("input", () => syncAgeLine(null)); n.addEventListener("change", () => syncAgeLine(null)); }
  });
  { const c = $("#pMilitary"); if (c) c.addEventListener("change", () => { $("#militaryFields").hidden = !c.checked; }); }
  $("#pDeceased").addEventListener("change", syncCauseVis);
  $("#pDeath").addEventListener("input", syncCauseVis);
  { const b = $("#galleryAddBtn"), inp = $("#galleryInput");
    if (b && inp) {
      b.onclick = () => { if (!$("#personId").value) return toast("Save this person first, then add photos"); inp.click(); };
      inp.onchange = async () => {
        const p = personById($("#personId").value); if (!p) return;
        const n = await galleryAdd(p, inp.files); inp.value = "";
        if (n) { fillPersonForm(p); toast(n === 1 ? "Photo added" : n + " photos added"); }
      };
    } }
  $("#personCancel").onclick = () => {
    const p = personById($("#personId").value);
    resetPersonForm();
    if (p) { fillPersonForm(p); showPersonView(p); }
  };
  $("#personDelete").onclick = () => {
    const id = $("#personId").value; if (!id) return;
    if (confirm("Delete this person and their connections?")) {
      deletePerson(id); selectedId = null; resetPersonForm(); relayoutAndSave();
    }
  };

  /* photo upload with downscale */
  $("#photoDrop").onclick = () => $("#photoInput").click();
  $("#photoClear").onclick = () => { pendingPhoto = null; photoDirty = true; updatePhotoPreview(); };
  $("#photoUrlBtn").onclick = () => setPhotoFromUrl($("#photoUrl").value);
  $("#photoInput").addEventListener("change", async (e) => {
    const file = e.target.files[0]; e.target.value = ""; if (!file) return;
    let src = null;
    try { src = await fileAsPictureDataUrl(file); }
    catch (err) { toast(isPdfFile(file) ? "Couldn’t read that PDF — try saving the page as a JPG." : "Couldn’t convert that HEIC photo — try exporting it as JPG."); return; }
    if (!src) return toast("Couldn’t read that file.");
    openPhotoAdjust(src, (photo) => { pendingPhoto = photo; photoDirty = true; photoReplaced = true; updatePhotoPreview(); });
  });
  // Set when the staged photo is a DIFFERENT picture (a file, a drop, a link) —
  // not when it's the current one being re-framed with Adjust.
  let photoReplaced = false;
  $("#photoAdjustBtn").onclick = () => { if (pendingPhoto) openPhotoAdjust(pendingPhoto, (photo) => { pendingPhoto = photo; photoDirty = true; updatePhotoPreview(); }); };
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
        openPhotoAdjust(data.image, (photo) => { pendingPhoto = photo; photoDirty = true; photoReplaced = true; updatePhotoPreview(); toast("Photo loaded — click Save to keep it"); });
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
      stage.addEventListener("pointerdown", (e) => { e.preventDefault(); try { stage.setPointerCapture(e.pointerId); } catch (err) {} pts.set(e.pointerId, toLocal(e)); if (pts.size === 1) last = toLocal(e); pinchDist = 0; });
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

  /* ================= MEDIA STORE: photos & documents as their own files =================
     The tree used to carry every photo/PDF inside its one big encrypted blob, so
     every save and sync moved ~8MB. Now each binary lives in its OWN file,
     encrypted under a random media key that itself travels INSIDE the encrypted
     tree (so the family password still protects everything, and published view
     slices carry the key so their photos work). Files upload once and are
     content-addressed by a random id — they never change, so devices cache them
     for good. */
  const mediaMem = new Map();      // ref -> decrypted dataURL (this session)
  const mediaPending = new Set();
  let mediaRenderTimer = null;
  function ensureMediaKey() {
    if (!state.mediaKey) { state.mediaKey = b64(crypto.getRandomValues(new Uint8Array(32))); }
    return state.mediaKey;
  }
  async function mediaCryptoKey() {
    if (!state.mediaKey) return null;
    return await crypto.subtle.importKey("raw", unb64(state.mediaKey), "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  async function mediaEncrypt(dataUrl) {
    const key = await mediaCryptoKey(); if (!key) throw new Error("no media key");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(dataUrl));
    return JSON.stringify({ v: "m1", iv: b64(iv), ct: b64(ct) });
  }
  async function mediaDecrypt(payload) {
    const key = await mediaCryptoKey(); if (!key) throw new Error("no media key");
    const o = JSON.parse(payload);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(o.iv) }, key, unb64(o.ct));
    return new TextDecoder().decode(pt);
  }
  async function mediaUpload(dataUrl) {
    ensureMediaKey();
    const id = "m" + Math.random().toString(36).slice(2, 12);
    const payload = await mediaEncrypt(dataUrl);
    let pass = ""; try { pass = localStorage.getItem("familyTree.importPass") || ""; } catch (e) {}
    if (!pass) throw new Error("not the owner");
    const r = await fetch("api/store", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "putMedia", passcode: pass, items: [{ id, payload }] }) });
    if (!r.ok) throw new Error((((await r.json().catch(() => ({}))) || {}).error) || "upload failed");
    mediaMem.set(id, dataUrl);
    idbSet("media." + id, dataUrl).catch(() => {});
    return id;
  }
  async function mediaGet(ref) {
    if (!ref) return null;
    if (mediaMem.has(ref)) return mediaMem.get(ref);
    try { const c = await idbGet("media." + ref); if (c) { mediaMem.set(ref, c); return c; } } catch (e) {}
    const r = await fetch("api/store?action=getMedia&id=" + encodeURIComponent(ref));
    if (!r.ok) throw new Error("media fetch failed");
    const j = await r.json();
    const dataUrl = await mediaDecrypt(j.payload);
    mediaMem.set(ref, dataUrl);
    idbSet("media." + ref, dataUrl).catch(() => {});
    return dataUrl;
  }
  // Synchronous accessor for the render loop: hands back what's cached and
  // quietly loads the rest, re-drawing once when a batch arrives.
  function photoOf(p) {
    if (!p) return null;
    if (p.photo) return p.photo;   // still embedded (legacy, or added moments ago)
    if (!p.photoRef) return null;
    if (mediaMem.has(p.photoRef)) return mediaMem.get(p.photoRef);
    queueMediaLoad(p.photoRef);
    return null;
  }
  function queueMediaLoad(ref) {
    if (mediaPending.has(ref) || mediaMem.has(ref)) return;
    mediaPending.add(ref);
    mediaGet(ref).then(() => {
      if (mediaRenderTimer) clearTimeout(mediaRenderTimer);
      mediaRenderTimer = setTimeout(() => { mediaRenderTimer = null; render(); }, 200);
    }).catch(() => {}).finally(() => mediaPending.delete(ref));
  }
  const docSrcAsync = async (doc) => {
    const s0 = docSrc(doc); if (s0) return s0;
    if (doc && doc.ref) { try { return await mediaGet(doc.ref); } catch (e) {} }
    return "";
  };
  // Move every embedded photo/document into its own encrypted file: the one-time
  // slimming migration, and the ongoing sweep for anything newly embedded.
  // Each file is verified by re-downloading and decrypting before the embedded
  // copy is dropped; failures simply stay embedded and retry later.
  let sweepRunning = false, sweepTimer = null;
  function scheduleSweep() { if (sweepTimer) clearTimeout(sweepTimer); sweepTimer = setTimeout(() => { sweepTimer = null; sweepEmbeddedMedia(false); }, 5000); }
  // Self-heal: if the cloud store lost a photo/document file the tree still
  // references (it happened in the Blob→GitHub move), re-upload it from this
  // device's local cache. Runs once per session on the editor's devices.
  async function healMissingMedia() {
    if (readonly || !CLOUD_ON()) return;
    let pass = ""; try { pass = localStorage.getItem("familyTree.importPass") || ""; } catch (e) {}
    if (!pass || !state.mediaKey) return;
    try {
      const r = await fetch("api/store?action=listMedia"); if (!r.ok) return;
      const have = new Set(((await r.json()).ids) || []);
      const wanted = new Set();
      state.persons.forEach((p) => { if (p.photoRef) wanted.add(p.photoRef); if (p.photoSrcRef) wanted.add(p.photoSrcRef); (p.docs || []).forEach((d) => { if (d.ref) wanted.add(d.ref); }); (p.gallery || []).forEach((g) => { if (g.ref) wanted.add(g.ref); }); });
      const missing = [...wanted].filter((id) => !have.has(id));
      if (!missing.length) return;
      const items = [];
      for (const id of missing) {
        let cached = null;
        try { cached = mediaMem.get(id) || (await idbGet("media." + id)); } catch (e) {}
        if (cached) items.push({ id, payload: await mediaEncrypt(cached) });
      }
      if (!items.length) return;
      for (let i = 0; i < items.length; i += 20) {
        const r2 = await fetch("api/store", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "putMedia", passcode: pass, items: items.slice(i, i + 20) }) });
        if (!r2.ok) return;
      }
      toast("♻️ Restored " + items.length + " photo" + (items.length > 1 ? "s" : "") + " to the cloud from this device's saved copies");
    } catch (e) {}
  }
  async function sweepEmbeddedMedia(firstRun) {
    if (sweepRunning || readonly) return;
    let pass = ""; try { pass = localStorage.getItem("familyTree.importPass") || ""; } catch (e) {}
    if (!pass || !CLOUD_ON()) return;
    const jobs = [];
    state.persons.forEach((p) => {
      if (p.photo && /^data:/.test(p.photo)) jobs.push({ kind: "photo", p });
      (p.gallery || []).forEach((g) => { if (g && g.data && /^data:/.test(g.data)) jobs.push({ kind: "gal", g }); });
      (p.docs || []).forEach((d) => {
        if (!d) return;
        if ((d.kind === "image" || d.kind === "pdf") && d.content && /^data:/.test(d.content)) jobs.push({ kind: "doc", d });
        else if (d.path) jobs.push({ kind: "docpath", d });
      });
    });
    if (!jobs.length) return;
    sweepRunning = true;
    if (firstRun) toast("Slimming storage: moving " + jobs.length + " photos & documents into their own files (runs in the background)…");
    try { await idbSet("tree.v1.preDietBackup", exportObject()); } catch (e) {}
    let moved = 0, failed = 0;
    for (const j of jobs) {
      try {
        let dataUrl;
        if (j.kind === "photo") dataUrl = j.p.photo;
        else if (j.kind === "gal") dataUrl = j.g.data;
        else if (j.kind === "doc") dataUrl = j.d.content;
        else {   // legacy record stored server-side unencrypted: pull it back in, re-store encrypted
          const rr = await fetch(recordSrc(j.d.path)); if (!rr.ok) throw new Error("record fetch failed");
          const bl = await rr.blob();
          dataUrl = await new Promise((res2, rej2) => { const fr = new FileReader(); fr.onload = () => res2(fr.result); fr.onerror = rej2; fr.readAsDataURL(bl); });
        }
        const id = await mediaUpload(dataUrl);
        const vr = await fetch("api/store?action=getMedia&id=" + encodeURIComponent(id) + "&ts=" + Date.now());
        if (!vr.ok) throw new Error("verify fetch failed");
        if ((await mediaDecrypt((await vr.json()).payload)) !== dataUrl) throw new Error("verify mismatch");
        if (j.kind === "photo") { j.p.photoRef = id; delete j.p.photo; }
        else if (j.kind === "gal") { j.g.ref = id; delete j.g.data; }
        else { j.d.ref = id; delete j.d.content; delete j.d.path; }
        moved++;
        if (moved % 5 === 0) { save(); if (firstRun) toast("Slimming storage… " + moved + "/" + jobs.length); }
      } catch (e) { failed++; }
    }
    if (moved) save();
    if (firstRun) toast(failed ? "Moved " + moved + " files ✓ — " + failed + " will retry next time" : "Storage slimmed ✓ — every save is now far lighter");
    sweepRunning = false;
  }
  // A self-contained copy with every photo/document folded back in — used for
  // manual exports and the downloadable published file, so backups never depend
  // on the online media store.
  async function exportInlinedObject() {
    const obj = JSON.parse(JSON.stringify(exportObject()));
    for (const p of obj.persons) {
      delete p.photoSrcRef;   // the uncropped original is a convenience, not part of a backup
      if (p.photoRef) { try { const u = await mediaGet(p.photoRef); if (u) { p.photo = u; delete p.photoRef; } } catch (e) {} }
      for (const d of (p.docs || [])) {
        if (d && d.ref) { try { const u = await mediaGet(d.ref); if (u) { d.content = u; delete d.ref; } } catch (e) {} }
      }
      for (const g of (p.gallery || [])) {
        if (g && g.ref) { try { const u = await mediaGet(g.ref); if (u) { g.data = u; delete g.ref; } } catch (e) {} }
      }
    }
    delete obj.mediaKey;
    return obj;
  }
  const hasGzip = typeof CompressionStream === "function" && typeof DecompressionStream === "function";
  async function gzip(bytes) {
    const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  async function gunzip(bytes) {
    const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  async function encryptState(password, obj) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    // Compress before encrypting so embedded photos/PDFs don't bloat the payload
    // (encrypted data can't be compressed afterwards). Single base64, not double —
    // together this roughly halves the size that goes to backup/publish, so big
    // trees stay under the server's request limit (413 Payload Too Large).
    let data = new TextEncoder().encode(JSON.stringify(obj || exportObject()));
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
  // Encrypt/decrypt a short piece of text with the same crypto as the tree.
  // Used to wrap the family password under the shared viewer password, so a
  // viewer password can open the tree without the owner's password ever being
  // stored in the clear.
  async function encryptText(password, text) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));
    return JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
  }
  async function decryptText(password, payload) {
    const o = JSON.parse(payload);
    const key = await deriveKey(password, unb64(o.salt));
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(o.iv) }, key, unb64(o.ct));
    return new TextDecoder().decode(pt);
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
        exportInlinedObject().then((full) => encryptState(p1, full)).then((payload) => {
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
  // A doc.path saved as a DIRECT blob URL is rerouted through the site's own
  // record proxy: on a private Blob store the direct URL isn't fetchable.
  const recordSrc = (path) => {
    const m = /^https:\/\/[^/]*\.blob\.vercel-storage\.com\/([^?]+)/.exec(path || "");
    return m ? "api/store?action=getRecord&p=" + encodeURIComponent(m[1]) : path;
  };
  const docSrc = (doc) => (doc && (doc.content || (doc.ref && mediaMem.get(doc.ref)) || (doc.path ? recordSrc(doc.path) : "")));
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
    try {
      doc.ref = await mediaUpload(dataUrl);   // its own ENCRYPTED file — the tree stays small
      doc.mediaType = m[1]; delete doc.content; delete doc.path;
      return true;
    } catch (e) { return false; }
  }

  function openAttachModal(personId, onDone) {
    const person = personById(personId); if (!person) return;
    const obitTitle = person.name + "’s Obituary";
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = `<div class="modal"><h2>Attach to ${escapeHtml(person.name)}</h2>
      <div class="attach-choice"><button type="button" id="dTypeObit" class="active">Obituary</button><button type="button" id="dTypeRecord">Other record</button></div>
      <div class="hint" id="dTypeHint">An obituary marks ${escapeHtml(person.name)} as deceased, and its photo becomes their picture in the tree.</div>
      <label class="field" id="dTitleField" hidden><span>What is this record?</span><input type="text" id="dTitle" placeholder="e.g. South Dakota Basketball Hall of Fame"/></label>
      <label class="field"><span>Link to it</span><input type="text" id="dUrl" placeholder="https://…"/></label>
      <label class="field"><span>…or paste the text</span><textarea id="dText" rows="5" placeholder="Paste the text here…"></textarea></label>
      <label class="field"><span>…or upload a photo / PDF</span><input type="file" id="dFile" accept="application/pdf,image/*,.heic,.heif,.txt,.html"/></label>
      <div class="err" id="dErr" style="color:var(--divorce);font-size:12.5px;min-height:16px"></div>
      <div class="hint" id="dStatus"></div>
      <div class="btn-row"><button class="btn" data-cancel>Cancel</button><button class="btn primary" id="dSave">Save</button></div></div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.querySelector("[data-cancel]").onclick = close;
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    const err = back.querySelector("#dErr"), status = back.querySelector("#dStatus");
    const saveBtn = back.querySelector("#dSave");
    // Obituary vs. other record (a news article, an award, a hall-of-fame page…).
    // Only an obituary marks the person deceased — a record of a living relative
    // must never do that.
    let docType = "obituary";
    const typeBtns = { obituary: back.querySelector("#dTypeObit"), record: back.querySelector("#dTypeRecord") };
    const setType = (t) => {
      docType = t;
      typeBtns.obituary.classList.toggle("active", t === "obituary");
      typeBtns.record.classList.toggle("active", t === "record");
      back.querySelector("#dTitleField").hidden = t !== "record";
      back.querySelector("#dTypeHint").textContent = t === "obituary"
        ? `An obituary marks ${person.name} as deceased, and its photo becomes their picture in the tree.`
        : `A record is anything worth keeping — an article, award, certificate… It does NOT mark ${person.name} as deceased.`;
    };
    typeBtns.obituary.onclick = () => setType("obituary");
    typeBtns.record.onclick = () => setType("record");

    saveBtn.onclick = async () => {
      err.textContent = "";
      const url = back.querySelector("#dUrl").value.trim();
      const text = back.querySelector("#dText").value.trim();
      let file = back.querySelector("#dFile").files[0];
      let kind = "link", content = "", fetchedImage = "", scrapedText = "", fileB64 = "", fileMt = "";
      if (file) {
        if (file.size > 8 * 1024 * 1024) { err.textContent = "File is too large (max 8 MB)."; return; }
        if (isHeicFile(file)) {
          try { status.textContent = "Converting iPhone photo (HEIC)…"; file = await normalizeImageFile(file); status.textContent = ""; }
          catch (e) { err.textContent = "Couldn’t convert that HEIC photo — try exporting it as JPG."; status.textContent = ""; return; }
        }
        fileMt = file.type;
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

      const recTitle = (back.querySelector("#dTitle").value || "").trim();
      const title = docType === "record" ? (recTitle || "Record") : obitTitle;
      const doc = { id: uid(), title, docType, url, capturedAt: todayStr(), kind, content };
      if (scrapedText) doc.text = scrapedText;   // durable, searchable copy of a photo/PDF's text

      // Make the node picture from the image BEFORE we externalise the file (we
      // need the pixels here; the stored record is downscaled separately).
      // Obituaries only — a scan of an article/award shouldn't become someone's face.
      let setPic = false;
      // Only for someone with NO picture at all — an externalised picture is
      // still a picture (p.photoRef), and missing that is how obituaries came to
      // overwrite faces. And only from an actual photo: page one of a PDF
      // obituary is a page of text, not a portrait. The "Use photo from
      // obituary" button is still there for when it genuinely is one.
      if (docType === "obituary" && !person.photo && !person.photoRef) {
        const picSrc = kind === "image" ? content : fetchedImage;
        if (picSrc) { const photo = await imageDataToPhoto(picSrc); if (photo) { person.photo = photo; setPic = true; scheduleSweep(); } }
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
      // Only an obituary means they've passed away — a record never flips this.
      if (docType === "obituary") person.deceased = true;

      // Read the exact birth & death dates out of the obituary (the AI reader —
      // reliable on real prose, PDFs and photos) and fill any gaps on the profile.
      // This step was missing from the upload flow, which is why dates weren't
      // being imported on attach.
      let gotDates = false, triedDates = false;
      if (docType === "obituary" && (!person.birthDate || !person.deathDate)) {
        let pass3 = ""; try { pass3 = localStorage.getItem("familyTree.importPass") || ""; } catch (e) {}
        const dsrc = scrapedText ? { text: scrapedText }
          : (kind === "text" && content ? { text: content }
          : (fileB64 ? { file: { mediaType: fileMt, data: fileB64 } }
          : (url ? { url } : null)));
        if (pass3 && dsrc) {
          triedDates = true;
          saveBtn.disabled = true; status.textContent = "Reading " + person.name + "’s birth & death dates…";
          try { gotDates = applyObitDates(person, await callDates(Object.assign({ passcode: pass3, name: person.name }, dsrc))); }
          catch (e3) { const t = scrapedText || (kind === "text" ? content : ""); if (t) { try { gotDates = applyObitDates(person, parseObitDates(t)); } catch (_) {} } }
          status.textContent = ""; saveBtn.disabled = false;
        }
      }

      save(); render(); renderDocsForm(person); if (selectedId === person.id) fillPersonForm(person);
      close();
      if (onDone) { try { onDone(); } catch (e) {} }
      const what = docType === "record" ? "Record" : "Obituary";
      const extras = [];
      if (scrapedText) extras.push("text scraped");
      if (setPic) extras.push("set as their picture");
      if (gotDates) extras.push("birth & death dates filled in");
      toast(what + " saved" + (extras.length ? " — " + extras.join(", ") : ""));
      if (triedDates && !gotDates) toast("Couldn’t read exact dates from this one — you can set them in the profile");
    };
  }

  // Load an image data-URL and return a downscaled JPEG suitable for a node picture.
  function imageDataToPhoto(dataUrl) {
    if (isPdfData(dataUrl)) return pdfFirstPageImage(dataUrl).then((u) => (u ? imageDataToPhoto(u) : null)).catch(() => null);
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
      if (p.photo || p.photoRef || !Array.isArray(p.docs)) continue;
      const imgDoc = p.docs.find((d) => isObitDoc(d) && d.kind === "image" && (docSrc(d) || d.ref));   // a photo, never a PDF page
      if (!imgDoc) continue;
      const photo = await imageDataToPhoto(await docSrcAsync(imgDoc));
      if (photo) { p.photo = photo; changed = true; }
    }
    return changed;
  }

  // Find a picture for one person from their obituary: use an uploaded photo
  // obituary if there is one, otherwise fetch the portrait from a linked
  // obituary page. Used by the "Use photo from obituary" button, so it works
  // retroactively for obituaries that are already attached.
  // Fill missing birth/death dates from an already-attached obituary — the same
  // AI reader the upload flow uses, so it works retroactively.
  async function readDatesFromObit(p) {
    if (!p) return;
    const src = await resolveObitSource(obitSourceOf(p));
    if (!src) { toast("No obituary attached to read from"); return; }
    let pass = ""; try { pass = localStorage.getItem("familyTree.importPass") || ""; } catch (e) {}
    if (!pass) pass = prompt("One-time import passcode (set as IMPORT_PASSCODE on the Vercel site):") || "";
    if (!pass) return;
    try { localStorage.setItem("familyTree.importPass", pass); } catch (e) {}
    const btn = $("#obitDatesBtn"); if (btn) btn.disabled = true;
    toast("Reading " + p.name + "’s dates…");
    try {
      const changed = applyObitDates(p, await callDates(Object.assign({ passcode: pass, name: p.name }, src)));
      if (changed) { save(); render(); if (selectedId === p.id) fillPersonForm(p); toast("Birth & death dates filled in ✓"); }
      else toast("No usable dates found in the obituary");
    } catch (e) { toast(e.message || "Couldn’t read the dates"); }
    if (btn) btn.disabled = false;
  }

  async function usePhotoFromObit(p) {
    if (!p) return;
    const docs = (p.docs || []).filter(isObitDoc);   // obituaries only — never a record scan
    const imgDoc = docs.find((d) => d && (d.kind === "image" || d.kind === "pdf") && (docSrc(d) || d.ref));
    if (imgDoc) {
      const photo = await imageDataToPhoto(await docSrcAsync(imgDoc));
      if (photo) { archiveTreePicture(p); p.photo = photo; delete p.photoRef; delete p.photoSrcRef; scheduleSweep(); save(); render(); if (selectedId === p.id) fillPersonForm(p); toast("Set their picture from the obituary"); return; }
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
        if (photo) { archiveTreePicture(p); p.photo = photo; delete p.photoRef; delete p.photoSrcRef; save(); render(); if (selectedId === p.id) fillPersonForm(p); toast("Set their picture from the obituary"); return; }
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
  // Only obituary-type docs (docs saved before types existed are all obituaries).
  // Records — articles, awards — must never feed the date reader or the
  // photo-from-obituary flow.
  const isObitDoc = (d) => d && (!d.docType || d.docType === "obituary");
  function obitTextOf(p) {
    return (p.docs || []).filter(isObitDoc)
      .map((d) => (d.text || (d.kind === "text" ? d.content : "")))
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
    const docs = (p.docs || []).filter(isObitDoc);
    const text = obitTextOf(p);
    if (text) return { text };
    for (const d of docs) {
      if (d.kind !== "pdf" && d.kind !== "image") continue;
      const m = /^data:([^;]+);base64,(.*)$/.exec(d.content || "");
      if (m) return { file: { mediaType: m[1], data: m[2] } };
      if (d.ref) return { ref: d.ref };   // externalised media — resolveObitSource() turns this into a file
      if (d.path) return { url: new URL(recordSrc(d.path), location.href).href };   // externalised → let the server fetch it
    }
    const link = docs.find((d) => d.url);
    if (link) return { url: link.url };
    return null;
  }
  async function resolveObitSource(src) {
    if (!src || !src.ref) return src;
    try {
      const du = await mediaGet(src.ref);
      const m = /^data:([^;]+);base64,(.*)$/.exec(du || "");
      if (m) return { file: { mediaType: m[1], data: m[2] } };
    } catch (e) {}
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
        const src = await resolveObitSource(obitSourceOf(p));
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

  async function openDocViewer(doc, personId) {
    if (doc && doc.ref && !mediaMem.has(doc.ref)) { try { await mediaGet(doc.ref); } catch (e) {} }
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
    const media = doc.kind === "pdf" || doc.kind === "image";
    const back = document.createElement("div");
    back.className = "modal-backdrop docview-backdrop"; back.id = "docViewerBack";
    back.innerHTML = `<div class="modal doc-view${media ? " media" : ""}"><h2>${escapeHtml(doc.title || "Record")}</h2>
      <div class="src">${srcLine}</div>${bodyHtml}
      <div class="btn-row">${media ? '<button class="btn" data-max>⤢ Larger</button>' : ""}${doc.kind !== "link" ? '<button class="btn" data-dl>⬇︎ Download</button>' : ""}<button class="btn primary" data-cancel>Close</button></div></div>`;
    document.body.appendChild(back);
    const close = () => { back.remove(); document.removeEventListener("keydown", esc); };
    function esc(ev) { if (ev.key === "Escape") close(); }
    document.addEventListener("keydown", esc);
    back.querySelector("[data-cancel]").onclick = close;
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    const dl = back.querySelector("[data-dl]");
    if (dl) dl.onclick = () => downloadDoc(doc);
    const mx = back.querySelector("[data-max]");
    if (mx) mx.onclick = () => { const m = back.querySelector(".doc-view"); const on = m.classList.toggle("max"); mx.textContent = on ? "⤡ Smaller" : "⤢ Larger"; };
    // Desktop: the viewer floats over the tree instead of blocking the page, and
    // the person's profile opens in the side panel — so you can read the
    // obituary and edit their details at the same time.
    if (!isMobileView()) {
      if (personId && !readonly) { const panel = $("#panel"); if (panel) panel.classList.remove("collapsed"); selectPerson(personId); }
      const panel = $("#panel");
      if (panel && !panel.classList.contains("collapsed")) back.style.paddingRight = panel.offsetWidth + "px";
    }
  }

  async function downloadDoc(doc) {
    const base = (doc.title || "record").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "record";
    if (doc.kind === "text") { downloadFile(base + ".txt", doc.content || "", "text/plain"); return; }
    const a = document.createElement("a");
    a.href = await docSrcAsync(doc);
    a.download = base + (doc.kind === "pdf" ? ".pdf" : "");
    a.click();
  }

  /* ================================================= read-only profile card (mobile) */
  const isMobileView = () => !!(window.matchMedia && window.matchMedia("(max-width: 720px)").matches);
  // The "owner" is a device holding the import passcode (the secret only used to
  // save the tree). Private notes are shown/edited only for the owner.
  const isOwner = () => { try { return !!(localStorage.getItem("familyTree.importPass") || "").trim(); } catch (e) { return false; } };
  // Editing anywhere needs the site's import passcode saved in THIS browser —
  // on the computer it's typed into "Save & back up", but a phone had no way in,
  // so every profile stayed read-only. This asks for it, checks it against the
  // server, and remembers it here.
  async function enableEditingHere(after) {
    const pass = (prompt("Enter the import passcode to edit on this device (the IMPORT_PASSCODE set on your site):") || "").trim();
    if (!pass) return false;
    try {
      const r = await fetch("api/store", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "checkPasscode", passcode: pass }) });
      if (r.status === 401) { toast("That passcode isn't right — nothing was changed."); return false; }
      if (!r.ok) { toast("Couldn't reach the site to check that passcode. Try again when you're online."); return false; }
    } catch (e) { toast("Couldn't reach the site to check that passcode. Try again when you're online."); return false; }
    try { localStorage.setItem("familyTree.importPass", pass); } catch (e) {}
    toast("✎ Editing is on for this device");
    render(); if (after) after();
    return true;
  }
  // HEIC/HEIF (iPhone) photos: browsers can't display them, so they're
  // converted to JPEG in the browser first. The converter (vendored
  // heic2any, ~1.3MB) loads on demand — only the first time a HEIC file is
  // actually picked — and never on normal page loads.
  let heicLibP = null;
  // Page one of a PDF, rendered as an image — so a scanned portrait or a
  // photo someone saved as a PDF can be used exactly like a JPG. The reader is
  // fetched only when a PDF actually turns up.
  let pdfLibP = null;
  function loadPdfLib() {
    if (window.pdfjsLib) return Promise.resolve();
    if (!pdfLibP) pdfLibP = new Promise((resolve, reject) => {
      const sc = document.createElement("script");
      sc.src = "pdf.min.js?v=" + (window.FAMILY_DATA_VERSION || Date.now());
      sc.onload = resolve;
      sc.onerror = () => { pdfLibP = null; reject(new Error("PDF reader failed to load")); };
      document.head.appendChild(sc);
    });
    return pdfLibP;
  }
  const isPdfFile = (f) => !!f && (f.type === "application/pdf" || /\.pdf$/i.test(f.name || ""));
  const isPdfData = (u) => typeof u === "string" && /^data:application\/pdf[;,]/i.test(u);
  // Render the first page big enough to crop from (long edge ~1400px).
  async function pdfFirstPageImage(src) {
    await loadPdfLib();
    const lib = window.pdfjsLib;
    try { lib.GlobalWorkerOptions.workerSrc = "pdf.worker.min.js?v=" + (window.FAMILY_DATA_VERSION || ""); } catch (e) {}
    const data = typeof src === "string" ? unb64(String(src).split(",")[1] || "") : new Uint8Array(src);
    const doc = await lib.getDocument({ data }).promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, Math.max(1, 1400 / Math.max(base.width, base.height)));
    const vp = page.getViewport({ scale });
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(vp.width)); cv.height = Math.max(1, Math.round(vp.height));
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);   // PDFs are transparent; paper is white
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    try { doc.destroy(); } catch (e) {}
    return cv.toDataURL("image/jpeg", 0.85);
  }
  // Any picked file as a picture: a PDF becomes its first page, an iPhone HEIC
  // is converted, everything else is read as-is.
  async function fileAsPictureDataUrl(file) {
    if (isPdfFile(file)) {
      toast("Reading that PDF…");
      const buf = await file.arrayBuffer();
      return await pdfFirstPageImage(buf);
    }
    const f = await normalizeImageFile(file);
    return await readFileDataURL(f);
  }
  function loadHeicLib() {
    if (window.heic2any) return Promise.resolve();
    if (!heicLibP) heicLibP = new Promise((resolve, reject) => {
      const sc = document.createElement("script");
      sc.src = "heic2any.min.js?v=" + (window.FAMILY_DATA_VERSION || Date.now());
      sc.onload = resolve;
      sc.onerror = () => { heicLibP = null; reject(new Error("converter failed to load")); };
      document.head.appendChild(sc);
    });
    return heicLibP;
  }
  const isHeicFile = (file) => !!file && (/heic|heif/i.test(file.type || "") || /\.(heic|heif)$/i.test(file.name || ""));
  async function normalizeImageFile(file) {
    if (!isHeicFile(file)) return file;
    toast("Converting iPhone photo (HEIC)…");
    await loadHeicLib();
    const out = await window.heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
    const blob = Array.isArray(out) ? out[0] : out;
    return new File([blob], (file.name || "photo").replace(/\.(heic|heif)$/i, "") + ".jpg", { type: "image/jpeg" });
  }
  function readFileDataURL(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file); }); }

  /* ---------------- extra photos: as many per person as you like -------- */
  // The tree picture stays p.photo/p.photoRef; everything else lives in
  // p.gallery as media refs (embedded data only while offline, until the sweep
  // externalises it). Shared by the computer panel and the phone card.
  const galleryOf = (p) => (Array.isArray(p.gallery) ? p.gallery : []);
  async function galleryAdd(p, files) {
    const list = [...files].slice(0, 20);
    if (!list.length) return 0;
    let added = 0;
    for (let f of list) {
      const full = await fileAsFullImage(f);
      if (!full) continue;
      if (!Array.isArray(p.gallery)) p.gallery = [];
      try { p.gallery.push({ ref: await mediaUpload(full) }); }
      catch (e) { p.gallery.push({ data: full }); }   // offline: keep it here for now
      added++;
    }
    if (added) { save(); try { cloudSaveTree(false); } catch (e) {} scheduleSweep(); }
    return added;
  }
  const galleryPicSrc = (g) => (g.data || (g.ref && mediaMem.get(g.ref)) || null);
  // A strip of thumbnails: tap to enlarge, ★ to make it the tree picture, ✕ to remove.
  function renderGallery(host, p, onChange) {
    host.textContent = "";
    const gal = galleryOf(p);
    if (!gal.length) return;
    const strip = document.createElement("div"); strip.className = "gal-strip";
    gal.forEach((g, i) => {
      const cell = document.createElement("div"); cell.className = "gal-cell";
      const img = document.createElement("img");
      const src = galleryPicSrc(g);
      if (src) img.src = src;
      else if (g.ref) mediaGet(g.ref).then((u) => { if (u && img.isConnected) img.src = u; }).catch(() => {});
      img.alt = "Photo " + (i + 1);
      img.onclick = () => openPhotoLightbox(p, i);
      cell.appendChild(img);
      if (!readonly && isOwner()) {
        const star = document.createElement("button"); star.type = "button"; star.className = "gal-act gal-star"; star.textContent = "★";
        star.title = "Make this their tree picture";
        star.onclick = async (ev) => {
          ev.stopPropagation();
          const full = galleryPicSrc(g) || (g.ref ? await mediaGet(g.ref).catch(() => null) : null);
          if (!full) return toast("That photo is still loading");
          openPhotoAdjust(full, async (sq) => {
            const kept = await setTreePicture(p, sq, g.ref ? null : full, g.ref || null, true);
            toast(kept ? "Tree picture updated — the old one is in their gallery" : "Tree picture updated"); if (onChange) onChange();
          });
        };
        const del = document.createElement("button"); del.type = "button"; del.className = "gal-act gal-del"; del.textContent = "✕";
        del.title = "Remove this photo";
        del.onclick = (ev) => {
          ev.stopPropagation();
          if (!confirm("Remove this photo?")) return;
          pushUndo();
          p.gallery = galleryOf(p).filter((x) => x !== g);
          save(); try { cloudSaveTree(false); } catch (e) {}
          toast("Photo removed"); if (onChange) onChange();
        };
        cell.appendChild(star); cell.appendChild(del);
      }
      strip.appendChild(cell);
    });
    host.appendChild(strip);
  }
  // Full-size viewer with next/previous.
  function openPhotoLightbox(p, idx) {
    const gal = galleryOf(p); if (!gal.length) return;
    let i = Math.max(0, Math.min(idx, gal.length - 1));
    const back = document.createElement("div"); back.className = "lightbox-back";
    const img = document.createElement("img"); img.className = "lightbox-img";
    const cap = document.createElement("div"); cap.className = "lightbox-cap";
    const show = async () => {
      const g = gal[i];
      const src = galleryPicSrc(g) || (g.ref ? await mediaGet(g.ref).catch(() => null) : null);
      img.src = src || "";
      cap.textContent = (p.name || "") + "  ·  " + (i + 1) + " of " + gal.length;
    };
    const nav = (d) => { i = (i + d + gal.length) % gal.length; show(); };
    back.appendChild(img); back.appendChild(cap);
    if (gal.length > 1) {
      const prev = document.createElement("button"); prev.className = "lightbox-nav prev"; prev.textContent = "‹";
      const next = document.createElement("button"); next.className = "lightbox-nav next"; next.textContent = "›";
      prev.onclick = (e) => { e.stopPropagation(); nav(-1); };
      next.onclick = (e) => { e.stopPropagation(); nav(1); };
      back.appendChild(prev); back.appendChild(next);
    }
    back.onclick = () => back.remove();
    document.body.appendChild(back);
    show();
  }

  /* ------------- the tree picture: one place to change it -------------- */
  // Tapping someone's picture on their profile opens this menu, so it is never
  // ambiguous which control changes the picture on the tree and which one just
  // adds to their gallery. Every route through it ends in the same crop/zoom
  // editor the computer uses, so a phone can position a photo just as well.
  const hasTreePic = (p) => !!(p.photo || p.photoRef);
  // Read a picked file into a full-size (downscaled) image, converting HEIC.
  async function fileAsFullImage(file) {
    let dataUrl = null;
    try { dataUrl = await fileAsPictureDataUrl(file); }
    catch (e) { toast(isPdfFile(file) ? "Couldn’t read that PDF — try saving the page as a JPG." : "Couldn’t convert that iPhone photo — try a JPG."); return null; }
    let full = null;
    try {
      full = await new Promise((res) => { const im = new Image(); im.onload = () => { try { res(downscale(im, 1400)); } catch (e) { res(null); } }; im.onerror = () => res(null); im.src = dataUrl; });
    } catch (e) {}
    if (!full) toast("Couldn’t read that image");
    return full;
  }
  // The best image to (re-)crop from: the full-size original kept when the
  // picture was set, else the square itself — still enough to nudge or zoom in.
  async function photoSourceFor(p) {
    if (p.photoSrcRef) { const u = await mediaGet(p.photoSrcRef).catch(() => null); if (u) return u; }
    if (p.photo) return p.photo;
    if (p.photoRef) return await mediaGet(p.photoRef).catch(() => null);
    return null;
  }
  // Save a freshly cropped square as the tree picture, keeping a reference to
  // the full-size original so it can be repositioned again later without the
  // quality loss of re-cropping a crop.
  // The picture being replaced isn't thrown away — it joins their gallery, so a
  // face that was once on the tree is always still there to go back to. The
  // full-size original is kept in preference to the square crop, and a photo the
  // gallery already holds isn't added twice.
  function archiveTreePicture(p) {
    const ref = p.photoSrcRef || p.photoRef || null;
    const data = ref ? null : (p.photo || null);
    if (!ref && !data) return false;
    const gal = galleryOf(p);
    if (ref && gal.some((g) => g && g.ref === ref)) return false;
    if (data && gal.some((g) => g && g.data === data)) return false;
    // …and the same picture filed under a different id doesn't count as new
    // either, when both are already in hand (no fetching just to compare).
    const mine = ref ? mediaMem.get(ref) : data;
    if (mine && gal.some((g) => g && (g.data || (g.ref && mediaMem.get(g.ref))) === mine)) return false;
    if (!Array.isArray(p.gallery)) p.gallery = [];
    p.gallery.push(ref ? { ref } : { data });
    return true;
  }
  // keepPrevious: true when this is a DIFFERENT picture taking over, false when
  // it's the same one being re-framed (which would only fill the gallery with
  // near-identical crops).
  async function setTreePicture(p, square, full, fullRef, keepPrevious) {
    pushUndo();
    const kept = keepPrevious ? archiveTreePicture(p) : false;
    try { p.photoRef = await mediaUpload(square); delete p.photo; }
    catch (e) { p.photo = square; delete p.photoRef; }   // offline: the sweep externalises it later
    delete p.photoSrcRef;
    if (fullRef) p.photoSrcRef = fullRef;
    else if (full) { try { p.photoSrcRef = await mediaUpload(full); } catch (e) {} }
    p.photoMobile = true;
    save(); try { cloudSaveTree(false); } catch (e) {}
    scheduleSweep(); render();
    return kept;
  }
  function openPhotoMenu(p, onChange) {
    if (readonly || !isOwner()) return;
    const back = document.createElement("div"); back.className = "modal-backdrop";
    const m = document.createElement("div"); m.className = "modal photo-menu";
    const h = document.createElement("h2"); h.textContent = "Profile picture"; m.appendChild(h);
    const hint = document.createElement("div"); hint.className = "hint";
    hint.textContent = "This is the picture that shows on the tree. You can also paste a picture (⌘V) or drop one here.";
    m.appendChild(hint);
    let close = () => back.remove();
    const after = (msg) => { toast(msg); if (onChange) onChange(); };
    const opt = (label, fn, cls) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "btn wide" + (cls ? " " + cls : "");
      b.textContent = label; b.onclick = fn; m.appendChild(b); return b;
    };
    const has = hasTreePic(p), gal = galleryOf(p);
    // Paste a link and go — this is how most pictures arrive, so it's the first
    // thing here rather than something behind another button.
    const linkRow = document.createElement("div"); linkRow.className = "pm-linkrow";
    const linkIn = document.createElement("input"); linkIn.type = "text"; linkIn.id = "pmPhotoUrl";
    linkIn.placeholder = "Paste a photo link — or the picture itself"; linkIn.autocomplete = "off"; linkIn.spellcheck = false;
    const linkGo = document.createElement("button"); linkGo.type = "button"; linkGo.className = "btn primary"; linkGo.textContent = "Fetch";
    const runLink = () => {
      const url = (linkIn.value || "").trim();
      if (!url) { toast("Paste a link first"); linkIn.focus(); return; }
      close();
      fetchPhotoFromLink(p, url, onChange);
    };
    linkGo.onclick = runLink;
    linkIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runLink(); } });
    linkRow.appendChild(linkIn); linkRow.appendChild(linkGo);
    m.appendChild(linkRow);
    if (has) opt("🔍 Reposition this picture", async () => {
      close();
      const src = await photoSourceFor(p);
      if (!src) return toast("That picture is still loading — try again in a moment");
      openPhotoAdjust(src, async (sq) => { await setTreePicture(p, sq, null, p.photoSrcRef || null, false); after("Picture repositioned"); });
    });
    if (gal.length) opt("🖼 Choose from their photos", () => { close(); openGalleryPick(p, onChange); });
    const fileInput = document.createElement("input"); fileInput.type = "file"; fileInput.accept = "image/*,.heic,.heif,application/pdf,.pdf"; fileInput.style.display = "none";
    fileInput.onchange = async () => {
      const file = fileInput.files[0]; if (!file) return;
      close();
      const full = await fileAsFullImage(file); if (!full) return;
      openPhotoAdjust(full, async (sq) => { const kept = await setTreePicture(p, sq, full, null, true); after(kept ? "Picture updated — the old one is in their gallery" : "Picture updated"); });
    };
    m.appendChild(fileInput);
    opt(has ? "📷 Upload a new picture" : "📷 Upload a picture", () => fileInput.click());
    if (has) opt("🗑 Remove this picture", () => {
      if (!confirm("Remove their tree picture? Any photos in their gallery stay.")) return;
      close(); pushUndo();
      delete p.photo; delete p.photoRef; delete p.photoSrcRef; delete p.photoMobile;
      save(); try { cloudSaveTree(false); } catch (e) {}
      render(); after("Picture removed");
    }, "danger");
    const row = document.createElement("div"); row.className = "btn-row";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn"; cancel.textContent = "Cancel";
    cancel.onclick = close; row.appendChild(cancel); m.appendChild(row);
    // Paste or drop the picture itself. This is the way in for photos whose
    // link the site can't follow — a Facebook one, say, whose address only
    // exists on the network it was copied from. The browser already has the
    // pixels; nothing has to be fetched.
    const useFile = async (file) => {
      if (!file) return;
      close();
      const full = await fileAsFullImage(file); if (!full) return;
      openPhotoAdjust(full, async (sq) => {
        const kept = await setTreePicture(p, sq, full, null, true);
        toast(kept ? "Picture updated — the old one is in their gallery" : "Picture updated");
        if (onChange) onChange();
      });
    };
    const onPaste = (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const it of items) {
        if (it.type && it.type.indexOf("image/") === 0) { e.preventDefault(); useFile(it.getAsFile()); return; }
      }
    };
    document.addEventListener("paste", onPaste);
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    m.addEventListener("dragover", (e) => { stop(e); m.classList.add("dropping"); });
    m.addEventListener("dragleave", () => m.classList.remove("dropping"));
    m.addEventListener("drop", (e) => {
      stop(e); m.classList.remove("dropping");
      const dt = e.dataTransfer;
      const f = dt && dt.files && dt.files[0];
      if (f) return useFile(f);
      const u = dt && (dt.getData("text/uri-list") || dt.getData("text/plain"));
      if (u) { close(); fetchPhotoFromLink(p, u.trim(), onChange); }
    });
    const closeAll = close;
    close = () => { document.removeEventListener("paste", onPaste); closeAll(); };
    back.appendChild(m); document.body.appendChild(back);
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    if (!has) setTimeout(() => { try { linkIn.focus(); } catch (e) {} }, 0);
    return back;
  }
  // A photo from a link — the fetch runs on the site, so it works on pictures
  // the browser itself couldn't read. Ends in the same crop editor as every
  // other route, and the picture it replaces is kept in their gallery.
  // Some picture links only work from the network they were copied on —
  // Facebook's are served by a cache box inside your own ISP, so its address
  // doesn't exist anywhere else and no amount of fetching will find it.
  const linkIsLocalOnly = (url) => /(^|\.)fbcdn\.net|scontent[.-]/i.test(String(url));
  async function fetchPhotoFromLink(p, url, onChange) {
    // Whatever goes wrong with a link, the answer is the same and the box is
    // reopened ready for it: copy the picture itself and paste it in.
    const askForPaste = (why) => {
      toast(why + " — right-click the photo → Copy image, then paste it here (⌘V / Ctrl-V).");
      openPhotoMenu(p, onChange);
    };
    if (linkIsLocalOnly(url)) { askForPaste("That Facebook link only works on the device it was copied from"); return; }
    let pass = ""; try { pass = localStorage.getItem("familyTree.importPass") || ""; } catch (e) {}
    if (!pass) pass = prompt("One-time import passcode (set as IMPORT_PASSCODE on the Vercel site):") || "";
    if (!pass) return;
    try { localStorage.setItem("familyTree.importPass", pass); } catch (e) {}
    toast("Fetching the photo…");
    try {
      const data = await callArchive({ passcode: pass, url });
      if (!data || !data.image) return askForPaste("No picture at that link");
      openPhotoAdjust(data.image, async (sq) => {
        const kept = await setTreePicture(p, sq, data.image, null, true);
        toast(kept ? "Picture updated — the old one is in their gallery" : "Picture updated");
        if (onChange) onChange();
      });
    } catch (e) { askForPaste(e.message || "Couldn’t fetch that link"); }
  }
  // Pick one of their gallery photos to become the tree picture, then crop it.
  function openGalleryPick(p, onChange) {
    const gal = galleryOf(p); if (!gal.length) return null;
    const back = document.createElement("div"); back.className = "modal-backdrop";
    const m = document.createElement("div"); m.className = "modal";
    const h = document.createElement("h2"); h.textContent = "Choose a picture"; m.appendChild(h);
    const hint = document.createElement("div"); hint.className = "hint"; hint.textContent = "Tap a photo, then position it."; m.appendChild(hint);
    const grid = document.createElement("div"); grid.className = "pick-grid";
    gal.forEach((g, i) => {
      const cell = document.createElement("button"); cell.type = "button"; cell.className = "pick-cell";
      const img = document.createElement("img"); img.alt = "Photo " + (i + 1);
      const src = galleryPicSrc(g);
      if (src) img.src = src;
      else if (g.ref) mediaGet(g.ref).then((u) => { if (u && img.isConnected) img.src = u; }).catch(() => {});
      cell.appendChild(img);
      cell.onclick = async () => {
        const full = galleryPicSrc(g) || (g.ref ? await mediaGet(g.ref).catch(() => null) : null);
        if (!full) return toast("That photo is still loading");
        back.remove();
        openPhotoAdjust(full, async (sq) => {
          const kept = await setTreePicture(p, sq, g.ref ? null : full, g.ref || null, true);
          toast(kept ? "Picture updated — the old one is in their gallery" : "Picture updated"); if (onChange) onChange();
        });
      };
      grid.appendChild(cell);
    });
    m.appendChild(grid);
    const row = document.createElement("div"); row.className = "btn-row";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn"; cancel.textContent = "Cancel";
    cancel.onclick = () => back.remove(); row.appendChild(cancel); m.appendChild(row);
    back.appendChild(m); document.body.appendChild(back);
    back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
    return back;
  }

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
    const ph0 = photoOf(p);
    const placeholder = () => { const q = document.createElement("span"); q.className = "pcard-ph"; q.textContent = "👤"; av.appendChild(q); return q; };
    if (ph0) { const img = document.createElement("img"); img.src = ph0; av.appendChild(img); }
    else if (p.photoRef) {
      const q = placeholder();
      mediaGet(p.photoRef).then((u) => { if (u && av.isConnected) { q.remove(); const img = document.createElement("img"); img.src = u; av.insertBefore(img, av.firstChild); } }).catch(() => {});
    } else placeholder();
    if (isDeceased(p)) av.classList.add("deceased");
    // Their picture is the control for their picture: tapping it offers
    // reposition / choose from their photos / upload / remove, so the only
    // upload button left on the card is the gallery one.
    if (isOwner() && !readonly) {
      av.classList.add("tappable");
      av.setAttribute("role", "button");
      av.setAttribute("tabindex", "0");
      av.title = hasTreePic(p) ? "Change or reposition their picture" : "Add their picture";
      const cam = document.createElement("span"); cam.className = "pcard-photo-cam"; cam.textContent = "📷"; av.appendChild(cam);
      const openIt = () => openPhotoMenu(p, () => { closeProfileCard(); openProfileCard(id); });
      av.onclick = openIt;
      av.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openIt(); } };
    }
    head.appendChild(av);
    const hbox = document.createElement("div"); hbox.className = "pcard-headtext";
    const h = document.createElement("h2"); h.textContent = p.name || "Unnamed"; hbox.appendChild(h);
    const dline = personDatesLine(p); if (dline) { const d = document.createElement("div"); d.className = "pcard-dates"; d.textContent = dline; hbox.appendChild(d); }
    if (servedInMilitary(p)) {
      const m = document.createElement("div"); m.className = "pcard-dates mil-line";
      m.textContent = "★ " + (militaryLine(p) || "Served in the military");
      hbox.appendChild(m);
    }
    head.appendChild(hbox);
    const x = document.createElement("button"); x.className = "pcard-x"; x.setAttribute("aria-label", "Close"); x.textContent = "✕"; x.onclick = closeProfileCard; head.appendChild(x);
    card.appendChild(head);
    const body = document.createElement("div"); body.className = "pcard-body"; card.appendChild(body);
    const section = (title, cls) => { const s = document.createElement("div"); s.className = "pcard-section" + (cls ? " " + cls : ""); if (title) { const t = document.createElement("h3"); t.textContent = title; s.appendChild(t); } body.appendChild(s); return s; };
    // This device hasn't been given the passcode yet: everything below is
    // read-only, so offer the one action that changes that.
    if (!isOwner() && !readonly) {
      const s0 = section("Editing");
      const note = document.createElement("div"); note.className = "pcard-subhint";
      note.textContent = "This device can view the tree but not change it yet.";
      s0.appendChild(note);
      const b = document.createElement("button"); b.className = "btn small"; b.textContent = "✎ Turn on editing on this device";
      b.onclick = () => enableEditingHere(() => { closeProfileCard(); openProfileCard(id); });
      s0.appendChild(b);
    }
    // Photos — the gallery, and only the gallery. Their tree picture is changed
    // by tapping the picture at the top of the card, so there is exactly one
    // upload button here and no doubt about what it does.
    if (isOwner()) {
      const s = section("Photos", "pcard-photo-sec");
      const hint = document.createElement("div"); hint.className = "pcard-subhint";
      hint.textContent = "Tap their picture at the top to reposition, change or remove it.";
      s.appendChild(hint);
      const galInput = document.createElement("input"); galInput.type = "file"; galInput.accept = "image/*,.heic,.heif,application/pdf,.pdf"; galInput.multiple = true; galInput.style.display = "none";
      galInput.onchange = async () => {
        const n = await galleryAdd(p, galInput.files); galInput.value = "";
        closeProfileCard(); openProfileCard(id);
        if (n) toast(n === 1 ? "Photo added" : n + " photos added");
      };
      const add = document.createElement("button"); add.className = "btn small"; add.textContent = "🖼 Add pictures to gallery";
      add.onclick = () => galInput.click();
      s.appendChild(add); s.appendChild(galInput);
      const galHost = document.createElement("div");
      renderGallery(galHost, p, () => { closeProfileCard(); openProfileCard(id); });
      s.appendChild(galHost);
    }
    // Details — birth/death dates and records, view-only until the owner
    // explicitly taps Edit (so nothing gets changed by a stray touch). Adding
    // NEW people stays desktop-only on purpose.
    if (isOwner()) {
      const s = section("Details", "pcard-details");
      const view = document.createElement("div");
      const line = (label, val) => { const d = document.createElement("div"); d.className = "pcard-detline"; d.innerHTML = "<b>" + label + ":</b> "; d.appendChild(document.createTextNode(val)); view.appendChild(d); };
      const fmt = (exact, year) => exact ? new Date(exact + "T12:00:00").toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : (year != null ? String(year) : "—");
      line("Born", fmt(p.birthDate, p.birth));
      line(isDeceased(p) ? "Died" : "Status", isDeceased(p) ? fmt(p.deathDate, p.death) : "Living");
      { const a = ageLabel(p); if (a) line(isDeceased(p) ? "Age at death" : "Age", a); }
      if (isDeceased(p) && p.causeOfDeath) line("Cause of death", p.causeOfDeath);
      if (servedInMilitary(p)) {
        const m = p.military;
        line("Military service", militaryLine(p) || "Served");
        if (m.notes) line("Service notes", m.notes);
      }
      s.appendChild(view);
      const bar = document.createElement("div"); bar.className = "pcard-notes-bar";
      const editBtn = document.createElement("button"); editBtn.className = "btn small"; editBtn.textContent = "✏️ Edit name & details";
      const attachBtn = document.createElement("button"); attachBtn.className = "btn small"; attachBtn.textContent = "📄 Add obituary / record";
      attachBtn.onclick = () => openAttachModal(id, () => { closeProfileCard(); openProfileCard(id); });
      bar.appendChild(editBtn); bar.appendChild(attachBtn); s.appendChild(bar);
      editBtn.onclick = () => {
        bar.hidden = true; view.hidden = true;
        const f = document.createElement("div"); f.className = "pcard-editform";
        const field = (label, input) => { const w = document.createElement("label"); w.className = "pcard-field"; const t = document.createElement("span"); t.textContent = label; w.appendChild(t); w.appendChild(input); f.appendChild(w); return input; };
        const num = (v) => { const i = document.createElement("input"); i.type = "number"; i.value = v == null ? "" : v; return i; };
        const date = (v) => { const i = document.createElement("input"); i.type = "date"; i.value = v || ""; return i; };
        const txt2 = (v) => { const i = document.createElement("input"); i.type = "text"; i.value = v || ""; return i; };
        const np0 = (p.first !== undefined || p.last !== undefined) ? p : parseName(p.name || "");
        const fFirst = field("First name", txt2(np0.first));
        const fMiddle = field("Middle name", txt2(np0.middle));
        const fLast = field("Last name", txt2(np0.last));
        const fNick = field("Nickname", txt2(np0.nickname));
        const fMaiden = field("Maiden name", txt2(np0.maiden));
        const fSuffix = field("Suffix (Jr., III…)", txt2(np0.suffix));
        const bYear = field("Born (year)", num(p.birth));
        const bDate = field("Exact birth date (optional)", date(p.birthDate));
        const dYear = field("Died (year, if applicable)", num(p.death));
        const dDate = field("Exact death date (optional)", date(p.deathDate));
        const dec = document.createElement("input"); dec.type = "checkbox"; dec.checked = isDeceased(p);
        const decWrap = document.createElement("label"); decWrap.className = "pcard-check"; decWrap.appendChild(dec); decWrap.appendChild(document.createTextNode(" Has passed away"));
        f.appendChild(decWrap);
        const causeI = document.createElement("input"); causeI.type = "text"; causeI.value = p.causeOfDeath || ""; causeI.placeholder = "e.g. heart failure";
        const causeW = document.createElement("label"); causeW.className = "pcard-field"; causeW.hidden = !isDeceased(p);
        const causeT = document.createElement("span"); causeT.textContent = "Cause of death (optional)";
        causeW.appendChild(causeT); causeW.appendChild(causeI); f.appendChild(causeW);
        const syncCause = () => { causeW.hidden = !(dec.checked || dYear.value || dDate.value); };
        dec.addEventListener("change", syncCause); dYear.addEventListener("input", syncCause); dDate.addEventListener("change", syncCause);
        // military service — the tick reveals branch, rank and notes
        const mil = document.createElement("input"); mil.type = "checkbox"; mil.checked = servedInMilitary(p);
        const milWrap = document.createElement("label"); milWrap.className = "pcard-check"; milWrap.appendChild(mil); milWrap.appendChild(document.createTextNode(" Served in the military"));
        f.appendChild(milWrap);
        const milBox = document.createElement("div"); milBox.hidden = !mil.checked;
        const milField = (label, node) => { const w = document.createElement("label"); w.className = "pcard-field"; const t = document.createElement("span"); t.textContent = label; w.appendChild(t); w.appendChild(node); milBox.appendChild(w); return node; };
        const mBranch = milField("Branch", txt2((p.military || {}).branch));
        const mRank = milField("Rank", txt2((p.military || {}).rank));
        const mNotesI = document.createElement("textarea"); mNotesI.rows = 2; mNotesI.value = (p.military || {}).notes || "";
        const mNotes = milField("Service notes (optional)", mNotesI);
        f.appendChild(milBox);
        mil.addEventListener("change", () => { milBox.hidden = !mil.checked; });
        const btns = document.createElement("div"); btns.className = "pcard-notes-bar";
        const cancel = document.createElement("button"); cancel.className = "btn small"; cancel.textContent = "Cancel";
        const saveB = document.createElement("button"); saveB.className = "btn primary small"; saveB.textContent = "Save details";
        btns.appendChild(cancel); btns.appendChild(saveB); f.appendChild(btns);
        s.appendChild(f);
        cancel.onclick = () => { f.remove(); bar.hidden = false; view.hidden = false; };
        saveB.onclick = () => {
          const birthDate = bDate.value || null, deathDate = dDate.value || null;
          // Exactly like the desktop editor: a full date wins over the year box.
          const by = birthDate ? parseInt(birthDate.slice(0, 4), 10) : (bYear.value ? parseInt(bYear.value, 10) : null);
          const dy = deathDate ? parseInt(deathDate.slice(0, 4), 10) : (dYear.value ? parseInt(dYear.value, 10) : null);
          p.birth = isNaN(by) ? null : by; p.birthDate = birthDate;
          p.death = isNaN(dy) ? null : dy; p.deathDate = deathDate;
          p.deceased = !!(dec.checked || dy || deathDate);
          if (causeI.value.trim() && isDeceased(p)) p.causeOfDeath = causeI.value.trim(); else delete p.causeOfDeath;
          if (mil.checked) p.military = { branch: mBranch.value.trim(), rank: mRank.value.trim(), notes: mNotes.value.trim() };
          else delete p.military;
          const np = nameParts({ first: fFirst.value.trim(), middle: fMiddle.value.trim(), last: fLast.value.trim(),
            nickname: fNick.value.trim(), maiden: p.sex === "female" ? fMaiden.value.trim() : "", suffix: fSuffix.value.trim() });
          if (np.first || np.last) Object.assign(p, { name: np.name, first: np.first, middle: np.middle, last: np.last, nickname: np.nickname, maiden: np.maiden, suffix: np.suffix });
          save(); try { cloudSaveTree(false); } catch (e) {}
          render(); closeProfileCard(); openProfileCard(id); toast("Details saved");
        };
      };
    }
    // Everywhere they're drawn. A duplicate can be taken off from here — which
    // is the only route on a phone, where there's no right-click.
    {
      const spots = copySpots[id] || [];
      if (spots.length) {
        const s = section("Appears in");
        const note = document.createElement("div"); note.className = "pcard-subhint";
        note.textContent = "They're drawn in " + (spots.length + 1) + " places. Removing a copy leaves them on the tree.";
        s.appendChild(note);
        const row = (label, uid) => {
          const r = document.createElement("div"); r.className = "pcard-rel";
          const nm = document.createElement("button"); nm.className = "pcard-relname"; nm.textContent = "⤴ " + label;
          nm.onclick = () => {
            const q = uid ? ((copySpots[id] || []).find((c) => c.uid === uid) || null) : posOf(id);
            closeProfileCard(); if (q) centerAt(q.x, q.y);
          };
          r.appendChild(nm);
          if (uid && isOwner() && !readonly && removableCopy(uid + ":" + id)) {
            const anchor = copyAnchorOf(id, uid);
            const who = anchor === id ? null : ((personById(anchor) || {}).first || (personById(anchor) || {}).name || "");
            const rm = document.createElement("button"); rm.className = "btn small danger"; rm.textContent = "Remove copy";
            rm.onclick = () => {
              const msg = who
                ? "This copy is part of " + who + "'s repeat on this branch. Removing it takes that whole repeat off — everyone stays on the tree."
                : "Remove this copy? " + (p.name || "They") + " stays on the tree — they'll just be drawn in one place.";
              if (!confirm(msg)) return;
              const n = removeCopies([uid + ":" + id]);
              closeProfileCard();
              toast(n ? "Copy removed — they're drawn in one place now" : "That copy can't be removed here");
            };
            r.appendChild(rm);
          }
          s.appendChild(r);
        };
        row("Their main spot", null);
        spots.forEach((c) => row(familyNameOfUnion(c.uid) || "another branch", c.uid));
      }
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
        const v = document.createElement("button"); v.className = "btn small"; v.textContent = "View"; v.onclick = () => openDocViewer(doc, id);
        row.appendChild(t); row.appendChild(v); s.appendChild(row);
      });
    }
    // Notes — private to the owner. Read-only until Edit is tapped, so a stray
    // touch can never change (or wipe) a saved note.
    if (isOwner()) {
      const s = section("Notes", "pcard-notes");
      const hint = document.createElement("div"); hint.className = "pcard-subhint"; hint.textContent = "Private — only you can see these."; s.appendChild(hint);
      const view = document.createElement("div"); view.className = "pcard-notes-view";
      const renderView = () => { view.textContent = p.notes || ""; view.classList.toggle("empty", !p.notes); if (!p.notes) view.textContent = "No notes yet."; };
      renderView(); s.appendChild(view);
      const bar = document.createElement("div"); bar.className = "pcard-notes-bar";
      const savedMsg = document.createElement("span"); savedMsg.className = "pcard-saved";
      const editBtn = document.createElement("button"); editBtn.className = "btn small"; editBtn.textContent = "✏️ Edit notes";
      bar.appendChild(savedMsg); bar.appendChild(editBtn); s.appendChild(bar);
      editBtn.onclick = () => {
        bar.hidden = true; view.hidden = true;
        const ta = document.createElement("textarea"); ta.className = "pcard-notes-input"; ta.rows = 4; ta.placeholder = "Add a private note about " + (p.first || p.name || "them") + "…"; ta.value = p.notes || "";
        const ebar = document.createElement("div"); ebar.className = "pcard-notes-bar";
        const cancel = document.createElement("button"); cancel.className = "btn small"; cancel.textContent = "Cancel";
        const saveBtn = document.createElement("button"); saveBtn.className = "btn primary small"; saveBtn.textContent = "Save notes";
        ebar.appendChild(cancel); ebar.appendChild(saveBtn);
        s.appendChild(ta); s.appendChild(ebar);
        const done = () => { ta.remove(); ebar.remove(); bar.hidden = false; view.hidden = false; renderView(); };
        cancel.onclick = done;
        saveBtn.onclick = () => {
          const v = ta.value.trim(); if (v) p.notes = v; else delete p.notes;
          save(); try { cloudSaveTree(false); } catch (e) {}   // push so the note syncs to your other devices
          done();
          savedMsg.textContent = "Saved ✓"; setTimeout(() => { savedMsg.textContent = ""; }, 2500);
        };
      };
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
    return { title: state.title, subtitle: state.subtitle, persons: state.persons, unions: state.unions, links: state.links, manual: state.manual, manualHidden: state.manualHidden || {}, hidden: state.hidden, focus: state.focus, version: state.version || 0, photoMigrated: !!state.photoMigrated, namesSplit: !!state.namesSplit, viewModesV2: !!state.viewModesV2, picRelink1: !!state.picRelink1, obitPicFix1: !!state.obitPicFix1, views: state.views || [], mediaKey: state.mediaKey || null, groups: state.groups || [], locked: state.locked || {}, portals: state.portals || {}, echoPos: state.echoPos || {}, busOff: state.busOff || {}, removed: state.removed || {} };
  }
  function loadObject(obj) {
    state = Object.assign(blankState(), {
      title: obj.title || "Family Tree", subtitle: obj.subtitle || "",
      persons: obj.persons || [], unions: obj.unions || [], links: obj.links || [], manual: obj.manual || {}, manualHidden: obj.manualHidden || {}, hidden: obj.hidden || {},
      focus: Array.isArray(obj.focus) ? obj.focus : [], version: obj.version || 0,
      photoMigrated: !!obj.photoMigrated,
      namesSplit: !!obj.namesSplit,
      viewModesV2: !!obj.viewModesV2,
      picRelink1: !!obj.picRelink1,
      obitPicFix1: !!obj.obitPicFix1,
      views: Array.isArray(obj.views) ? obj.views : [],
      mediaKey: obj.mediaKey || null,
      groups: Array.isArray(obj.groups) ? obj.groups : [],
      locked: obj.locked && typeof obj.locked === "object" ? obj.locked : {},
      portals: obj.portals && typeof obj.portals === "object" ? obj.portals : {},
      echoPos: obj.echoPos && typeof obj.echoPos === "object" ? obj.echoPos : {},
      busOff: obj.busOff && typeof obj.busOff === "object" ? obj.busOff : {},
      // deletions are remembered for a season, then forgotten — long enough for
      // every device to have heard about them
      removed: (() => { const r = {}, cut = Date.now() - 180 * 864e5;
        Object.entries((obj.removed && typeof obj.removed === "object") ? obj.removed : {}).forEach(([k, t]) => { if (+t > cut) r[k] = +t; });
        return r; })(),
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
    try { localStorage.setItem("familyTree.cloudDirty", "1"); localStorage.setItem("familyTree.dirtyAt", String(Date.now())); } catch (e) {}  // local has edits not yet in the cloud
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
    // The ⟳ button doubles as a sync light on every device (normal = synced,
    // orange = saving, red = failed) so sync state is never invisible.
    const sb = $("#tbSync");
    if (sb) {
      sb.classList.toggle("sync-pending", st === "pending" || st === "saving");
      sb.classList.toggle("sync-error", st === "error");
      sb.title = st === "error" ? ("Sync failed" + (msg ? ": " + msg : "") + " — tap to retry") : st === "pending" || st === "saving" ? "Saving to your site…" : "Refresh — pull the latest version from your site";
    }
    const el = $("#cloudStatus"); if (!el) return;
    const map = { off: "Off — turn on to save a durable copy to your site", on: "On ✓ — saves automatically", pending: "Saving soon…", saving: "Saving to your site…", saved: "Saved to your site ✓", error: "Save failed" };
    el.textContent = (map[st] || "") + (msg ? " — " + msg : "");
    el.className = "hint backup-" + st;
  }
  function scheduleCloudSave() {
    // Ownership (having both passwords) is what allows pushing — NOT the view
    // mode. A read-only phone that adds a note/photo must still push it, or its
    // "unsynced edits" flag never clears and blocks every future pull (the
    // "phone stuck on an old version" bug).
    if (!ownerCanCloud() && (readonly || !CLOUD_ON())) return;
    clearTimeout(cloudTimer);
    setCloudStatus("pending");
    cloudTimer = setTimeout(() => cloudSaveTree(false), 1500);   // near-instant: every change reaches the cloud moments after it's made
  }
  let missingPassWarned = false;
  async function cloudSaveTree(manual) {
    if (readonly && !ownerCanCloud()) return;
    let fam = ""; try { fam = localStorage.getItem("familyTree.familyPass") || ""; } catch (e) {}
    // A browser missing its saved passwords must NEVER skip saves silently —
    // that leaves edits stranded on one device while everything looks fine.
    const surface = (what) => {
      setCloudStatus("error", "Edits aren't reaching your site — " + what + ". Open “Save & back up” and click Save to fix it.");
      if (!missingPassWarned) { missingPassWarned = true; toast("⚠️ Your edits are NOT saving to your site from this browser — click “☁︎ Save to my site now” once to fix it"); }
    };
    if (!fam) { if (!manual) { surface("this browser doesn't have the family password"); return; } fam = prompt("Choose a family password (used to encrypt your saved tree):") || ""; if (!fam) return; try { localStorage.setItem("familyTree.familyPass", fam); } catch (e) {} }
    let pass = ""; try { pass = localStorage.getItem("familyTree.importPass") || ""; } catch (e) {}
    if (!pass) { if (!manual) { surface("this browser doesn't have the import passcode"); return; } pass = prompt("One-time import passcode (set as IMPORT_PASSCODE on the Vercel site):") || ""; if (!pass) return; try { localStorage.setItem("familyTree.importPass", pass); } catch (e) {} missingPassWarned = false; }
    try { localStorage.setItem("familyTree.cloudOn", "1"); } catch (e) {}
    // Whatever this copy is about to go over the top of, its keepsakes come
    // along: a picture or record added on another device is never lost just
    // because this device's copy is the one being pushed. Only costs a lookup,
    // and only reads the cloud copy when it has actually moved ahead of us.
    try {
      let synced = 0; try { synced = +(localStorage.getItem("familyTree.cloudSavedAt") || 0) || 0; } catch (e) {}
      const ahead = await cloudTreeInfo();
      if (ahead && ahead.exists && ahead.savedAt > synced) {
        const cp = await fetchCloudPayload();
        const r = cp && cp.payload ? await decryptWithKnown(cp.payload) : null;
        if (r && mergeKeepsakes(r.obj)) {
          localData = exportObject();
          idbSet(IDB.key, localData).catch(() => {});
          render();
        }
      }
    } catch (e) {}
    setCloudStatus("saving");
    try {
      // What this save is built on. The server refuses it if the stored copy has
      // moved on since, so nothing can be quietly replaced.
      // Only ever set when this device actually took the cloud's copy (or its own
      // save was accepted) — never from merely asking what version is up there,
      // which is how a device could claim to be current while holding old data.
      let base = 0; try { base = +(localStorage.getItem("familyTree.baseVersion") || 0) || 0; } catch (e) {}
      const payload = await encryptState(fam);
      // Vercel caps a request body at ~4.5MB. Small trees go in one POST; larger
      // ones (lots of photos) are streamed up in parts and stitched server-side,
      // so saving keeps working no matter how big the tree gets.
      const CHUNK = 3_500_000;
      const post = async (b) => {
        const res = await fetch("api/store", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ passcode: pass }, b)) });
        if (res.status === 409) {
          // The site's copy moved on since this device last took one. Not a
          // failure — the two get merged and the save goes again.
          let cur = 0; try { cur = +(await res.json()).savedAt || 0; } catch (e) {}
          const err = new Error("moved on"); err.conflict = true; err.savedAt = cur; throw err;
        }
        if (!res.ok) { let msg = "failed (" + res.status + ")"; try { msg = (await res.json()).error || msg; } catch (e) {} if (res.status === 404) msg = "needs the Vercel site + a Blob store"; throw new Error(msg); }
        return res;
      };
      // Tiny password-check ciphertext saved next to the tree: lets any device
      // tell "wrong password" apart from "damaged file" when a pull fails.
      let check = ""; try { check = await encryptText(fam, "familytree-pass-ok"); } catch (e) {}
      let done;
      if (payload.length <= CHUNK) {
        done = await post({ action: "saveTree", payload, check, base });
      } else {
        // Each upload gets a unique id: its chunks live in their own write-once
        // folder on the server, so chunks from different saves can never mix.
        const uploadId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        const total = Math.ceil(payload.length / CHUNK);
        const shas = [];
        for (let i = 0; i < total; i++) {
          const pr = await post({ action: "putPart", uploadId, index: i, chunk: payload.slice(i * CHUNK, (i + 1) * CHUNK) });
          // GitHub-backed storage identifies each part by a hash; pass them along.
          try { const pj = await pr.json(); if (pj && pj.sha) shas[i] = pj.sha; } catch (e) {}
          setCloudStatus("saving");
        }
        done = await post({ action: "commitTree", uploadId, total, shas, length: payload.length, check, base });
      }
      // Every save is length-verified: the server echoes exactly how many bytes
      // it stored — a mismatch is treated as a failed save, never trusted.
      const j = await done.json();
      if (j && j.size != null && j.size !== payload.length) throw new Error("the copy stored on your site is incomplete — retrying");
      // Record the cloud's write time so this device knows it's in sync and won't
      // pull its own save back on the next load.
      try { if (j && j.savedAt) localStorage.setItem("familyTree.cloudSavedAt", String(j.savedAt)); localStorage.setItem("familyTree.cloudDirty", "0"); } catch (e) {}
      if (j && j.savedAt) setBaseVersion(j.savedAt);
      cloudRetries = 0;
      try { await publishViews(); } catch (e) {}   // published views track the master on every save
      // Keep the shared viewer password working: wrap the family password under it
      // and store the wrap (ciphertext) so viewers can unlock with their password.
      try {
        const vp = localStorage.getItem("familyTree.viewerPass") || "";
        if (vp) { const wrap = await encryptText(vp, fam); await fetch("api/store", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "saveViewerKey", passcode: pass, wrap }) }); }
      } catch (e) {}
      // Manual saves verify the round-trip: download the copy back and decrypt it
      // with the same password, so "Saved ✓" genuinely means other devices can
      // open what's up there.
      if (manual) {
        setCloudStatus("saving", "verifying");
        const vcp = await fetchCloudPayload();
        let ok = false;
        if (vcp && vcp.payload) { try { await decryptState(fam, vcp.payload); ok = true; } catch (e) {} }
        if (!ok) throw new Error("saved, but the copy on your site couldn’t be read back — please click Save again");
      }
      setCloudStatus("saved");
      if (manual) toast("Saved & verified ✓ — other devices can open this copy");
    } catch (e) {
      // The site's copy moved on while this device was working. Rather than one
      // side losing, the two are merged — nothing either of them has is dropped
      // — and the save goes again from the version we just read.
      if (e && e.conflict && !cloudMerging) {
        // Covers both refusals — "your copy is older" and "your page never said
        // what it was built on" — because the answer to each is the same: take
        // what's up there, fold this copy into it, and save from that.
        cloudMerging = true;
        try {
          const cp = await fetchCloudPayload();
          const r = cp && cp.payload ? await decryptWithKnown(cp.payload) : null;
          if (r) {
            const sum = mergeTreeFrom(r.obj);
            try { localStorage.setItem("familyTree.cloudSavedAt", String(cp.savedAt || e.savedAt || 0)); } catch (e2) {}
            setBaseVersion(cp.savedAt || e.savedAt || 0);
            save(); autoLayout(); render();
            if (sum && sum.total) toast("Merged with a newer copy from another device — kept " + mergeSummary(sum));
            await cloudSaveTree(manual);
            return;
          }
        } catch (e2) {} finally { cloudMerging = false; }
      }
      if (e && e.conflict) { setCloudStatus("error", "another device saved at the same moment — trying again"); if (!manual) setTimeout(() => cloudSaveTree(false), 4000); return; }
      setCloudStatus("error", e.message);
      // Surface the failure even for automatic saves — a silent push failure is
      // exactly what leaves other devices (your phone) stuck on an old copy.
      const now = Date.now();
      if (manual || now - lastCloudErrToast > 20000) { lastCloudErrToast = now; toast("Couldn’t save to your site: " + (e.message || "error")); }
      // Auto-saves retry themselves (a network blip must not strand an edit).
      if (!manual && cloudRetries < 5) { cloudRetries++; setTimeout(() => cloudSaveTree(false), 15000); }
    }
  }
  let lastCloudErrToast = 0, cloudRetries = 0, cloudMerging = false;
  // The version whose CONTENT this device is holding. Set only where the cloud's
  // copy was actually adopted, or where our own save was accepted — never from
  // simply asking what version is up there. That's what makes it safe to say
  // "this save is built on X" and have the server hold us to it.
  const setBaseVersion = (v) => { try { if (v) localStorage.setItem("familyTree.baseVersion", String(v)); } catch (e) {} };
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
      setBaseVersion(savedAt);
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
  // Decrypt a cloud payload with whatever password this device knows: the stored
  // password used directly as the family password, or — when what's stored is
  // the shared VIEWER password — via the wrapped family key. The unlock screen
  // always supported both; the refresh/pull paths didn't, which made ⟳ fail
  // with "didn't open with your password" on a device unlocked the viewer way.
  let unwrappedFamCache = "";   // in-memory only; the real family password is never stored on a viewer device
  async function decryptWithKnown(payload, pwOverride) {
    let pw = pwOverride || "";
    if (!pw) { try { pw = localStorage.getItem("familyTree.familyPass") || ""; } catch (e) {} }
    if (!pw) return null;
    try { return { obj: await decryptState(pw, payload), pw }; } catch (_) {}
    if (unwrappedFamCache) { try { return { obj: await decryptState(unwrappedFamCache, payload), pw }; } catch (_) {} }
    const wrap = await fetchViewerWrap();
    if (wrap) {
      try {
        const fam = await decryptText(pw, wrap);
        const obj = await decryptState(fam, payload);
        unwrappedFamCache = fam;
        return { obj, pw };
      } catch (_) {}
    }
    return null;
  }
  // Does this password match the one the cloud was last saved with? Uses the tiny
  // pass-check ciphertext stored beside the tree. "right" / "wrong" / "unknown"
  // (unknown = no check saved yet, e.g. before the first save on current code).
  async function passVerdict(pw) {
    if (!pw) return "unknown";
    try {
      const res = await fetch("api/store?action=passCheck");
      if (!res.ok) return "unknown";
      const j = await res.json();
      if (!j || !j.check) return "unknown";
      try { await decryptText(pw, j.check); return "right"; } catch (_) {}
      const wrap = await fetchViewerWrap();
      if (wrap) { try { const fam = await decryptText(pw, wrap); await decryptText(fam, j.check); return "right"; } catch (_) {} }
      return "wrong";
    } catch (e) { return "unknown"; }
  }
  async function forcePullFromCloud() {
    toast("Checking your site for the latest…");
    const cp = await fetchCloudPayload();
    if (!cp || !cp.payload) { toast("No cloud copy found (your site may still be catching up)"); return; }
    let pw = ""; try { pw = localStorage.getItem("familyTree.familyPass") || ""; } catch (e) {}
    let r = await decryptWithKnown(cp.payload);
    // Stored password didn't open it (or none stored) — ask and try again, both
    // as the family password and as the viewer password. Self-healing instead of
    // a dead end.
    if (!r) {
      const typed = prompt("Password to open the cloud copy (your family or viewer password):") || "";
      if (!typed) return;
      pw = typed;
      r = await decryptWithKnown(cp.payload, typed);
    }
    if (!r) {
      // The cloud copy won't open — but the PUBLISHED snapshot might. Offer it,
      // so a phone stuck on an old local copy can still catch up to the last
      // published data even while the cloud copy is broken.
      const committed = await loadCommittedSnapshot();
      if (committed) {
        const rc = await decryptWithKnown(committed, pw);
        if (rc && confirm("The cloud copy can’t be opened, but the published copy of the tree can. Show the published copy on this device instead? (This replaces what this device currently shows — a backup of it is kept.)")) {
          // Never destroy what this device holds — stash it before replacing, so
          // an accidental OK on the editing computer can always be undone.
          try { await idbSet("tree.v1.conflictBackup", exportObject()); } catch (e) {}
          loadObject(rc.obj);
          try { localStorage.setItem("familyTree.familyPass", rc.pw); } catch (e) {}
          try { localData = exportObject(); await idbSet(IDB.key, localData); } catch (e) {}
          autoLayout(); render(); fitView();
          toast("Showing the published copy of the tree");
          return;
        }
      }
      // The password-check marker tells us WHICH problem this is, so the fix is
      // never a guessing game: wrong password vs. a damaged cloud file.
      const verdict = await passVerdict(pw);
      let when = ""; try { when = cp.savedAt ? new Date(cp.savedAt).toLocaleString() : ""; } catch (_) {}
      if (verdict === "right") toast("Your password is right, but the cloud file won’t open — it looks damaged. On your computer: Save & back up → ‘Save to my site now’, then tap ⟳ here again.");
      else if (verdict === "wrong") toast("That password doesn’t match the one the cloud copy was locked with" + (when ? " (cloud saved " + when + ")" : "") + ". On your computer, set the Family password box and Save to re-lock it.");
      else toast("That cloud copy didn’t open with that password" + (when ? " (cloud saved " + when + ")" : ""));
      return;
    }
    loadObject(r.obj);
    try { localStorage.setItem("familyTree.familyPass", r.pw); localStorage.setItem("familyTree.cloudSavedAt", String(cp.savedAt || 0)); localStorage.setItem("familyTree.cloudDirty", "0"); } catch (e) {}
    setBaseVersion(cp.savedAt || 0);
    // Persist what we pulled — without this, ⟳ showed fresh data but the next
    // visit regressed to the old local copy.
    try { localData = exportObject(); await idbSet(IDB.key, localData); } catch (e) {}
    autoLayout(); render(); fitView();
    let when = ""; try { when = cp.savedAt ? new Date(cp.savedAt).toLocaleString() : ""; } catch (e) {}
    toast(when ? ("Showing the latest — cloud saved " + when) : "Showing the latest from your site");
  }
  // On boot, if the cloud copy is newer than what this device last synced, pull it
  // in — this is what makes edits on one device show up on the others (e.g. your
  // phone) instead of a stale browser copy sticking around. Returns true if it
  // loaded fresh cloud data (or took over the unlock flow).
  // When is it SAFE to replace this device's saved tree with the cloud copy?
  //  - a viewer's local is only a cache → replace whenever the cloud is newer.
  //  - the OWNER's local can hold real edits → only replace when there are no
  //    unsynced edits (dirty flag) AND we've synced with this cloud at least
  //    once before — which stops a reload from pulling an older or foreign
  //    cloud copy over the owner's current work.
  function safeToPull(info) {
    let synced = 0, dirtyFlag = "";
    try { synced = +(localStorage.getItem("familyTree.cloudSavedAt") || 0); dirtyFlag = localStorage.getItem("familyTree.cloudDirty") || ""; } catch (e) {}
    const newer = info.savedAt > synced;
    if (!ownerCanCloud()) return newer;
    return newer && dirtyFlag !== "1" && (synced > 0 || dirtyFlag === "0");
  }
  // Bring this device and the site into step, in one move and without either
  // side winning: take the site's copy, fold in anything this device has that
  // it lacks, and push the result back only if there WAS something to fold in.
  // Both devices end up showing the same tree, which is the whole point — and
  // because the merge only ever adds, it doesn't matter which one ran last.
  let reconciling = false;
  async function reconcileWithCloud(manual) {
    if (reconciling) return false;
    if (readonly && !ownerCanCloud()) return await syncFromCloudIfNewer(!manual);   // a viewer just reads
    if (!CLOUD_ON() && !ownerCanCloud()) return false;
    reconciling = true;
    try {
      const info = await cloudTreeInfo();
      if (!info || !info.exists) return false;
      let base = 0, dirty = "";
      try { base = +(localStorage.getItem("familyTree.baseVersion") || 0) || 0; dirty = localStorage.getItem("familyTree.cloudDirty") || ""; } catch (e) {}
      if (info.savedAt === base && dirty !== "1") return false;         // already in step
      const cp = await fetchCloudPayload();
      if (!cp || !cp.payload) return false;
      const r = await decryptWithKnown(cp.payload);
      if (!r) return false;                                             // can't open it: leave well alone
      const mine = hasLocalData() || state.persons.length ? exportObject() : null;
      loadObject(r.obj);
      // A tree's name and subtitle are single values — there's no unioning them,
      // so this device's own wording stands and travels up with the save.
      if (mine && mine.title && mine.title !== state.title) state.title = mine.title;
      if (mine && mine.subtitle && mine.subtitle !== state.subtitle) state.subtitle = mine.subtitle;
      setBaseVersion(cp.savedAt || info.savedAt);
      try { localStorage.setItem("familyTree.cloudSavedAt", String(cp.savedAt || info.savedAt)); localStorage.setItem("familyTree.cloudDirty", "0"); } catch (e) {}
      const sum = mine ? mergeTreeFrom(mine) : null;
      try { localData = exportObject(); await idbSet(IDB.key, localData); } catch (e) {}
      try { localStorage.setItem(STORE_KEY, JSON.stringify(localData)); } catch (e) {}
      autoLayout(); render();
      if (sum && sum.total) {
        // this device had something the site didn't — send the reconciled copy up
        save();
        if (manual) toast("Brought together with your site — kept " + mergeSummary(sum));
        else toast("Synced — kept " + mergeSummary(sum) + " from this device");
      } else if (manual) toast("Up to date with your site");
      else toast("Updated to the latest from your site");
      return true;
    } catch (e) { return false; }
    finally { reconciling = false; }
  }
  async function syncFromCloudIfNewer(background) {
    const info = await cloudTreeInfo();
    if (!info || !info.exists) return false;
    if (!safeToPull(info)) return false;
    const cp = await fetchCloudPayload();
    if (!cp || !cp.payload) return false;
    const savedAt = cp.savedAt || info.savedAt;
    let fam = ""; try { fam = localStorage.getItem("familyTree.familyPass") || ""; } catch (e) {}
    if (fam) {
      const r = await decryptWithKnown(cp.payload);   // family password OR viewer password (via the wrap)
      if (!r) return false;                            // stored password doesn't open it → fall back to local
      loadObject(r.obj);
      try { localStorage.setItem("familyTree.cloudSavedAt", String(savedAt)); } catch (e) {}
      setBaseVersion(savedAt);
      try { localData = exportObject(); await idbSet(IDB.key, localData); } catch (e) {}   // refresh the local cache (no re-upload)
      return true;
    }
    // Newer cloud data but no password on this device: unlock it into the editor —
    // unless we're refreshing quietly behind an already-visible tree.
    if (background) return false;
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
    // An owner reconciles (theirs + ours); a viewer just takes what's there.
    if (ownerCanCloud()) { refreshingBg = true; try { await reconcileWithCloud(false); } finally { refreshingBg = false; } return; }
    refreshingBg = true;
    try {
      const info = await cloudTreeInfo();
      if (!info || !info.exists) return;
      if (!safeToPull(info)) return;
      const cp = await fetchCloudPayload();
      if (!cp || !cp.payload) return;
      const r = await decryptWithKnown(cp.payload);   // family password OR viewer password (via the wrap)
      if (!r) return;
      loadObject(r.obj);
      try { localStorage.setItem("familyTree.cloudSavedAt", String(cp.savedAt || info.savedAt)); } catch (e) {}
      setBaseVersion(cp.savedAt || info.savedAt);
      try { localData = exportObject(); await idbSet(IDB.key, localData); } catch (e) {}   // persist so it survives the next visit
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
        // Pin every slice to the SAME write-once version (v) so a save landing
        // mid-read can never mix two generations into one corrupted payload.
        const vq = j.v ? "&v=" + encodeURIComponent(j.v) : "";
        let out = "", total = j.size || Infinity;
        for (let s = 0; s < total; s += 3000000) {
          const pr = await fetch("api/store?action=getTreePart&start=" + s + "&len=3000000" + vq);
          if (!pr.ok) return null;
          const pj = await pr.json();
          if (typeof pj.size === "number") total = pj.size;
          if (!pj.chunk) break;
          out += pj.chunk;
        }
        if (out.length !== (j.size || out.length)) return null;   // incomplete read — don't hand back a torn copy
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
    return await loadCommittedSnapshot();
  }
  // The committed family-data.js snapshot is multi-megabyte, so it is no longer
  // loaded with the page — fetch it here, once, only when actually needed
  // (a device with no saved copy, or as a fallback when the cloud won't open).
  let committedLoadP = null;
  function loadCommittedSnapshot() {
    if (typeof window.FAMILY_TREE_DATA === "string" && window.FAMILY_TREE_DATA.length > 20) return Promise.resolve(window.FAMILY_TREE_DATA);
    if (!committedLoadP) committedLoadP = new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = "family-data.js?v=" + (window.FAMILY_DATA_VERSION || Date.now());
      s.onload = () => resolve(typeof window.FAMILY_TREE_DATA === "string" && window.FAMILY_TREE_DATA.length > 20 ? window.FAMILY_TREE_DATA : null);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
    return committedLoadP;
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
  // Pictures, extra photos and attached records are keepsakes: when two copies
  // of the tree disagree about one, HAVING it is always the right answer. So
  // before this device's copy goes over another, anything the other copy has
  // and this one doesn't comes along — a photo added on a phone can never be
  // lost to an older copy syncing on top of it.
  function mergeKeepsakes(other) {
    if (!other || !Array.isArray(other.persons)) return 0;
    const by = {}; other.persons.forEach((p) => { if (p && p.id) by[p.id] = p; });
    let n = 0;
    state.persons.forEach((p) => {
      const o = by[p.id]; if (!o) return;
      if (!p.photo && !p.photoRef && (o.photo || o.photoRef)) {
        if (o.photoRef) p.photoRef = o.photoRef; else p.photo = o.photo;
        if (o.photoSrcRef) p.photoSrcRef = o.photoSrcRef;
        if (o.photoMobile) p.photoMobile = true;
        n++;
      }
      if (Array.isArray(o.gallery) && o.gallery.length) {
        const key = (g) => (g && (g.ref || (g.data || "").slice(0, 64))) || "";
        const have = new Set((p.gallery || []).map(key));
        const extra = o.gallery.filter((g) => g && !have.has(key(g)));
        if (extra.length) { p.gallery = (p.gallery || []).concat(extra); n += extra.length; }
      }
      if (Array.isArray(o.docs) && o.docs.length) {
        const have = new Set((p.docs || []).map((d) => d && d.id));
        const extra = o.docs.filter((d) => d && !have.has(d.id));
        if (extra.length) { p.docs = (p.docs || []).concat(extra); n += extra.length; }
      }
    });
    return n;
  }
  // Fold another copy of the tree into this one, keeping everything either side
  // has. Used when a save is refused because the copy on the site moved on: the
  // two are merged and the save is tried again, so no device can wipe another's
  // work by holding an older copy.
  //
  // The rule throughout is ADD, never remove. People, families and links are
  // unioned; a person present in both keeps our values but is filled in from
  // theirs wherever we have a blank; anything hidden, locked or repeated on
  // either side stays that way; arrangements are ours, with theirs filling gaps.
  // The cost is that a deletion made here can come back if another device still
  // has that person — recoverable in a click, unlike losing them.
  function mergeTreeFrom(other) {
    if (!other || !Array.isArray(other.persons)) return null;
    const sum = { people: 0, unions: 0, links: 0, hidden: 0, fields: 0, views: 0, keepsakes: 0, removed: 0 };
    // Both sides' deletions first: anything either copy deliberately removed
    // stays removed, and a removal the other side made is applied here too.
    const gone = Object.assign({}, other.removed || {}, state.removed || {});
    state.removed = gone;
    Object.keys(other.removed || {}).forEach((k) => {
      if ((state.removed || {})[k] && !(other.removed || {})[k]) return;
      if (k.startsWith("p:")) { const id = k.slice(2); if (state.persons.some((p) => p.id === id)) { deletePerson(id); sum.removed++; } }
      else if (k.startsWith("u:")) { const id = k.slice(2); if (state.unions.some((u) => u.id === id)) { deleteUnion(id); sum.removed++; } }
      else if (k.startsWith("l:")) { const i = k.indexOf(">"); const uu = k.slice(2, i), cc = k.slice(i + 1);
        const before = state.links.length; state.links = state.links.filter((l) => !(l.union === uu && l.child === cc));
        if (state.links.length !== before) sum.removed++; }
    });
    const mine = {}; state.persons.forEach((p) => (mine[p.id] = p));
    // people: everyone they have that we don't
    other.persons.forEach((o) => {
      if (!o || !o.id) return;
      if (gone[tombKey.person(o.id)]) return;            // deliberately removed — don't bring them back
      const p = mine[o.id];
      if (!p) { state.persons.push(JSON.parse(JSON.stringify(o))); mine[o.id] = o; sum.people++; return; }
      // shared person: fill in anything we're missing, never overwrite
      const blank = (v) => v === undefined || v === null || v === "";
      Object.keys(o).forEach((k) => {
        if (k === "id" || k === "gallery" || k === "docs") return;
        if (blank(p[k]) && !blank(o[k])) { p[k] = o[k]; sum.fields++; }
      });
    });
    // …and their keepsakes (pictures, extra photos, records) as before
    sum.keepsakes = mergeKeepsakes(other) || 0;
    // families and the links between them
    const haveU = new Set(state.unions.map((u) => u.id));
    (other.unions || []).forEach((u) => { if (u && u.id && !haveU.has(u.id) && !gone[tombKey.union(u.id)]) { state.unions.push(u); haveU.add(u.id); sum.unions++; } });
    const lkey = (l) => l.union + ">" + l.child;
    const haveL = new Set(state.links.map(lkey));
    (other.links || []).forEach((l) => { if (l && l.union && !haveL.has(lkey(l)) && !gone[tombKey.link(l.union, l.child)] && !gone[tombKey.union(l.union)] && !gone[tombKey.person(l.child)]) { state.links.push(l); haveL.add(lkey(l)); sum.links++; } });
    // things switched ON stay on, whichever copy switched them
    const flags = (name) => {
      const ours = state[name] || (state[name] = {}), theirs = other[name] || {};
      Object.keys(theirs).forEach((k) => { if (theirs[k] && !(k in ours)) { ours[k] = theirs[k]; if (name === "hidden") sum.hidden++; } });
    };
    ["hidden", "locked", "portals", "manualHidden"].forEach(flags);
    // where people sit: ours wins, theirs fills the gaps
    ["manual", "echoPos", "busOff"].forEach((name) => {
      const ours = state[name] || (state[name] = {}), theirs = other[name] || {};
      Object.keys(theirs).forEach((k) => { if (!(k in ours)) ours[k] = theirs[k]; });
    });
    // any view only they have
    const haveV = new Set((state.views || []).map((v) => v.id));
    (other.views || []).forEach((v) => { if (v && v.id && !haveV.has(v.id)) { (state.views || (state.views = [])).push(v); haveV.add(v.id); sum.views++; } });
    if (!state.groups || !state.groups.length) state.groups = other.groups || state.groups;
    sum.total = sum.people + sum.unions + sum.links + sum.hidden + sum.fields + sum.views + sum.keepsakes + sum.removed;
    return sum;
  }
  const mergeSummary = (sum) => [
    sum.people && sum.people + (sum.people === 1 ? " person" : " people"),
    sum.fields && sum.fields + " details",
    sum.hidden && sum.hidden + " hidden",
    sum.keepsakes && sum.keepsakes + " photos/records",
    sum.views && sum.views + (sum.views === 1 ? " view" : " views"),
  ].filter(Boolean).join(", ");
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
      if (!pp.photo && !pp.photoRef) { if (o.photo) pp.photo = o.photo; if (o.photoRef) pp.photoRef = o.photoRef; }
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
    const dropped = new Set();
    state.unions = state.unions.filter((u) => {
      const keep = isSibGroup(u)
        ? (childCount[u.id] || 0) >= 2          // a sibling group needs siblings to join
        : !(u.b == null && !childCount[u.id]);
      if (!keep && isSibGroup(u)) dropped.add(u.id);
      return keep;
    });
    if (dropped.size) state.links = state.links.filter((l) => !dropped.has(l.union));
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
  { const sb = $("#tbSync"); if (sb) sb.onclick = () => {
      if (!ownerCanCloud()) return forcePullFromCloud();          // viewers: straight pull
      toast("Checking your site…");
      reconcileWithCloud(true).then((did) => { if (!did) toast("Up to date with your site"); }).catch(() => forcePullFromCloud());
    }; }
  // Re-pull the latest when you return to the tab or a phone restores a frozen
  // page — keeps the view current without a manual refresh.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { backgroundRefresh(); return; }
    // Leaving the tab with an edit still in the save window: push NOW instead of
    // waiting out the debounce, so closing the tab can't strand a change.
    try { if (localStorage.getItem("familyTree.cloudDirty") === "1" && ownerCanCloud()) { clearTimeout(cloudTimer); cloudSaveTree(false); } } catch (e) {}
  });
  window.addEventListener("pageshow", (e) => { if (e.persisted) backgroundRefresh(); });
  window.addEventListener("focus", () => backgroundRefresh());
  // A tab left open (e.g. the phone sitting on the tree) checks for a newer cloud
  // copy about once a minute — a cheap metadata probe unless something changed.
  setInterval(() => backgroundRefresh(), 60000);
  $("#tbRearrange").onclick = () => setRearrange(!rearrange);
  $("#tbTidy").onclick = tidyUp;
  // ☰ opens the People list + menu (add a person, auto-arrange).
  function togglePeopleMenu(show) {
    const m = $("#peopleMenu"); if (!m) return;
    const vis = (show === undefined) ? m.hidden : show;
    m.hidden = !vis; $("#tbMenu").classList.toggle("active", vis);
    if (vis) { updatePeopleList(); const f = $("#peopleFilter"); if (f) setTimeout(() => f.focus(), 0); }
  }
  { const b = $("#personEditBtn"); if (b) b.onclick = () => { const p = personById($("#personId").value); if (p) showPersonForm(p); }; }
  { const b = $("#pmSettings"); if (b) b.onclick = () => { togglePeopleMenu(false); toggleSettings(true); }; }
  { const b = $("#settingsClose"); if (b) b.onclick = () => toggleSettings(false); }
  function toggleSettings(show) {
    const m = $("#settingsMenu"); if (!m) return;
    const vis = (show === undefined) ? m.hidden : show;
    m.hidden = !vis;
  }
  $("#tbMenu").onclick = () => togglePeopleMenu();
  $("#pmClose").onclick = () => togglePeopleMenu(false);
  $("#pmAdd").onclick = () => { togglePeopleMenu(false); resetPersonForm(); ensurePanel(); const n = $("#pFirst"); if (n) n.focus(); };
  { const b = $("#pmViews"); if (b) b.onclick = () => { $("#peopleMenu").hidden = true; openViewsModal(); }; }
  { const b = $("#pmEnableEdit"); if (b) b.onclick = () => { $("#peopleMenu").hidden = true; enableEditingHere(); }; }
  { const b = $("#tbViews"); if (b) b.onclick = openViewSheet; }
  $("#pmArrange").onclick = () => {
    pushUndo();
    const keepPinned = (map) => { const out = {}; Object.keys(state.locked || {}).forEach((id) => { if (map && map[id]) out[id] = map[id]; }); return out; };
    if (viewPreview) viewPreview.view.manual = keepPinned(viewPreview.view.manual);   // reset only this view's arrangement
    else if (hiddenScope) state.manualHidden = keepPinned(state.manualHidden);
    else state.manual = keepPinned(state.manual);
    selection = new Set(); relayoutAndSave(); fitView(); toast("Auto-arranged");
  };
  $("#peopleFilter").addEventListener("input", () => updatePeopleList());
  $("#sibLeftBtn").onclick = () => shiftSibling(-1);
  $("#sibRightBtn").onclick = () => shiftSibling(1);
  $("#tbZoomIn").onclick = () => zoomAt(1.2);
  $("#tbZoomOut").onclick = () => zoomAt(1 / 1.2);
  $("#addUnionBtn").onclick = openUnionModal;
  $("#addChildBtn").onclick = openChildModal;
  $("#exportBtn").onclick = async () => {
    toast("Preparing export (folding photos & documents back in)…");
    const obj = await exportInlinedObject();
    downloadFile((state.title || "family-tree").replace(/\s+/g, "-").toLowerCase() + ".json", JSON.stringify(obj, null, 2));
    toast("Exported — the file is self-contained");
  };
  $("#importBtn").onclick = () => $("#importInput").click();
  $("#importInput").addEventListener("change", (e) => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { try { loadObject(JSON.parse(r.result)); relayoutAndSave(); fitView(); toast("Imported"); } catch (err) { toast("Bad file"); } };
    r.readAsText(f); e.target.value = "";
  });
  // Prefill the password boxes with whatever this device currently uses.
  { const fp = $("#cloudFamilyPass"); if (fp) { try { fp.value = localStorage.getItem("familyTree.familyPass") || ""; } catch (e) {} } }
  { const vp = $("#cloudViewerPass"); if (vp) { try { vp.value = localStorage.getItem("familyTree.viewerPass") || ""; } catch (e) {} } }
  $("#cloudSaveBtn").onclick = () => {
    // If the family password box is filled, adopt it before saving — this is how
    // you re-lock the cloud copy with the correct password so other devices open it.
    const fp = $("#cloudFamilyPass"); const v = fp ? fp.value.trim() : "";
    if (v) { try { localStorage.setItem("familyTree.familyPass", v); } catch (e) {} }
    const vp = $("#cloudViewerPass"); if (vp) { try { localStorage.setItem("familyTree.viewerPass", vp.value.trim()); } catch (e) {} }
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
  { const db = $("#obitDatesBtn"); if (db) db.onclick = () => { const id = $("#personId").value; if (id) readDatesFromObit(personById(id)); }; }
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
  // The wrapped family password (ciphertext) for the shared viewer password.
  async function fetchViewerWrap() {
    try { const r = await fetch("api/store?action=viewerKey"); if (!r.ok) return null; const j = await r.json(); return j.wrap || null; }
    catch (e) { return null; }
  }
  function showLock(intoEditor, payload) {
    // Try a password against EVERY copy we have — the live cloud copy and any
    // committed family-data.js snapshot — and open whichever it unlocks. A
    // password may be the family password directly, or the shared viewer
    // password (which unwraps the family password but only ever opens the
    // read-only view).
    const candidates = [];
    if (payload) candidates.push({ src: "cloud", data: payload });
    // The committed snapshot is only downloaded if the copies at hand won't
    // open — keeps the lock screen (and first paint) fast.
    async function addCommittedCandidate() {
      if (candidates.some((c) => c.src === "committed")) return;
      const committed = await loadCommittedSnapshot();
      if (committed && committed !== payload) candidates.push({ src: "committed", data: committed });
    }
    async function tryUnlock(pw) {
      if (!pw) return null;
      for (const c of candidates) { try { return { obj: await decryptState(pw, c.data), from: c.src, viewer: false }; } catch (_) {} }
      await addCommittedCandidate();
      const tried = candidates.filter((c) => c.src === "committed");
      for (const c of tried) { try { return { obj: await decryptState(pw, c.data), from: c.src, viewer: false }; } catch (_) {} }
      const wrap = await fetchViewerWrap();
      if (wrap) {
        try {
          const fam = await decryptText(pw, wrap);
          for (const c of candidates) { try { return { obj: await decryptState(fam, c.data), from: c.src, viewer: true }; } catch (_) {} }
        } catch (_) {}
      }
      // A VIEW password opens just that published slice, always read-only.
      try {
        const lr = await fetch("api/store?action=listViews");
        if (lr.ok) {
          const lj = await lr.json();
          for (const vv of (lj.views || [])) {
            try {
              if ((await decryptText(pw, vv.check)) !== "familytree-view-ok") continue;
              const gr = await fetch("api/store?action=getView&id=" + encodeURIComponent(vv.id));
              if (!gr.ok) continue;
              const gj = await gr.json();
              if (gj.payload) return { obj: await decryptState(pw, gj.payload), from: "view", viewer: true };
            } catch (_) {}
          }
        }
      } catch (_) {}
      return null;
    }
    function finish(pw, r) {
      loadObject(r.obj);
      $("#lock").hidden = true;
      // Remember the password that worked so this device opens without asking
      // next time (fixes "asks me for my password every time" on the phone).
      try { localStorage.setItem("familyTree.familyPass", pw); } catch (e) {}
      // Only claim we're in sync with the cloud if the cloud copy is what opened.
      if (!r.viewer && r.from === "cloud") cloudTreeInfo().then((info) => { if (info && info.savedAt) { try { localStorage.setItem("familyTree.cloudSavedAt", String(info.savedAt)); } catch (e) {} } });
      // The viewer password NEVER opens the editor, even with ?edit in the URL.
      if (intoEditor && !r.viewer) { readonly = false; save(); }
      else enterReadonly();
      boot();
    }
    $("#lockForm").onsubmit = async (e) => {
      e.preventDefault();
      const pw = $("#lockPass").value;
      $("#lockErr").textContent = "";
      const r = await tryUnlock(pw);
      if (!r) { $("#lockErr").textContent = "Wrong password — try again."; return; }
      finish(pw, r);
    };
    // Remembered password: unlock silently; only show the form if it's missing
    // or no longer works.
    (async () => {
      let saved = ""; try { saved = localStorage.getItem("familyTree.familyPass") || ""; } catch (e) {}
      const r = await tryUnlock(saved);
      if (r) { finish(saved, r); return; }
      const lock = $("#lock"); lock.hidden = false;
      $("#lockPass").focus();
    })();
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
    // One-time: "ancestors" used to mean the strict pedigree and now means the
    // whole family line, so views written before the split keep their meaning.
    // One-time repair: four pictures added from a phone lost their link when an
    // older copy of the tree synced on top of the newer one. The pictures
    // themselves were never deleted — only the link — so it is simply put back,
    // and only for someone who still has no picture, so a newer one is never
    // overwritten.
    if (!readonly && !state.picRelink1) {
      const lost = { april: "mocafpy6lu9", henry: "m8l4lxhjook", penny: "mdnrrkh3ldf", nmrvifuup3pmy: "mum1tdgjf5m" };
      let back = 0;
      Object.keys(lost).forEach((pid) => {
        const p = personById(pid); if (!p || p.photo || p.photoRef) return;
        p.photoRef = lost[pid]; p.photoMobile = true; back++;
      });
      state.picRelink1 = true; save();
      if (back) { try { cloudSaveTree(false); } catch (e) {} toast(back === 1 ? "Put a lost picture back" : "Put " + back + " lost pictures back"); }
    }
    // One-time repair: attaching a PDF obituary used to overwrite the person's
    // picture with page one of it. Lloyd's portrait is still in the photo store,
    // so the link goes back — and only if his picture is still the one the
    // obituary put there, so a newer picture is never disturbed.
    if (!readonly && !state.obitPicFix1) {
      const p = personById("nmrwb8cfchrfg");
      if (p && p.photoRef === "ms72wq7sm3b") {
        p.photoRef = "m5cu8shzzvr"; delete p.photo; delete p.photoSrcRef;
        state.obitPicFix1 = true; save();
        try { cloudSaveTree(false); } catch (e) {}
        render(); toast("Put Lloyd's picture back");
      } else { state.obitPicFix1 = true; save(); }
    }
    if (!readonly && !state.viewModesV2) {
      (state.views || []).forEach((v) => (v.rules || []).forEach((r) => { if (r.mode === "ancestors") r.mode = "direct"; }));
      state.viewModesV2 = true; save();
    }
    autoLayout(); render(); syncTitle(); setupTitleEditing();
    try {
      const vid = localStorage.getItem("familyTree.currentView");
      const vv = (state.views || []).find((xx) => xx.id === vid);
      if (vv) startViewPreview(vv);
    } catch (e) {}
    if (!readonly) setTimeout(() => sweepEmbeddedMedia(true), 8000);   // storage diet: externalise anything still embedded
    if (!readonly) setTimeout(() => healMissingMedia(), 12000);        // re-upload any photo the cloud lost but this device still has
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

  /* ---- GitHub key expiry banner: warn the owner BEFORE cloud saves break ---- */
  function showTokenBanner(kind, expiresAt) {
    if (document.getElementById("tokenBanner")) return;
    const b = document.createElement("div");
    b.id = "tokenBanner";
    b.className = "token-banner" + (kind === "expired" ? " expired" : "");
    const when = expiresAt ? new Date(expiresAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "";
    const msg = kind === "expired"
      ? "Your site's GitHub key has expired (or was revoked) — saving to your site is stopped until you replace it."
      : "Your site's GitHub key expires on " + when + " — renew it before then so saving keeps working.";
    b.innerHTML = `<span class="tb-msg">🔑 ${msg}</span>
      <button type="button" class="tb-how">Show me how</button>
      ${kind === "expired" ? "" : '<button type="button" class="tb-snooze">Remind me in a week</button>'}
      <button type="button" class="tb-close" aria-label="Dismiss">✕</button>
      <div class="tb-steps" hidden>
        <b>Takes about 5 minutes:</b>
        <ol>
          <li>On <b>github.com</b>: your profile photo → Settings → Developer settings → Personal access tokens → <b>Fine-grained tokens</b> → Generate new token. Expiration: <b>1 year</b>. Repository access: <b>Only select repositories</b> → your family-tree repository. Permissions → Contents: <b>Read and write</b>. Generate it and copy the value.</li>
          <li>On <b>vercel.com</b>: your project → Settings → <b>Environment Variables</b> → edit <b>GITHUB_TOKEN</b> → paste the new value (keep <b>Production</b> checked) → Save.</li>
          <li>Deployments tab → <b>⋯</b> on the newest deployment → <b>Redeploy</b>. This banner goes away on its own once the new key is live.</li>
        </ol>
      </div>`;
    b.querySelector(".tb-how").onclick = () => { const s = b.querySelector(".tb-steps"); s.hidden = !s.hidden; };
    const snooze = b.querySelector(".tb-snooze");
    if (snooze) snooze.onclick = () => { try { localStorage.setItem("familyTree.tokenSnoozeUntil", String(Date.now() + 7 * 86400000)); } catch (e) {} b.remove(); };
    b.querySelector(".tb-close").onclick = () => b.remove();
    document.body.prepend(b);
  }
  async function checkTokenHealth() {
    if (!isOwner()) return;   // family viewers can't renew the key — don't nag them
    const now = Date.now();
    try { if (now < +(localStorage.getItem("familyTree.tokenCheckAfter") || 0)) return; } catch (e) {}
    let j = null;
    try { const r = await fetch("api/store?action=tokenHealth&ts=" + now); j = await r.json(); } catch (e) { return; }
    if (!j || j.error) return;
    const DAY = 86400000;
    if (j.auth === false) { showTokenBanner("expired", null); return; }
    if (!j.expiresAt) { try { localStorage.setItem("familyTree.tokenCheckAfter", String(now + 20 * 3600 * 1000)); } catch (e) {} return; }
    const days = (j.expiresAt - now) / DAY;
    if (days < 0) { showTokenBanner("expired", j.expiresAt); return; }
    if (days > 30) { try { localStorage.setItem("familyTree.tokenCheckAfter", String(now + 20 * 3600 * 1000)); } catch (e) {} return; }
    // Inside the warning window: check on every load (so the banner comes back)
    // unless the owner asked to be reminded later.
    try { if (now < +(localStorage.getItem("familyTree.tokenSnoozeUntil") || 0)) return; } catch (e) {}
    showTokenBanner("soon", j.expiresAt);
  }

  /* ==================================================================== VIEWS
     A View is a named slice of the master tree, built from rules — "this
     person + everyone related / all descendants / all ancestors" — as many
     rules as you like. Each view can be published under its own share
     password: someone entering that password at the lock screen sees ONLY
     that slice, read-only. Private notes never leave the master tree, and
     hidden people are never included in a view. */
  const spouseIdsOf = (pid) => unionsOfPerson(pid).map((u) => (u.a === pid ? u.b : u.a)).filter((x) => x != null && personById(x));
  function viewMembers(rules, withHidden, hideList) {
    const set = new Set();
    const addDescendants = (pid) => {
      const stack = [pid];
      while (stack.length) {
        const cur = stack.pop();
        set.add(cur);
        spouseIdsOf(cur).forEach((s) => set.add(s));   // spouses shown for context
        unionsOfPerson(cur).forEach((u) => childLinksOfUnion(u.id).forEach((l) => { if (!set.has(l.child) && personById(l.child)) stack.push(l.child); }));
      }
    };
    // Every direct ancestor: parents, grandparents, great-grandparents… and
    // nobody else. No siblings, aunts, uncles or cousins — a plain pedigree.
    const directLine = (pid) => {
      const anc = new Set([pid]);
      const stack = [pid];
      while (stack.length) {
        const cur = stack.pop();
        parentLinksOfPerson(cur).forEach((l) => {
          const u = unionById(l.union); if (!u) return;
          [u.a, u.b].forEach((par) => { if (par != null && personById(par) && !anc.has(par)) { anc.add(par); stack.push(par); } });
        });
      }
      return anc;
    };
    const addDirect = (pid) => directLine(pid).forEach((id) => set.add(id));
    // Immediate family: them, their partner(s), their children, and the home
    // they grew up in — parents and siblings. Nothing further out.
    const addImmediate = (pid) => {
      set.add(pid);
      spouseIdsOf(pid).forEach((sp) => set.add(sp));
      unionsOfPerson(pid).forEach((u) => childLinksOfUnion(u.id).forEach((l) => { if (personById(l.child)) set.add(l.child); }));
      parentLinksOfPerson(pid).forEach((l) => {
        const u = unionById(l.union); if (!u) return;
        [u.a, u.b].forEach((x) => { if (x != null && personById(x)) set.add(x); });
        childLinksOfUnion(u.id).forEach((cl) => { if (personById(cl.child)) set.add(cl.child); });   // siblings
      });
    };
    // The whole family line: walk the direct line up to the oldest ancestors on
    // record, then come back DOWN through everyone descended from them — all
    // their children, grandchildren and so on. Spouses are shown so couples
    // read properly, but a married-in spouse's own family is left out.
    const addLine = (pid) => {
      const anc = directLine(pid);
      const hasParents = (id) => parentLinksOfPerson(id).some((l) => {
        const u = unionById(l.union);
        return u && [u.a, u.b].some((x) => x != null && personById(x));
      });
      const apex = [...anc].filter((id) => !hasParents(id));
      const mine = new Set(anc);
      const seen = new Set();   // separate from membership: the walk has to pass
      const stack = apex.length ? [...apex] : [...anc];   // THROUGH the line itself
      while (stack.length) {   // down from the oldest ancestors
        const cur = stack.pop();
        if (seen.has(cur)) continue;
        seen.add(cur); mine.add(cur);
        unionsOfPerson(cur).forEach((u) => childLinksOfUnion(u.id).forEach((l) => {
          if (personById(l.child)) { mine.add(l.child); stack.push(l.child); }
        }));
      }
      [...mine].forEach((id) => spouseIdsOf(id).forEach((sp) => mine.add(sp)));   // married-ins, and no further
      mine.forEach((id) => set.add(id));
    };
    // "Everyone related": the person's blood relatives — all ancestors, plus
    // every descendant of those ancestors (that's what brings in siblings,
    // nieces/nephews, aunts/uncles, and cousins) — plus the spouses married
    // INTO that group. It deliberately stops there: a married-in spouse is
    // shown, their own family is not.
    const addRelated = (pid) => {
      const mine = new Set([pid]);
      let stack = [pid];
      while (stack.length) {   // ancestors
        const cur = stack.pop();
        parentLinksOfPerson(cur).forEach((l) => {
          const u = unionById(l.union); if (!u) return;
          [u.a, u.b].forEach((par) => { if (par != null && personById(par) && !mine.has(par)) { mine.add(par); stack.push(par); } });
        });
      }
      stack = [...mine];   // descendants of the person AND of every ancestor
      while (stack.length) {
        const cur = stack.pop();
        unionsOfPerson(cur).forEach((u) => childLinksOfUnion(u.id).forEach((l) => { if (personById(l.child) && !mine.has(l.child)) { mine.add(l.child); stack.push(l.child); } }));
      }
      [...mine].forEach((id) => spouseIdsOf(id).forEach((sp) => mine.add(sp)));   // married-ins, and no further
      mine.forEach((id) => set.add(id));
    };
    (rules || []).forEach((r) => {
      if (!personById(r.person)) return;
      if (r.mode === "immediate") addImmediate(r.person);
      else if (r.mode === "descendants") addDescendants(r.person);
      else if (r.mode === "direct") addDirect(r.person);
      else if (r.mode === "ancestors") addLine(r.person);
      else addRelated(r.person);
    });
    [...set].forEach((id) => { if (isHidden(id)) set.delete(id); });   // hidden branches stay out unless chosen below
    // Hidden branches the view's creator explicitly opted in: add the branch
    // under each chosen couple, but only while that couple is still in the view.
    (withHidden || []).forEach((uid) => {
      const u = unionById(uid); if (!u) return;
      if (!set.has(u.a) && !(u.b != null && set.has(u.b))) return;
      hiddenMembersFrom([u.a, u.b].filter((x) => x != null)).members.forEach((m) => { if (isHidden(m)) set.add(m); });
    });
    (hideList || []).forEach((id) => set.delete(id));   // people you hid from THIS view
    return set;
  }
  // The hidden branches hanging under a member-couple of the given rule set —
  // each is offered as an opt-in toggle when editing a view.
  function viewHiddenChoices(rules) {
    const base = viewMembers(rules);
    const out = [];
    state.unions.forEach((u) => {
      if (!base.has(u.a) && !(u.b != null && base.has(u.b))) return;
      const branch = hiddenMembersFrom([u.a, u.b].filter((x) => x != null)).members.filter((m) => isHidden(m));
      if (branch.length) out.push({ union: u.id, count: branch.length, label: [(personById(u.a) || {}).name, u.b != null ? (personById(u.b) || {}).name : null].filter(Boolean).join(" & ") });
    });
    return out;
  }
  // The shareable copy of a view: only its members, their couples/children,
  // and their saved positions. Private notes are stripped.
  function viewSlice(view) {
    const set = viewMembers(view.rules, view.withHidden, view.hide);
    const persons = state.persons.filter((p) => set.has(p.id)).map((p) => { const q = Object.assign({}, p); delete q.notes; return q; });
    const unions = state.unions.filter((u) => set.has(u.a) && (u.b == null || set.has(u.b)));
    const uids = new Set(unions.map((u) => u.id));
    const links = state.links.filter((l) => uids.has(l.union) && set.has(l.child));
    const manual = {}; Object.keys(state.manual || {}).forEach((k) => { if (set.has(k)) manual[k] = state.manual[k]; });
    Object.keys(view.manual || {}).forEach((k) => { if (set.has(k)) manual[k] = view.manual[k]; });   // the view's own arrangement wins
    // Only the "never repeat here" flags travel into a published view: forced
    // jumps belong to the master tree's arrangement, and the view draws its own.
    const portals = {}; links.forEach((l) => { if (state.portals && state.portals[l.id] === false) portals[l.id] = false; });
    const echoPos = {}; Object.keys(view.echoPos || {}).forEach((k) => { const i = k.indexOf(":"); if (uids.has(k.slice(0, i)) && set.has(k.slice(i + 1))) echoPos[k] = view.echoPos[k]; });
    const busOff = {}; Object.keys(view.busOff || {}).forEach((k) => { if (uids.has(k)) busOff[k] = view.busOff[k]; });
    return { title: view.name || state.title, subtitle: state.subtitle, persons, unions, links, manual, portals, echoPos, busOff, manualHidden: {}, hidden: {}, focus: [], version: state.version || 0, photoMigrated: true, namesSplit: true, viewOf: view.id, mediaKey: state.mediaKey || null };
  }
  // Encrypt every published view under its own password and store them.
  async function publishViews(interactive) {
    const views = (state.views || []).filter((v) => v.pass && v.rules && v.rules.length);
    if (!views.length) return { n: 0, why: "noviews" };
    let pass = ""; try { pass = localStorage.getItem("familyTree.importPass") || ""; } catch (e) {}
    // Publishing is an upload, so it needs the site's import passcode — when
    // this browser doesn't have it stored, ASK (never fail with a wrong excuse).
    if (!pass && interactive) {
      pass = prompt("One-time import passcode (the IMPORT_PASSCODE set on your Vercel site):") || "";
      if (pass) { try { localStorage.setItem("familyTree.importPass", pass); } catch (e) {} }
    }
    if (!pass) return { n: 0, why: "nopass" };
    const batch = [];
    for (const v of views) {
      const payload = await encryptState(v.pass, viewSlice(v));
      const check = await encryptText(v.pass, "familytree-view-ok");
      batch.push({ id: v.id, name: v.name || "Family view", payload, check });
    }
    const res = await fetch("api/store", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "saveViews", passcode: pass, views: batch }) });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) || {}).error || "Publishing views failed");
    return { n: batch.length };
  }
  // Build the "Viewing" rows (whole tree + each view) into a container. Used by
  // the desktop ☰ menu and the mobile hamburger sheet.
  function buildViewSwitchList(container, onPick) {
    container.textContent = "";
    const row = (label, active, fn) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "vs-row" + (active ? " active" : "");
      b.textContent = label;
      b.onclick = () => { fn(); if (onPick) onPick(); };
      container.appendChild(b);
    };
    row("🌳 Whole tree", !viewPreview, () => endViewPreview());
    (state.views || []).forEach((v) => {
      const n = viewMembers(v.rules, v.withHidden).size;
      row("🔭 " + (v.name || "Untitled") + " (" + n + ")", !!(viewPreview && viewPreview.view.id === v.id), () => startViewPreview(v));
    });
  }
  // Keyboard shortcuts: M move, T tidy; with a selection — C snap close,
  // W snap wide, L lock/unlock, G group/ungroup, H hide, K center on children
  // (kids), P center on parents. Ignored while typing or in a dialog.
  document.addEventListener("keydown", (e) => {
    if (readonly || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (document.querySelector(".modal-backdrop") || !$("#lock").hidden) return;
    const k = (e.key || "").toLowerCase();
    const barBtn = (re, re2) => {
      const bs = [...document.querySelectorAll("#selBar button")];
      const b = bs.find((x) => re.test(x.textContent)) || (re2 && bs.find((x) => re2.test(x.textContent)));
      if (b) { e.preventDefault(); b.click(); }
    };
    if (k === "m") { e.preventDefault(); $("#tbRearrange").click(); }
    else if (k === "t") { e.preventDefault(); $("#tbTidy").click(); }
    else if (k === "[" && selection.size) { e.preventDefault(); nudgeGeneration(-1); }
    else if (k === "]" && selection.size) { e.preventDefault(); nudgeGeneration(1); }
    else if (k === "c") barBtn(/Snap close/);
    else if (k === "w") barBtn(/Snap wide/);
    else if (k === "l") barBtn(/🔒 Lock/, /🔓 Unlock/);
    else if (k === "g") {
      const ids2 = [...selection];
      const g0 = ids2.length ? groupOf(ids2[0]) : null;
      const sameGroup = !!g0 && ids2.every((id) => groupOf(id) === g0);
      barBtn(sameGroup ? /⛓ Ungroup/ : /🔗 Group/, sameGroup ? null : /⛓ Ungroup/);
    }
    else if (k === "h") barBtn(/Hide selected/);
    else if (k === "k") barBtn(/Center on children/);
    else if (k === "p") barBtn(/Center on parents/);
  });
  function updateViewSwitcher() {
    const sec = document.getElementById("viewSwitchSec");
    const tb = document.getElementById("tbViews");
    const has = (state.views || []).length > 0;
    if (tb) tb.hidden = !has;
    if (!sec) return;
    sec.hidden = !has;
    if (has) buildViewSwitchList(document.getElementById("viewSwitchList"), () => { const m = $("#peopleMenu"); if (m) m.hidden = true; });
  }
  function openViewSheet() {
    const back = document.createElement("div"); back.className = "pcard-back"; back.id = "viewSheetBack";
    const card = document.createElement("div"); card.className = "pcard vsheet"; back.appendChild(card);
    const head = document.createElement("div"); head.className = "pcard-head";
    const h = document.createElement("h2"); h.textContent = "Views"; h.style.margin = "0"; head.appendChild(h);
    const x = document.createElement("button"); x.className = "pcard-x"; x.textContent = "✕"; x.onclick = () => back.remove(); head.appendChild(x);
    card.appendChild(head);
    const list = document.createElement("div"); list.className = "pcard-body"; card.appendChild(list);
    buildViewSwitchList(list, () => back.remove());
    back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
    document.body.appendChild(back);
  }
  function startViewPreview(view, temporary) {
    try { localStorage.setItem("familyTree.currentView", view.id); } catch (e) {}
    viewPreview = { view, set: viewMembers(view.rules, view.withHidden, view.hide) };
    // Switching views is a normal mode — the ☰ menu is the way in AND out, so
    // no pop-up bar. Only the fleeting Preview from the view editor gets one.
    const old = document.getElementById("viewScopeBar"); if (old) old.remove();
    if (temporary) {
      const bar = document.createElement("div"); bar.id = "viewScopeBar";
      bar.innerHTML = '<span class="vsb-text">Previewing view: <b></b></span><button type="button" id="vsbDone">Done</button>';
      document.body.appendChild(bar);
      bar.querySelector("#vsbDone").onclick = endViewPreview;
      bar.querySelector(".vsb-text b").textContent = view.name || "Untitled";
    }
    render(); fitView();
  }
  function endViewPreview() {
    try { localStorage.removeItem("familyTree.currentView"); } catch (e) {}
    viewPreview = null;
    const bar = document.getElementById("viewScopeBar"); if (bar) bar.remove();
    render(); fitView();
  }
  function openViewsModal() {
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = `<div class="modal"><h2>Views</h2>
      <p class="hint">A view is a slice of the family tree you can share on its own password. Whoever enters that password at the lock screen sees only that slice, view-only.</p>
      <div id="viewsList"></div>
      <div class="btn-row" style="margin-top:10px">
        <button type="button" class="btn" data-cancel>Close</button>
        <button type="button" class="btn" id="vPublish">☁︎ Publish views now</button>
        <button type="button" class="btn primary" id="vNew">＋ New view</button>
      </div></div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.querySelector("[data-cancel]").onclick = close;
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    const listEl = back.querySelector("#viewsList");
    const renderList = () => {
      listEl.textContent = "";
      const views = state.views || [];
      if (!views.length) { listEl.innerHTML = '<p class="hint">No views yet — create one, add people to it by rule, give it a password, then publish.</p>'; return; }
      views.forEach((v) => {
        const row = document.createElement("div"); row.className = "view-row";
        const n = viewMembers(v.rules, v.withHidden).size;
        const info = document.createElement("span"); info.className = "view-info";
        info.innerHTML = "<b></b><span class='view-meta'></span>";
        info.querySelector("b").textContent = v.name || "Untitled";
        info.querySelector(".view-meta").textContent = " — " + n + " people" + (v.pass ? " · password set" : " · no password yet");
        const bPrev = document.createElement("button"); bPrev.className = "btn small"; bPrev.textContent = "Preview";
        bPrev.onclick = () => { close(); startViewPreview(v, true); };
        const bEdit = document.createElement("button"); bEdit.className = "btn small"; bEdit.textContent = "Edit";
        bEdit.onclick = () => { close(); openViewEditModal(v); };
        const bDel = document.createElement("button"); bDel.className = "btn small danger"; bDel.textContent = "Delete";
        bDel.onclick = () => {
          if (!confirm("Delete the view “" + (v.name || "Untitled") + "”? (No people are deleted — only the view.)")) return;
          state.views = (state.views || []).filter((x) => x.id !== v.id);
          save(); renderList();
          fetch("api/store", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "deleteView", passcode: (localStorage.getItem("familyTree.importPass") || ""), id: v.id }) }).catch(() => {});
        };
        row.appendChild(info); row.appendChild(bPrev); row.appendChild(bEdit); row.appendChild(bDel);
        listEl.appendChild(row);
      });
    };
    renderList();
    back.querySelector("#vNew").onclick = () => { close(); openViewEditModal(null); };
    back.querySelector("#vPublish").onclick = async () => {
      const b = back.querySelector("#vPublish"); b.disabled = true; b.textContent = "Publishing…";
      try {
        const r = await publishViews(true);
        if (r.n) toast("Published " + r.n + " view" + (r.n > 1 ? "s" : "") + " ✓ — share each view’s password");
        else if (r.why === "nopass") toast("Publishing needs the import passcode — click Publish again and enter it when asked");
        else toast("Nothing to publish — a view needs people and a share password");
      }
      catch (e) { toast("Publishing views failed — " + e.message); }
      b.disabled = false; b.textContent = "☁︎ Publish views now";
    };
  }
  function openViewEditModal(existing) {
    const v = existing || { id: "v" + Math.random().toString(36).slice(2, 8), name: "", pass: "", rules: [], withHidden: [] };
    const rules = (v.rules || []).map((r) => Object.assign({}, r));
    let withHidden = (v.withHidden || []).slice();
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = `<div class="modal"><h2>${existing ? "Edit view" : "New view"}</h2>
      <label class="field"><span>View name</span><input type="text" id="vName" placeholder="e.g. The Reiners branch"/></label>
      <label class="field"><span>Share password (viewers type this to open the view)</span><input type="text" id="vPass" placeholder="e.g. ReinersTree"/></label>
      <label class="field"><span>Who’s in this view</span></label>
      <div id="vRules"></div>
      <div class="view-addrule">
        <select id="vPerson"></select>
        <select id="vMode">
          <option value="family">+ everyone related to them</option>
          <option value="immediate">+ their immediate family (parents, siblings, partner, children)</option>
          <option value="descendants">+ all their descendants</option>
          <option value="ancestors">+ their whole family line (up to the oldest ancestor, then everyone down from them)</option>
          <option value="direct">+ only their direct ancestors (parents, grandparents… nobody else)</option>
        </select>
        <button type="button" class="btn small" id="vAddRule">Add</button>
      </div>
      <div id="vHiddenSec" hidden><label class="field"><span>Hidden branches under people in this view</span></label><div id="vHidden"></div></div>
      <div id="vDroppedSec" hidden><label class="field"><span>Hidden from this view</span></label><div id="vDropped"></div></div>
      <p class="hint" id="vCount"></p>
      <div class="btn-row" style="margin-top:10px">
        <button type="button" class="btn" data-cancel>Cancel</button>
        <button type="button" class="btn" id="vPreviewBtn">Preview</button>
        <button type="button" class="btn primary" id="vSave">Save view</button>
      </div></div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.querySelector("[data-cancel]").onclick = () => { close(); openViewsModal(); };
    back.addEventListener("click", (e) => { if (e.target === back) { close(); openViewsModal(); } });
    back.querySelector("#vName").value = v.name || "";
    back.querySelector("#vPass").value = v.pass || "";
    const sel = back.querySelector("#vPerson");
    state.persons.slice().sort((a, b) => (a.name || "").localeCompare(b.name || "")).forEach((p) => {
      if (isHidden(p.id)) return;
      const o = document.createElement("option"); o.value = p.id; o.textContent = p.name || "Unnamed"; sel.appendChild(o);
    });
    const modeWord = { family: "everyone related", immediate: "immediate family", descendants: "all descendants", ancestors: "their whole family line", direct: "direct ancestors only" };
    const rulesEl = back.querySelector("#vRules"), countEl = back.querySelector("#vCount");
    const hidSec = back.querySelector("#vHiddenSec"), hidEl = back.querySelector("#vHidden");
    const renderHiddenChoices = () => {
      const choices = rules.length ? viewHiddenChoices(rules) : [];
      withHidden = withHidden.filter((uid) => choices.some((c) => c.union === uid));   // drop choices whose couple left the view
      hidSec.hidden = !choices.length;
      hidEl.textContent = "";
      choices.forEach((c) => {
        const row = document.createElement("label"); row.className = "view-hidden-row";
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = withHidden.includes(c.union);
        cb.onchange = () => {
          if (cb.checked) { if (!withHidden.includes(c.union)) withHidden.push(c.union); }
          else withHidden = withHidden.filter((x) => x !== c.union);
          updateCount();
        };
        const t = document.createElement("span");
        t.textContent = "Show the hidden branch under " + c.label + " (" + c.count + (c.count === 1 ? " person)" : " people)");
        row.appendChild(cb); row.appendChild(t); hidEl.appendChild(row);
      });
    };
    // People taken out of this view by hand (via "Hide from this view") — each
    // can be put back here.
    let dropped = Array.isArray(v.hide) ? v.hide.slice() : [];
    const dropSec = back.querySelector("#vDroppedSec"), dropEl = back.querySelector("#vDropped");
    const renderDropped = () => {
      dropped = dropped.filter((id) => personById(id));
      dropSec.hidden = !dropped.length;
      dropEl.textContent = "";
      dropped.forEach((id) => {
        const row = document.createElement("div"); row.className = "view-drop-row";
        const t = document.createElement("span"); t.textContent = (personById(id) || {}).name || "Someone";
        const b = document.createElement("button"); b.type = "button"; b.className = "btn small"; b.textContent = "Put back";
        b.onclick = () => { dropped = dropped.filter((x) => x !== id); renderDropped(); updateCount(); };
        row.appendChild(t); row.appendChild(b); dropEl.appendChild(row);
      });
    };
    const updateCount = () => { countEl.textContent = rules.length ? viewMembers(rules, withHidden, dropped).size + " people in this view so far." : ""; };
    const renderRules = () => {
      rulesEl.textContent = "";
      if (!rules.length) rulesEl.innerHTML = '<p class="hint">No one yet — pick a person below and add a rule.</p>';
      rules.forEach((r, i) => {
        const row = document.createElement("div"); row.className = "view-rule";
        const t = document.createElement("span");
        t.textContent = ((personById(r.person) || {}).name || "?") + " — " + (modeWord[r.mode] || r.mode);
        const x = document.createElement("button"); x.className = "btn small"; x.textContent = "✕";
        x.onclick = () => { rules.splice(i, 1); renderRules(); };
        row.appendChild(t); row.appendChild(x); rulesEl.appendChild(row);
      });
      renderHiddenChoices();
      updateCount();
    };
    renderRules(); renderDropped();
    back.querySelector("#vAddRule").onclick = () => { if (sel.value) { rules.push({ person: sel.value, mode: back.querySelector("#vMode").value }); renderRules(); } };
    const collect = () => { v.name = back.querySelector("#vName").value.trim(); v.pass = back.querySelector("#vPass").value.trim(); v.rules = rules; v.withHidden = withHidden; v.hide = dropped; };
    back.querySelector("#vPreviewBtn").onclick = () => { collect(); close(); startViewPreview(v, true); };
    back.querySelector("#vSave").onclick = () => {
      collect();
      if (!v.name) { toast("Give the view a name"); return; }
      if (!state.views) state.views = [];
      const i = state.views.findIndex((x) => x.id === v.id);
      if (i >= 0) state.views[i] = v; else state.views.push(v);
      save(); close(); openViewsModal();
      toast("View saved" + (v.pass ? " — use “Publish views now” to put it on your site" : " — add a share password to publish it"));
    };
  }

  async function init() {
    buildColorSwatches();
    setSex("male");
    setColor("");
    renderDocsForm(null);
    setTimeout(checkTokenHealth, 4000);   // after boot settles; runs on every path
    await loadLocalData();   // pull the saved tree out of IndexedDB (roomy, no server)
    const params = new URLSearchParams(location.search);
    const wantEdit = params.has("edit");
    // Cross-device sync: even when this browser has a local copy, check whether
    // the cloud has a newer one (e.g. edits made on another device) and pull it in
    // so the tree isn't a stale local snapshot. This is what makes updates show up
    // on your phone.
    // …but never make the first paint WAIT on the network: this device's saved
    // copy shows instantly, and if the cloud turns out to have something newer
    // it's swapped in (and re-drawn) seconds later.
    if (hasLocalData()) {
      setTimeout(() => { reconcileWithCloud(false).catch(() => {}); }, 250);
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
    // Any owner device (editing desktop OR read-only phone) with local edits
    // that haven't reached the cloud pushes them once now, so other devices can
    // pull the latest — and so the unsynced-edits flag clears instead of
    // wedging this device's pulls forever. Conflict guard: if the cloud has
    // moved past what this device last synced, don't blind-push over it — ask.
    if (ownerCanCloud()) {
      let dirty = ""; try { dirty = localStorage.getItem("familyTree.cloudDirty") || ""; } catch (e) {}
      // Unsynced edits from a previous visit: bring the two copies together
      // rather than picking a winner — the merge keeps whatever either side has,
      // and the save that follows is version-checked.
      if (dirty === "1") setTimeout(() => { reconcileWithCloud(false).catch(() => {}); }, 1200);
    }
  }

  init();
})();
