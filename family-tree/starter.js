/* Starting point for the family tree, loaded when there's no saved work yet.
 * Built from Tania Goos's obituary (Spitzer-Miller Funeral Home, Nov 2012).
 * Peter is her grandson; the obituary text is archived on Tania's profile.
 *
 * A few connections are best-guesses from the obituary and are noted below —
 * edit them to match what you know:
 *   • Peter is placed as a child of Bill & Kristi Hauck (both of Sioux Falls).
 *     If Peter's parent is Michael instead, just move him.
 *   • William E. Hauck (first husband) isn't marked deceased — the 2012
 *     obituary doesn't say. Mark him if appropriate.
 *   • Step relationships (Reiners/Straatmeyer side) are modeled from the
 *     obituary's wording; adjust half/step details as needed.
 *
 * Once you edit anything, your work saves in this browser and this starter
 * stops loading. To reload it fresh, use "Clear everything" in the editor. */

var TANIA_OBIT = `Funeral service for Tania Goos, 78, Aberdeen, SD, is 11:00 am, Wednesday, November 28, 2012 at First Assembly of God Church, 1424 24th Ave NW, Aberdeen, Pastor Drew Becker officiating. Tania died Sunday, November 25, at her home.

Visitation is 1-7 pm, Tuesday, November 27, with a prayer service at 7 pm at Spitzer-Miller Funeral Home, 1111 S. Main St. In lieu of flowers the family prefers memorials to Freedom Worship Center Building Fund.

Tania J. Goos was born in Sioux Falls, SD on December 22, 1933 to Cecil and Elvera (Larson) Wheeldon. She graduated from Washington High School with the class of 1952 and attended Augustana College and Sioux Valley Hospital School of Nursing. She married William E. Hauck on December 26, 1962. They moved to Denver, CO where Tania was a loan closing officer with Beneficial Mortgage Company. The family moved back to South Dakota where Tania attended the University of South Dakota and received her B.S. degree in Elementary Education in 1965. She taught first grade at Longfellow School in Sioux Falls until the family moved to Aberdeen, SD. Tania taught Title I Remedial and Developmental Reading at O.M. Tiffany School in Aberdeen. She received her M.S. degree in Special Education from Northern State College (University) in Aberdeen. Tania was a Real Estate Broker for Leisen Realty and Roberts-Nichols Realty. The family moved to Denton, Texas where they were involved in building Super 8 Motels. There Tania substitute taught in Special Education. The family later moved to Sioux Falls, SD and then back to Aberdeen. Tania owned and managed Agape Christian Bookstore in Aberdeen. Later she was a sales associate for H.H. Hoffman Realty in Aberdeen.

She married Robert S. Goos on March 12, 1988 in Aberdeen, SD. Together they owned, managed and maintained rental properties in Aberdeen. Tania and Bob were active in their churches and helped plant Freedom Worship Center. Their biggest joy was in serving the Lord together.

Tania accepted Jesus as her personal Savior in November of 1972. Jesus baptized her in the Holy Spirit in December of 1975. After receiving Jesus, she came to know the real love and peace and joy that we are promised in His Word. He filled her with His divine love, and it was always her prayer that His love would flow freely through her to others. She was active as a Sunday school teacher, Bible Study Leader, Nursery Worker and as an elder's wife. She and Bob also ministered in a nursing home.

Grateful for having shared Tania's life are her husband, Bob Goos, Aberdeen; her children, Michael Hauck, Bill (Kristi) Hauck, both of Sioux Falls, and Peggy (Todd) McCaghy of Papillion, NE; three step-children, Anne (Dennis) Dow, Leawood, KS, David (Norma) Goos, Lake City, FL, and Robert Jay (Marilyn) Goos, Fargo, ND; six grandchildren, ten step-grandchildren, fifteen step great-grandchildren; two sisters, Peggy Herrmann (Si Nieber), Watertown, SD, and Rhonda (Marvin) Buckneburg, Sioux Falls; step-sister, Marcine (Alvin) Straatmeyer of Gilbert, AZ; step-brother, Don Reiners; and many nieces and nephews.

Tania was preceded in death by her mother and father, Cecil and Elvera Wheeldon, her step-father, Dick H. Reiners, and sister Audrey Reiners.

Official Obituary of Tania Goos — December 22, 1933 – November 25, 2012.
Spitzer-Miller Funeral Home, 1111 South Main Street, Aberdeen, SD 57401 · (605) 225-8223.`;

function P(id, name, sex, opts) {
  opts = opts || {};
  return { id, name, sex, birth: opts.birth || null, death: opts.death || null, deceased: !!opts.deceased, photo: null, docs: opts.docs || [] };
}
function U(id, a, b, status) { return { id, a, b: b || null, status: status || "married" }; }
function L(union, child, type) { return { id: "l_" + union + "_" + child, union, child, type: type || "bio" }; }

window.FAMILY_TREE_STARTER = {
  title: "The Hauck / Goos Family",
  subtitle: "Started from Tania Goos's obituary",
  persons: [
    // Tania's parents / step-father
    P("cecil", "Cecil Wheeldon", "male", { deceased: true }),
    P("elvera", "Elvera (Larson) Wheeldon", "female", { deceased: true }),
    P("dick", "Dick H. Reiners", "male", { deceased: true }),
    // Tania
    P("tania", "Tania Goos", "female", {
      birth: 1933, death: 2012,
      docs: [{ id: "obit_tania", title: "Obituary — Spitzer-Miller Funeral Home", url: "https://www.spitzerfuneralhome.com/obituaries/Tania-Goos?obId=173128", capturedAt: "2026-07-19", kind: "text", content: TANIA_OBIT }],
    }),
    // Tania's siblings
    P("audrey", "Audrey Reiners", "female", { deceased: true }),
    P("peggyH", "Peggy Herrmann", "female"),
    P("si", "Si Nieber", "male"),
    P("rhonda", "Rhonda Buckneburg", "female"),
    P("marvin", "Marvin Buckneburg", "male"),
    P("marcine", "Marcine Straatmeyer", "female"),
    P("alvin", "Alvin Straatmeyer", "male"),
    P("don", "Don Reiners", "male"),
    // Tania's husbands
    P("wm", "William E. Hauck", "male"),
    P("bob", "Robert S. “Bob” Goos", "male"),
    // Tania's children (Hauck)
    P("michael", "Michael Hauck", "male"),
    P("bill", "Bill Hauck", "male"),
    P("kristi", "Kristi Hauck", "female"),
    P("peggyM", "Peggy McCaghy", "female"),
    P("todd", "Todd McCaghy", "male"),
    // Bob's children (Tania's step-children)
    P("anne", "Anne Dow", "female"),
    P("dennis", "Dennis Dow", "male"),
    P("david", "David Goos", "male"),
    P("norma", "Norma Goos", "female"),
    P("robertjay", "Robert Jay Goos", "male"),
    P("marilyn", "Marilyn Goos", "female"),
    // Grandson
    P("peter", "Peter Hauck", "male"),
  ],
  unions: [
    U("u_wheeldon", "cecil", "elvera"),
    U("u_reiners", "elvera", "dick"),
    U("u_dickprior", "dick", null),
    U("u_hauck", "tania", "wm"),
    U("u_goos", "tania", "bob"),
    U("u_bobprior", "bob", null),
    U("u_peggyH", "peggyH", "si"),
    U("u_rhonda", "rhonda", "marvin"),
    U("u_marcine", "marcine", "alvin"),
    U("u_bill", "bill", "kristi"),
    U("u_peggyM", "peggyM", "todd"),
    U("u_anne", "anne", "dennis"),
    U("u_david", "david", "norma"),
    U("u_robertjay", "robertjay", "marilyn"),
  ],
  links: [
    L("u_wheeldon", "tania"), L("u_wheeldon", "peggyH"), L("u_wheeldon", "rhonda"),
    L("u_reiners", "audrey"),
    L("u_dickprior", "don"), L("u_dickprior", "marcine"),
    L("u_hauck", "michael"), L("u_hauck", "bill"), L("u_hauck", "peggyM"),
    L("u_bobprior", "anne"), L("u_bobprior", "david"), L("u_bobprior", "robertjay"),
    L("u_bill", "peter"),
  ],
  manual: {},
};
