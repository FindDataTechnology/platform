# Snapshot contract for `release-sync.mjs` (from fd-official-web add-platform-product-page)

> Posted 2026-10-07 by the fd-official-web change `add-platform-product-page`
> (task 4.2). The reader side is implemented, validated, and live-path tested
> in fd-official-web; this note freezes the contract the writer
> (`scripts/release-sync.mjs`, this repo's add-desktop-release) implements against.

## File

- **Path (writer's upstream checkout of fd-official-web):** `src/data/desktop-releases.json`
- **Reader/validator:** `src/lib/desktop-releases.ts` (`loadDesktopReleases()` — runs at site build; a malformed write fails the site build naming your entry and field)
- Single current-state file (NOT the dated `release-snapshots/` archive pattern). The writer rewrites it in full on release.

## Shape (`schema: 1`)

```json
{
  "schema": 1,
  "releases": [
    {
      "version": "1.3.0",
      "released_at": "2026-10-08",
      "platforms": {
        "macos":   { "beta": false, "filename": "Platform-1.3.0.dmg",
                     "official_url": null,
                     "github_url": "https://github.com/FindDataTechnology/platform/releases/download/v1.3.0/Platform-1.3.0.dmg" },
        "windows": { "beta": true,  "filename": "Platform-1.3.0-setup.exe",
                     "official_url": null, "github_url": "…" }
      }
    }
  ]
}
```

## Writer rules (reader-enforced — violations fail the site build)

- `releases` is **newest-first**; the band renders `releases[0]` only. Array (not bare `latest`) so a history view can arrive later without a schema break.
- `version` required, **semver** (`MAJOR.MINOR.PATCH`, prerelease/build suffixes allowed).
- `released_at` required, `YYYY-MM-DD`.
- `platforms` required. Platform keys are a **closed set**: `macos`, `windows` (Linux later adds a key — shape unchanged). Unknown keys fail the build.
- Each platform entry: `beta` required **boolean**; `official_url` and `github_url` each `null` or `https://…`; **at least one must be present** (both-null fails the build).
- **Unknown fields are ignored** by the reader — the writer may add fields first without breaking the site; any shape change is a `schema` bump coordinated across both repos in one pass.
- Transitional semantics (already rendered by the band): GitHub-only entry ⇒ download = GitHub link + "official direct link coming soon" note. When `dl` goes live, set `official_url` and the note disappears with zero page-side changes.
- Current shipped state: `"releases": []` (the v1.3.0 GitHub Release did not exist when the page shipped) — the band renders the bilingual coming-soon empty state. Your first successful write flips it to real downloads.
