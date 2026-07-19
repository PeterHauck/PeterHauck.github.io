/* Starting point for the family tree, loaded when there's no saved work yet.
 * Seeded from Tania Goos's obituary (Peter is her grandson, via his father).
 *
 * The obituary text couldn't be fetched automatically, so the LINK is attached
 * to Tania's profile as a placeholder. Paste the obituary text (or use the
 * in-app "Add people from an obituary" import once Vercel is live) to fill in
 * the rest of the family and save a durable copy.
 *
 * Once you edit anything, your work is saved in this browser and this starter
 * no longer loads. */
window.FAMILY_TREE_STARTER = {
  title: "Our Family Tree",
  subtitle: "Started from Tania Goos's obituary",
  persons: [
    {
      id: "tania",
      name: "Tania Goos",
      sex: "female",
      birth: null,
      death: null,
      photo: null,
      docs: [
        {
          id: "obit_tania",
          title: "Obituary — Spitzer Funeral Home",
          url: "https://www.spitzerfuneralhome.com/obituaries/Tania-Goos?obId=173128",
          capturedAt: "2026-07-19",
          kind: "link",
          content: "",
        },
      ],
    },
    { id: "dad", name: "Peter's Father (edit me)", sex: "male", birth: null, death: null, photo: null, docs: [] },
    { id: "peter", name: "Peter Hauck", sex: "male", birth: null, death: null, photo: null, docs: [] },
  ],
  unions: [
    { id: "u_tania", a: "tania", b: null, status: "married" },
    { id: "u_dad", a: "dad", b: null, status: "married" },
  ],
  links: [
    { id: "l_dad", union: "u_tania", child: "dad", type: "bio" },
    { id: "l_peter", union: "u_dad", child: "peter", type: "bio" },
  ],
  manual: {},
};
