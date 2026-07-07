# The Dengler Family Tree

An interactive, single-page ancestor-tree website for the Dengler family, built as
a digital heirloom. It is a fully static site — no build step is required to view
it and it has **zero runtime dependencies** except Google Fonts.

## What it is

- A centered, generational ancestor tree (root person at the bottom on desktop; a
  vertically-stacked, indented outline on mobile).
- Collapsible/expandable branches, click-to-open person detail modals, a debounced
  keyboard-navigable search that expands and jumps to a person, and a persisted
  dark/light theme.
- **Collateral relatives** (uncles, aunts, grand-aunts — people in the data who are
  on nobody's direct ancestor line) don't get tree nodes, but they ARE searchable:
  selecting one opens their detail modal directly. Every modal has a **Family**
  section (Parents / Spouse / Children / Siblings) with clickable links that
  navigate modal-to-modal, and ancestor cards with off-line children show a subtle
  "+N more children" chip that opens the modal at the Family section.
- Built with **Tailwind CSS** (precompiled to a static stylesheet) and
  **vanilla JavaScript**. Custom heirloom detailing (paper texture, connectors,
  animations) lives in `css/custom.css`.
- **Password-protected.** No identifying family data is present on the page until a
  visitor unlocks the archive with a passphrase. The data ships **encrypted**
  (AES-256-GCM) and is decrypted in the browser with the Web Crypto API.

## Project layout

```
index.html          Page shell (relative asset paths for GitHub Pages project sites)
css/tailwind.css     Precompiled Tailwind utilities (committed; do not edit by hand)
css/custom.css       Heirloom styling layered on top of Tailwind
js/data.enc.js       window.FAMILY_DATA_ENC — encrypted family data (ciphertext only)
js/app.js            Unlock gate + all interactivity (tree, modal, search, theme)
.nojekyll            Tells GitHub Pages to serve files as-is
tools/               Build tooling — Tailwind CLI + encrypt-data.mjs (NOT deployed)
```

## Privacy gate & encryption

On load the site shows a full-screen **unlock gate**. The visitor enters the family
passphrase; `app.js` derives an AES-256-GCM key via PBKDF2 (SHA-256, 310,000
iterations) and attempts to decrypt `js/data.enc.js`. A wrong passphrase produces an
AES-GCM authentication failure, which the app catches and shows as a gentle
"That key doesn't fit — try again." On success, the gate fades away and the tree
renders. **Nothing identifying — no names, dates, or places — exists in the page,
its source, or its network payload before unlock**; `js/data.enc.js` contains only
base64 ciphertext, salt and IV.

The derived key bytes are cached in `sessionStorage` so a refresh doesn't re-prompt;
ticking **"Remember this device"** promotes the cache to `localStorage`. The **Lock**
button in the header clears the cache, purges the decrypted data from the DOM, and
re-shows the gate.

### The encrypted data file (`js/data.enc.js`)

```js
window.FAMILY_DATA_ENC = { v: 1, kdf: "PBKDF2-SHA256", iter: 310000,
                           salt: "<base64>", iv: "<base64>", ct: "<base64>" };
```

The shipped file is the **placeholder sample dataset** (12 people, 4 generations)
encrypted with the development passphrase **`placeholder-preview`**. This passphrase
is safe to document because it protects only fake data; the real archive will be
re-encrypted with a private passphrase that is never committed.

### Generating / rotating `data.enc.js`

Plaintext family data is **never committed** — not as `data.js`, not as a JSON
fixture (`tools/placeholder-data.json` and `*.plain.json` are git-ignored). The
genealogical research lives in a **separate private repository**; a script there
emits a plaintext JSON object matching the schema below, which is then encrypted
into `js/data.enc.js` with `tools/encrypt-data.mjs` (Node 22, built-in crypto, no
dependencies). Living relatives are emitted with `living: true`, which suppresses
all details except name, relationship, and a "Living" badge.

```bash
# Encrypt (passphrase as an argument)
node tools/encrypt-data.mjs path/to/data.json 'the-passphrase' > js/data.enc.js

# Or keep the passphrase out of shell history via an env var
FAMILY_KEY='the-passphrase' node tools/encrypt-data.mjs path/to/data.json > js/data.enc.js
```

**To rotate the passphrase:** re-run the encrypt script over the same plaintext with
the new passphrase and commit the regenerated `js/data.enc.js`. The passphrase
itself never appears in the repo.

### Schema

```js
window.FAMILY_DATA = {
  meta: { title, subtitle, generated, disclaimer },
  root: "p001",                       // id of the home/base person (generation 0)
  people: {
    p001: {
      id, name: { first, middle, last, maidenName, nickname },
      living,                          // true => details suppressed for privacy
      sex, generation,                 // 0 = root, 1 = parents, 2 = grandparents…
      relation,                        // human label, e.g. "Paternal grandmother"
      birth: { date, precision, place, sourceIds },  // precision: exact|circa|before|after|unknown
      death,                           // same shape as birth, or null
      occupation, story,               // narrative paragraph or null
      uncertainties: [],               // strings describing research doubts
      uncertain,                       // optional true => renders a "?" placeholder
      parents: [],                     // 0–2 person ids: defines the tree edges
      spouses: [ { personId, marriage: { date, precision, place, sourceIds } } ],
      sourceIds: []
    }
  },
  sources: { s001: { label, url, detail } }
}
```

`parents` defines the ancestor-tree edges. Spouses of ancestors render as attached
companion chips on the same node rather than as separate tree columns.

## Rebuilding the CSS

You only need this if you change `index.html`, `js/*.js`, or `css/custom.css` in a
way that introduces new Tailwind utility classes. Node 22+ required.

```bash
cd tools
npm install          # installs Tailwind locally (node_modules is git-ignored)
npm run build:css    # scans ../index.html + ../js/*.js, writes ../css/tailwind.css
```

The compiled `css/tailwind.css` is committed so the deployed site needs no build.

## Deploying with GitHub Pages

1. Commit the site to a branch.
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Select the branch and the **/ (root)** folder, then **Save**.
5. GitHub serves the site at `https://<user>.github.io/<repo>/`. Because this is a
   project site, all asset paths in `index.html` are **relative** (no leading `/`).

## Accessibility & privacy notes

- Real `<button>` elements, `aria-expanded`/`aria-controls` on branch toggles,
  focus-managed `<dialog>` modals, and listbox semantics on search results.
- Respects `prefers-reduced-motion` and `prefers-color-scheme`.
- Living relatives' personal details are withheld from the rendered page.
- All data is compiled from free public records; each person links to sources.
