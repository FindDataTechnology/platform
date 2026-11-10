# Locale review status

The non-English translation files in this directory (`zh-CN`, `es`, `fr`, `ja`)
are **placeholder-quality** translations produced during the
`add-multilanguage-i18n` change. They are functionally complete (every key in
`en/common.json` is present and non-empty) but have **not** been reviewed by a
native speaker.

Before any real release that ships these locales, each file needs a native-speaker
review pass for:

- Natural phrasing and tone (these were drafted, not localized by a native).
- Terminology consistency (e.g. "collection" → 集合 / colección / collection / コレクション).
- Punctuation/spacing conventions (e.g. CJK full-width, French spaces before `:`/`?`).
- Interpolation placeholders (`{{name}}`, `{{count}}`, etc.) must be preserved verbatim.

English (`en/common.json`) is the source of truth. `scripts/check-locales.js`
enforces key-set parity at build time - a missing or extra key in any locale
fails the build, so structural drift cannot slip in silently.

Translation quality does **not** gate merging this change: missing/low-quality
values degrade per-key to the English fallback (via `fallbackLng: "en"`), so the
UI never breaks. Treat this review as a release gate, tracked in the change's
`tasks.md` (task 8.4).
