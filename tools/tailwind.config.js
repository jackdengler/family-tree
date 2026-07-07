/** @type {import('tailwindcss').Config} */
// Tailwind config for the Dengler Family Tree.
// Colors map to CSS custom properties (defined in css/custom.css) so that
// utility classes such as `bg-paper` and `text-ink` automatically respect the
// `.dark` theme, which is toggled as a class on <html>.
module.exports = {
  darkMode: "class",
  content: [
    "../index.html",
    "../js/*.js",
    "./safelist.txt"
  ],
  theme: {
    extend: {
      colors: {
        paper: "var(--bg)",
        surface: "var(--surface)",
        ink: "var(--ink)",
        muted: "var(--muted)",
        gold: "var(--gold)",
        border: "var(--border)"
      },
      fontFamily: {
        display: ['"Cormorant Garamond"', "Georgia", "serif"],
        body: ['"Lora"', "Georgia", "serif"]
      }
    }
  },
  // Component/state classes that JS toggles at runtime are styled in
  // css/custom.css (not Tailwind utilities), but we list them so their names
  // are never tree-shaken from any future utility usage.
  safelist: [
    "dark",
    "pulse-gold",
    "enter",
    "entered",
    "is-collapsed",
    "is-living",
    "is-uncertain",
    "is-placeholder",
    "active"
  ],
  plugins: []
};
