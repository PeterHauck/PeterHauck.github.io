/* Starting point for the family tree, loaded when there's no saved work yet.
 * Built from Tania Goos's obituary (Spitzer-Miller Funeral Home, Nov 2012).
 * Peter is her grandson; the obituary text is archived on Tania's profile.
 *
 * A few connections are best-guesses from the obituary and are noted below —
 * edit them to match what you know:
 *   • Peter's parents are Michael (Mike) Hauck and Allison Boyd (divorced);
 *     Michael has since married Jessica (Grams) Hauck. Peter's maternal line is
 *     Allison → Mary (Eide) Boyd → Palmer Eide. Peter's sister is Lauren
 *     (Hauck) Glover, married to Danny Glover (daughters Maisy & Willa).
 *   • Families are colour-coded (Hauck blue, Tania's Wheeldon side brown, Goos
 *     green, Fuchs teal, Miller gold, Peter's mother's Boyd/Eide side crimson);
 *     people who married in stay neutral.
 *   • Alicen (Peter's wife) is a daughter of Lisa Miller (Alicen's mother, now
 *     divorced from Lee Whiting) — connecting Alicen's maternal side (the Fuchs
 *     / Miller family). Her other 15 Fuchs grandchildren-cousins aren't added.
 *   • Tania & William Hauck are shown divorced (both remarried in 1988 per
 *     his memorial); his profile carries the Find a Grave memorial text.
 *   • Step/half relationships (Reiners/Straatmeyer and the Hauck half-siblings
 *     via Valentine's earlier marriage) are modeled from the sources' wording;
 *     adjust as needed.
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

var WM_MEMORIAL = `William E. "Bill" Hauck — Birth: 23 Jun 1934, Aberdeen, Brown County, South Dakota. Death: 23 May 1991 (aged 56), Sioux Falls, Minnehaha County, South Dakota. Burial: Saint Johns Lutheran Church Cemetery, Aberdeen, SD. Find a Grave Memorial ID 120694670.

MINA — The funeral for William "Bill" E. Hauck, 56, of Mina and a former Aberdeen mayor and businessman, will be at 11 a.m. Monday at St. Paul's Lutheran Church, 214 Seventh Ave. S.W. The Rev. Ronald Laue will officiate. Visitation will be from 3 p.m. to 9 p.m. Sunday at Miller-Huebl Funeral Home, 1111 S. Main St., and one hour prior to the service Monday at the church. He died Thursday, May 23, 1991, of natural causes at Sioux Valley Hospital in Sioux Falls.

William E. Hauck was born June 23, 1934, to Valentine F. and Mary K. (Kessler) Hauck at Aberdeen. He graduated from Central High School in 1952. He was an outstanding athlete and was the state 100 yard dash champion. He served in the Naval Cadets from 1952 to 1954. In 1958 he received a business administration degree from the University of South Dakota in Vermillion. He was named a Little All-American for his achievements as a halfback on the USD football team. Following college, he was a salesman for Pfizer Pharmaceutical for five years.

He married Tania J. Wheeldon on Dec. 26, 1962, in Sioux Falls. He returned to USD, where he received a juris doctorate degree in 1966. Following law school, he worked as a trust officer at the National Bank of South Dakota in Sioux Falls. He returned to Aberdeen, where he began a private law practice and entered politics. He was elected to the Brown County Commission in 1968 and served as mayor of Aberdeen from 1969 to 1972. During his term as mayor, he initiated the sales tax that widened Dakota Street and reopened Wylie Park. He also was instrumental in developing Aberdeen's Industrial Park. He sold real estate for Harley Hoffman Realty until 1972. He was appointed by Gov. Richard Kneip as director of South Dakota Job Service. In 1978 he moved to Denton, Texas, where he started developing Super 8 Motels. In 1981 he returned to South Dakota. He remained active in motel development and became a partial owner of Idea Development Inc.

He married Evelyn Lester Orr on Oct. 21, 1988, in Sioux Falls. He was an avid hunter, fisherman and owned interests in pheasant and goose farms. He was a member of Pheasants Forever, Sigma Alpha Epsilon Fraternity, USD Alumni Association and USD Letter Club.

Survivors include his wife of Mina; his mother of Aberdeen; two sons, Michael Hauck of Sioux Falls, and Bill Hauck Jr. of Aberdeen; two stepsons, Nolan Orr and Robert Orr, both of Aberdeen; one daughter, Peggy Hauck, of Aberdeen; three stepdaughters, Mrs. Ben (Susan) Michaud of Atlanta, Ga., Kerry Orr of Albuquerque, N.M., and Angie Persing of Sioux Falls; one brother, Jerry A. Hauck of Sioux Falls; two half brothers, Barney Hauck of Sioux Falls and Fritz Hauck of Omaha, Neb.; four sisters, Mrs. Bill (Donna) Izlar of Atlanta, Mrs. Eugene (Joann) Edison of Kansas City, Mo., Mrs. Jack (Janice) Schuver, and Mrs. Terry (Cynthia) Slattery, both of Sioux Falls; two half sisters, Mrs. John (Teresa) Ressa of Spokane, Wa., and Mrs. Bob (Marian) Unkrur of Tacoma, Wa.; and one granddaughter.

He was preceded in death by his father, one brother and one half brother.

— Aberdeen (SD) American News, Sunday, May 26, 1991, Page 2B.

Family (Find a Grave): Parents — Valentine Felix Hauck (1894–1974), Mary A. Kessler Hauck (1906–1994). Spouse — Evelyn M. "Evie" Lester Orr Hauck (1932–2013, m. 1988). Siblings — Teresa Elma Hauck Ressa (1924–1999), Donna Hauck Izlar (1930–2019), James Michael Hauck (1944–1987). Half siblings — Sgt Bernard J. Hauck (1920–2008), Francis Joseph "Fritz" Hauck (1923–2015).`;

var HARLAN_OBIT = `Fuchs, Harlan J., age 79, formerly of Ramsey, passed away peacefully Aug. 5, 2014 surrounded by family. Preceded in death by parents, Edward and Alice, and a grandson. "Foxy" will be missed by his wife of 56 years, Darleen; children, Lisa Whiting (Lee), Linda Oie (Tim), Debra Delaney (Bill), Dave Fox (Karla) and Christine Drasher (Tom); 16 grandchildren and 2 great-grandchildren; siblings, Conrad Fuchs, Alice Bushnell and Delores Holt; and many nieces, nephews and friends. Proudly served in the USMC. Member of Anoka American Legion Post 102.

Visitation at the church 3-6 PM Sunday, Aug. 10 and one hour prior to service on Monday. Funeral service 11 AM Monday, Aug. 11, all at St. John Lutheran Church, 9231 Viking Blvd., Nowthen. Private interment. Memorials are preferred. Washburn-McReavy Funeral Chapels, Coon Rapids Chapel.`;

var DARLEEN_OBIT = `Fuchs, Darleen G., age 77, formerly of Ramsey, passed away peacefully June 2, 2016 surrounded by her family. She is free now to walk through Heaven's gardens after a 40-year struggle with Multiple Sclerosis. Preceded in death by husband of 56 years, Harlan; parents, Arthur & Myrtle Miller; a grandson; brothers, Melvin and Lloyd; and sister, Mildred.

Survived by children, Lisa Whiting (Lee), Linda Oie (Tim), Debra Delaney (Bill), David Fox (Karla) and Christine Drasher (Tom); grandchildren, Melissa (Alex), Sarah (Tyler), Justin (Amanda), Alysha, Emily, Matthew, Jonathan, Alicen, Jake, Laura, Cassandra, Hannah, Mitchell, Kaylee, Madelynn and Alexandra; great-grandchildren, Branden, Brynn, Adley, Camryn and Christian; siblings, Marvel Gorham, Inez Quist, Doris Springer, Kenneth Miller and Robert Miller; and many nieces, nephews, family and friends.

Funeral service 12 noon Tuesday, June 7 at St. John Lutheran Church, 9231 Viking Blvd., Nowthen. Visitation one hour prior to service at church. Private interment. Memorials preferred to the MS Society. Washburn-McReavy Funeral Chapels, Coon Rapids Chapel.`;

var PALMER_OBIT = `Artist, scholar Eide dies at 85 — Sioux Falls.

Palmer Eide, 85, 201 W. 33rd, died Thursday, Aug. 29, in Sioux Valley Hospital.

Dr. Eide was born July 5, 1906, in Sioux Falls. He graduated from Augustana Academy and received his Bachelor of Arts from Augustana College. He attended the Art Institute in Chicago, Ill., Harvard University, Yale University and Cranbrook Academy of Art.

In 1931, he was art instructor at Augustana College and retired in 1971 as professor of art and chairman of the art department. He was visiting Fulbright professor of industrial design at the National College of Art in Lahore, Pakistan, from 1964 to 1965. He was visiting sculptor at Northern Arizona University from 1979 to 1981.

Honors and recognitions he received throughout his lifetime include: from Art Students' League, Art Institute; American Institute of Architects scholarship to Harvard; fellowship, Yale University; Who's Who in American Art; Augustana College Alumni Achievement Award, 1962; honorary doctor of fine arts degree, St. Olaf College, 1968; and the Biennial Governor's Award in the Arts, 1976. His works and art were widely published and exhibited, including at the Chicago Art Institute and the Walker Art Gallery, Minneapolis.

He married Esther Hockenstad on Sept. 1, 1934, in Sioux Falls. She died in 1978. He married Marie Bresee on Nov. 19, 1980, in Sioux Falls.

Survivors include his wife; three sons: Peter, Bullhead City, Ariz.; James Berdahl, Houston, Texas; and Alan Berdahl, Hills, Minn.; one daughter, Mrs. Bruce (Mary) Boyd, Sioux Falls; eight grandchildren; and two great-grandchildren.

Services will be at 1:30 p.m. Monday in First Lutheran Church in Sioux Falls with burial in West Nidaros Cemetery, rural Crooks. Memorials may be directed to Palmer Eide Art Scholarship at Augustana College.

— Argus Leader (Sioux Falls, SD), via Newspapers.com. (Palmer Eide, July 5, 1906 – Aug. 29, 1991.)`;

function P(id, name, sex, opts) {
  opts = opts || {};
  return { id, name, sex, birth: opts.birth || null, death: opts.death || null, deceased: !!opts.deceased, color: opts.color || null, photo: null, docs: opts.docs || [] };
}
function U(id, a, b, status) { return { id, a, b: b || null, status: status || "married" }; }
function L(union, child, type) { return { id: "l_" + union + "_" + child, union, child, type: type || "bio" }; }

window.FAMILY_TREE_STARTER = {
  // Bump this whenever the tree data below changes. On load, a higher version
  // here beats an older copy saved in the browser, so updates always show and a
  // stale local copy can't get "stuck".
  version: 3,
  title: "The Hauck / Goos Family",
  subtitle: "Started from Tania Goos's obituary",
  persons: [
    // Tania's parents / step-father
    P("cecil", "Cecil Wheeldon", "male", { deceased: true }),
    P("elvera", "Elvera (Larson) Wheeldon", "female", { deceased: true }),
    P("dick", "Dick H. Reiners", "male", { deceased: true }),
    // William's parents (Peter's paternal great-grandparents)
    P("valentine", "Valentine F. Hauck", "male", { birth: 1894, death: 1974, deceased: true }),
    P("maryk", "Mary A. (Kessler) Hauck", "female", { birth: 1906, death: 1994, deceased: true }),
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
    P("wm", "William E. “Bill” Hauck", "male", {
      birth: 1934, death: 1991, deceased: true,
      docs: [{ id: "mem_wm", title: "Find a Grave — William E. “Bill” Hauck", url: "https://www.findagrave.com/memorial/120694670", capturedAt: "2026-07-19", kind: "text", content: WM_MEMORIAL }],
    }),
    P("evelyn", "Evelyn “Evie” (Lester) Orr Hauck", "female", { birth: 1932, death: 2013, deceased: true }),
    P("bob", "Robert S. “Bob” Goos", "male"),
    // Tania's children (Hauck)
    P("michael", "Michael (Mike) Hauck", "male"),
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
    // William's siblings (children of Valentine & Mary)
    P("jerry", "Jerry A. Hauck", "male"),
    P("jamesm", "James Michael Hauck", "male", { birth: 1944, death: 1987, deceased: true }),
    P("donna", "Donna (Hauck) Izlar", "female", { birth: 1930, death: 2019, deceased: true }),
    P("joann", "Joann (Hauck) Edison", "female"),
    P("janice", "Janice (Hauck) Schuver", "female"),
    P("cynthia", "Cynthia (Hauck) Slattery", "female"),
    // William's half-siblings (Valentine's children from an earlier marriage)
    P("teresa", "Teresa (Hauck) Ressa", "female", { birth: 1924, death: 1999, deceased: true }),
    P("barney", "Bernard “Barney” J. Hauck", "male", { birth: 1920, death: 2008, deceased: true }),
    P("fritz", "Francis “Fritz” Hauck", "male", { birth: 1923, death: 2015, deceased: true }),
    P("marian", "Marian (Hauck) Unkrur", "female"),
    // Grandson
    P("peter", "Peter Hauck", "male"),

    // ---- Peter's mother's side (Boyd / Eide) ----
    P("allison", "Allison Boyd", "female"),        // Peter's mother (divorced from Michael)
    P("bruceBoyd", "Bruce Boyd", "male"),          // Allison's father
    P("maryBoyd", "Mary (Eide) Boyd", "female"),   // Allison's mother
    P("palmer", "Palmer Eide", "male", { birth: 1906, death: 1991, deceased: true,
      docs: [{ id: "obit_palmer", title: "Obituary — Argus Leader (Newspapers.com)", url: "", capturedAt: "2026-07-19", kind: "text", content: PALMER_OBIT }] }),
    P("esther", "Esther (Hockenstad) Eide", "female", { death: 1978, deceased: true }), // Mary's mother
    // Allison's brother (Peter's uncle) and his family
    P("aaron", "Aaron Boyd", "male"),
    P("shannon", "Shannon Boyd", "female"),
    P("josie", "Josephine (Josie) Boyd", "female"),
    P("palmerBoyd", "Palmer Boyd", "male"),
    // Michael's current wife
    P("jessica", "Jessica (Grams) Hauck", "female"),
    // ---- Peter's sister and her family (Glover) ----
    P("lauren", "Lauren (Hauck) Glover", "female"),
    P("danny", "Daniel “Danny” Glover", "male"),
    P("maisy", "Maisy Glover", "female"),
    P("willa", "Willa Glover", "female"),
    // Peter's cousins on his dad's side (Bill & Kristi Hauck's sons)
    P("tanner", "Tanner Hauck", "male"),
    P("hunter", "Hunter Hauck", "male"),
    P("jack", "Jack Hauck", "male"),

    // ---- Alicen's side (Peter's wife) ----
    P("alicen", "Alicen Hauck", "female"),
    // Alicen's maternal grandparents (Fuchs) and their parents
    P("harlan", "Harlan J. “Foxy” Fuchs", "male", { birth: 1935, death: 2014, deceased: true,
      docs: [{ id: "obit_harlan", title: "Obituary — Washburn-McReavy", url: "https://www.washburn-mcreavy.com/obituaries/Harlan-Fuchs", capturedAt: "2026-07-19", kind: "text", content: HARLAN_OBIT }] }),
    P("darleen", "Darleen G. (Miller) Fuchs", "female", { birth: 1939, death: 2016, deceased: true,
      docs: [{ id: "obit_darleen", title: "Obituary — Washburn-McReavy", url: "https://www.washburn-mcreavy.com/obituaries/Darleen-Fuchs", capturedAt: "2026-07-19", kind: "text", content: DARLEEN_OBIT }] }),
    P("edwardf", "Edward Fuchs", "male", { deceased: true }),
    P("alicef", "Alice Fuchs", "female", { deceased: true }),
    P("arthurm", "Arthur Miller", "male", { deceased: true }),
    P("myrtlem", "Myrtle Miller", "female", { deceased: true }),
    // Harlan & Darleen's children (Alicen's mother + aunts/uncle)
    P("lisa", "Lisa Miller", "female"),
    P("lee", "Lee Whiting", "male"),
    P("linda", "Linda Oie", "female"),
    P("timo", "Tim Oie", "male"),
    P("debra", "Debra Delaney", "female"),
    P("billd", "Bill Delaney", "male"),
    P("davef", "David “Dave” Fox", "male"),
    P("karla", "Karla Fox", "female"),
    P("christine", "Christine Drasher", "female"),
    P("tomd", "Tom Drasher", "male"),
  ],
  unions: [
    U("u_wheeldon", "cecil", "elvera"),
    U("u_reiners", "elvera", "dick"),
    U("u_dickprior", "dick", null),
    U("u_haugp", "valentine", "maryk"),
    U("u_valprior", "valentine", null),
    U("u_hauck", "tania", "wm", "divorced"),
    U("u_wmEvelyn", "wm", "evelyn"),
    U("u_goos", "tania", "bob"),
    U("u_bobprior", "bob", null),
    U("u_peggyH", "peggyH", "si"),
    U("u_rhonda", "rhonda", "marvin"),
    U("u_marcine", "marcine", "alvin"),
    U("u_bill", "bill", "kristi"),
    U("u_michaelAllison", "michael", "allison", "divorced"),
    U("u_michaelJessica", "michael", "jessica"),
    U("u_peggyM", "peggyM", "todd"),
    U("u_anne", "anne", "dennis"),
    U("u_david", "david", "norma"),
    U("u_robertjay", "robertjay", "marilyn"),
    // Peter's mother's side (Boyd / Eide) and sister's family (Glover)
    U("u_maryBoyd", "bruceBoyd", "maryBoyd"),
    U("u_palmer", "palmer", "esther"),
    U("u_aaron", "aaron", "shannon", "divorced"),
    U("u_lauren", "danny", "lauren"),
    // Alicen's side
    U("u_peteralicen", "peter", "alicen"),
    U("u_edwardf", "edwardf", "alicef"),
    U("u_arthurm", "arthurm", "myrtlem"),
    U("u_fuchs", "harlan", "darleen"),
    U("u_lisa", "lisa", "lee", "divorced"),
    U("u_linda", "linda", "timo"),
    U("u_debra", "debra", "billd"),
    U("u_davef", "davef", "karla"),
    U("u_christine", "christine", "tomd"),
  ],
  links: [
    L("u_wheeldon", "tania"), L("u_wheeldon", "peggyH"), L("u_wheeldon", "rhonda"),
    L("u_reiners", "audrey"),
    L("u_dickprior", "don"), L("u_dickprior", "marcine"),
    L("u_haugp", "wm"), L("u_haugp", "jerry"), L("u_haugp", "jamesm"), L("u_haugp", "donna"), L("u_haugp", "joann"), L("u_haugp", "janice"), L("u_haugp", "cynthia"),
    L("u_valprior", "teresa"), L("u_valprior", "barney"), L("u_valprior", "fritz"), L("u_valprior", "marian"),
    L("u_hauck", "michael"), L("u_hauck", "bill"), L("u_hauck", "peggyM"),
    L("u_bobprior", "anne"), L("u_bobprior", "david"), L("u_bobprior", "robertjay"),
    L("u_bill", "tanner"), L("u_bill", "hunter"), L("u_bill", "jack"),
    L("u_michaelAllison", "peter"), L("u_michaelAllison", "lauren"),
    // Peter's mother's side (Boyd / Eide) and sister's family (Glover)
    L("u_palmer", "maryBoyd"),
    L("u_maryBoyd", "allison"), L("u_maryBoyd", "aaron"),
    L("u_aaron", "josie"), L("u_aaron", "palmerBoyd"),
    L("u_lauren", "maisy"), L("u_lauren", "willa"),
    // Alicen's side
    L("u_edwardf", "harlan"),
    L("u_arthurm", "darleen"),
    L("u_fuchs", "lisa"), L("u_fuchs", "linda"), L("u_fuchs", "debra"), L("u_fuchs", "davef"), L("u_fuchs", "christine"),
    L("u_lisa", "alicen"),
  ],
  manual: {},
  // Open centred on Peter & Alicen.
  focus: ["peter", "alicen"],
  // Hidden by default (data kept — "Show all" brings them back): only Bob Goos's
  // own children (and their spouses) from his prior marriage — step-family with
  // no blood relation to Tania. Tania's siblings/step-family and Bob himself (her
  // husband) stay visible.
  hidden: {
    anne: true, dennis: true, david: true, norma: true, robertjay: true, marilyn: true,
  },
};

// Family colours (people who married in stay neutral, so the birth families read
// clearly). Assigned by id so the person entries above stay readable.
(function () {
  var groups = {
    "#9e6b3f": ["cecil", "elvera", "dick", "tania", "audrey", "peggyH", "rhonda", "marcine", "don"], // Tania's Wheeldon/Reiners side (brown)
    "#2f6fb0": ["valentine", "maryk", "wm", "jerry", "jamesm", "donna", "joann", "janice", "cynthia", "teresa", "barney", "fritz", "marian", "michael", "bill", "peggyM", "peter", "lauren", "tanner", "hunter", "jack"], // Hauck (blue)
    "#3f8f5a": ["bob", "anne", "david", "robertjay"], // Goos (green)
    "#2a9d9d": ["edwardf", "alicef", "harlan", "lisa", "linda", "debra", "davef", "christine", "alicen"], // Fuchs (teal)
    "#bf8b30": ["arthurm", "myrtlem", "darleen"], // Miller (gold)
    "#b5495b": ["palmer", "esther", "maryBoyd", "allison", "aaron", "josie", "palmerBoyd"], // Peter's mother's side, Boyd / Eide (crimson)
  };
  var byId = {};
  window.FAMILY_TREE_STARTER.persons.forEach(function (p) { byId[p.id] = p; });
  Object.keys(groups).forEach(function (c) { groups[c].forEach(function (id) { if (byId[id]) byId[id].color = c; }); });
})();
