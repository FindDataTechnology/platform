// Contrast guard for the two theme palettes in web/src/styles/globals.css.
//
// The palettes are authored as `light-dark(<light>, <dark>)` pairs, so a token
// edited for one theme silently ships to the other. This parses the real
// stylesheet and asserts every foreground/background pairing the UI actually
// uses clears WCAG AA in BOTH themes — an eyeballed oklch lightness is not a
// contrast ratio.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS_PATH = fileURLToPath(new URL("../web/src/styles/globals.css", import.meta.url));

// oklch() -> sRGB, per the CSS Color 4 conversion. Values are clamped into
// gamut the same way a browser does for display, which is what a user sees.
function oklchToSrgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  const lin = [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((v) => Math.min(1, Math.max(0, v)));
}

// WCAG relative luminance takes LINEAR-light channels, which is exactly what
// oklchToSrgb returns — no gamma round-trip needed.
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// Parse `--color-x: light-dark(oklch(...), oklch(...));` into {light, dark}.
function parsePalettes(css) {
  const light = {};
  const dark = {};
  const re =
    /--color-([\w-]+):\s*light-dark\(\s*oklch\(([^)]*)\)\s*,\s*oklch\(([^)]*)\)\s*\)/g;
  const nums = (s) => s.trim().split(/\s+/).map(Number);
  for (const [, name, l, d] of css.matchAll(re)) {
    light[name] = oklchToSrgb(...nums(l));
    dark[name] = oklchToSrgb(...nums(d));
  }
  return { light, dark };
}

const css = readFileSync(CSS_PATH, "utf8");
const palettes = parsePalettes(css);

// Foreground-on-background pairings the UI actually renders, with the minimum
// each must clear. 4.5 is AA for body text; 3.0 is AA for large text, icons,
// and non-text boundaries like borders and focus rings.
const PAIRS = [
  ["foreground", "background", 4.5],
  ["foreground", "card", 4.5],
  ["card-foreground", "card", 4.5],
  ["popover-foreground", "popover", 4.5],
  ["muted-foreground", "background", 4.5],
  ["muted-foreground", "card", 4.5],
  ["muted-foreground", "muted", 4.5],
  // Hover states put normal foreground text on the muted surface.
  ["foreground", "muted", 4.5],
  ["secondary-foreground", "secondary", 4.5],
  ["accent-foreground", "accent", 4.5],
  // primary is the text/edge step: it is rendered AS text on the base surfaces.
  ["primary", "background", 4.5],
  ["primary", "card", 4.5],
  // primary-deep is the fill step: white text sits ON it.
  ["primary-foreground", "primary-deep", 4.5],
  // Signal colors are rendered as text (error messages, status labels)…
  ["destructive", "background", 4.5],
  ["destructive", "card", 4.5],
  // …and `destructive-deep` is the fill step white text sits on.
  ["destructive-foreground", "destructive-deep", 4.5],
  ["success", "card", 3.0],
  ["warning", "card", 3.0],
  // Non-text boundaries. WCAG sets no minimum for a decorative separator, so
  // this is not an AA threshold — it is a "visible at all" floor that catches a
  // border collapsing into its surface. Deliberately low: subtle separators are
  // the intended design.
  ["border", "background", 1.2],
  ["border", "card", 1.2],
  ["ring", "background", 3.0],
];

test("both palettes define the same complete token set", () => {
  const l = Object.keys(palettes.light).sort();
  const d = Object.keys(palettes.dark).sort();
  assert.deepEqual(l, d, "light and dark must define identical token names");
  assert.ok(l.length >= 18, `expected the full token set, parsed only ${l.length}`);
});

test("every token referenced by a contrast pair exists", () => {
  for (const [fg, bg] of PAIRS) {
    for (const name of [fg, bg]) {
      assert.ok(palettes.light[name], `--color-${name} missing from the light palette`);
      assert.ok(palettes.dark[name], `--color-${name} missing from the dark palette`);
    }
  }
});

for (const theme of ["light", "dark"]) {
  test(`${theme} palette meets contrast minimums`, () => {
    const failures = [];
    for (const [fg, bg, min] of PAIRS) {
      const ratio = contrast(palettes[theme][fg], palettes[theme][bg]);
      if (ratio < min) {
        failures.push(`  ${fg} on ${bg}: ${ratio.toFixed(2)}:1 (needs ${min}:1)`);
      }
    }
    assert.equal(failures.length, 0, `${theme} palette contrast failures:\n${failures.join("\n")}`);
  });
}
