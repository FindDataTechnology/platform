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
// `--color-x: var(--color-y);` alias lines (the status pinning) resolve to the
// target's parsed pair, so semantic aliases get checked like literals.
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
  const varRe = /--color-([\w-]+):\s*var\(--color-([\w-]+)\)\s*;/g;
  for (const [, name, target] of css.matchAll(varRe)) {
    if (light[target]) {
      light[name] = light[target];
      dark[name] = dark[target];
    }
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
  // Status aliases (web-design-system color discipline): var-resolved from their
  // pinned sources above; StatusPill renders the label on card / a 12% tint of
  // the same color, so the card floor is the real one (3.0 mirrors the signal
  // pair convention this repo already uses for status-colored labels).
  ["status-running", "card", 3.0],
  ["status-waiting", "card", 3.0],
  ["status-failed", "card", 4.5],
  ["status-paused", "card", 4.5],
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

// The series ramp's discipline is EQUAL LIGHTNESS: every step shares the lamp's
// L in each theme (light 0.48 / dark 0.64), descending chroma only. That is what
// makes "no step can fall under the contrast floor" true by construction —
// contrast is lightness-driven, and primary/card is already pinned above.
test("series ramp is equal-lightness vs the lamp, descending chroma", () => {
  const re =
    /--color-(primary|series-[1-4]):\s*light-dark\(\s*oklch\(([^)]*)\)\s*,\s*oklch\(([^)]*)\)\s*\)/g;
  const steps = {};
  for (const [, name, l, d] of css.matchAll(re)) {
    steps[name] = { light: l.trim().split(/\s+/).map(Number), dark: d.trim().split(/\s+/).map(Number) };
  }
  for (let i = 1; i <= 4; i++) {
    const s = steps[`series-${i}`];
    assert.ok(s, `--color-series-${i} missing`);
    assert.equal(s.light[0], steps.primary.light[0], `series-${i} light L must equal the lamp's`);
    assert.equal(s.dark[0], steps.primary.dark[0], `series-${i} dark L must equal the lamp's`);
    assert.equal(s.light[2], 250, `series-${i} keeps the lamp hue`);
  }
  const chroma = [1, 2, 3, 4].map((i) => steps[`series-${i}`].light[1]);
  for (let i = 1; i < chroma.length; i++) {
    assert.ok(chroma[i] < chroma[i - 1], `chroma must descend: step ${i + 1} (${chroma[i]}) !< step ${i} (${chroma[i - 1]})`);
  }
});

// EChart.tsx consumes the ramp at runtime by resolving `var(--color-series-N)`
// through a computed style (ECharts cannot read custom properties), so the
// values above remain the single source — no hex mirrors exist to pin.

// Ship guard (2026-11-02 release walkthrough): Tailwind v4 tree-shakes plain
// @theme tokens no scanned source line references. The series ramp's only
// consumer resolves them through a template literal — invisible to the
// scanner — so series-2..4 silently vanished from the built CSS (only
// series-1 survived, extracted from a comment's "1..4" range). The tokens
// must live in an `@theme static` block, which always emits.
test("series ramp tokens live in an @theme static block (survives tree-shaking)", () => {
  const staticBlocks = [...css.matchAll(/@theme\s+static\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(staticBlocks.length >= 1, "globals.css has an @theme static block");
  const staticText = staticBlocks.join("\n");
  for (const i of [1, 2, 3, 4]) {
    assert.match(staticText, new RegExp(`--color-series-${i}\\s*:`), `series-${i} must be declared inside @theme static`);
  }
  // The plain @theme block must not also declare them (single source, no drift).
  const plainBlocks = [...css.matchAll(/@theme\s*\{([^}]*)\}/g)].map((m) => m[1]).join("\n");
  for (const i of [1, 2, 3, 4]) {
    assert.doesNotMatch(plainBlocks, new RegExp(`--color-series-${i}\\s*:`), `series-${i} must NOT also appear in the plain @theme block`);
  }
});
