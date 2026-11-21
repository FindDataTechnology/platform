// 壹座·智能体素材广场 — static site logic (add-agent-materials-plaza).
// No build step, no framework: locale JSON + snapshot catalog + one live
// refresh attempt. Freshness semantics per spec: live refresh on load; on any
// failure the build-time snapshot shows, labeled with its as-of date — a page
// with a valid snapshot never renders an empty inventory.
(() => {
  const LOCALES = ["zh-CN", "en", "es", "fr", "ja"];
  const DEFAULT_LOCALE = "zh-CN";
  const FACET_BASE = "https://facet.finddatatech.cloud";

  const store = {
    locale: null,
    dict: null,
    catalog: null, // snapshot (same-origin generated/catalog.json)
    live: null, // live-refreshed listing (or null)
    liveState: "pending", // pending | live | snapshot
    speciesTab: "all", // all | agents | skills | mcp
  };

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function localeFromUrl() {
    const q = new URLSearchParams(location.search).get("lang");
    if (q && LOCALES.includes(q)) return q;
    const saved = localStorage.getItem("plaza.locale");
    if (saved && LOCALES.includes(saved)) return saved;
    const nav = (navigator.language || DEFAULT_LOCALE).toLowerCase();
    const hit = LOCALES.find((l) => l.toLowerCase() === nav || nav.startsWith(l.split("-")[0] + "-") || nav.startsWith(l.split("-")[0]));
    return hit ?? DEFAULT_LOCALE;
  }

  async function loadDict(locale) {
    const res = await fetch(`locales/${locale}.json`);
    if (!res.ok) throw new Error(`locale ${locale} HTTP ${res.status}`);
    return res.json();
  }

  function applyStatic() {
    const d = store.dict;
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      // nested paths resolved by dot walk
      const val = el.getAttribute("data-i18n").split(".").reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), d);
      if (typeof val === "string") el.innerHTML = val;
    });
    document.querySelectorAll("[data-i18n-attr]").forEach((el) => {
      const spec = el.getAttribute("data-i18n-attr"); // "placeholder:inventory.search"
      const [attr, key] = spec.split(":");
      const val = key.split(".").reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), d);
      if (typeof val === "string") el.setAttribute(attr, val);
    });
    document.documentElement.lang = store.locale;
    // dynamic lists
    renderCategories(d);
    renderMechanism(d);
    renderAudience(d);
    renderInventory();
  }

  function renderCategories(d) {
    const grid = $("#categoryGrid");
    grid.innerHTML = d.materials.items
      .map(
        (it) => `
      <article class="mat-card">
        <h3>${esc(it.name)}</h3>
        <span class="en">${esc(it.en)}</span>
        <p>${esc(it.desc)}</p>
        <p class="example">${esc(it.example)}</p>
      </article>`,
      )
      .join("");
  }

  function renderMechanism(d) {
    const grid = $("#mechGrid");
    const th = d.mechanism.tableHead;
    grid.innerHTML = d.mechanism.steps
      .map(
        (s, i) => `
      <article class="mech-card">
        <h3>${i + 1}. ${esc(s.verb)}<small>${esc(s.en)}</small></h3>
        <div class="mech-row"><b>${esc(th.input)} →</b><span>${esc(s.input)}</span></div>
        <div class="mech-row"><b>${esc(th.output)} →</b><span>${esc(s.output)}</span></div>
        <div class="mech-promise">${esc(s.promise)}</div>
      </article>`,
      )
      .join("");
  }

  function renderAudience(d) {
    $("#audHuman").innerHTML = d.audience.human.items.map((x) => `<li>${esc(x)}</li>`).join("");
    $("#audAi").innerHTML = d.audience.ai.items.map((x) => `<li>${esc(x)}</li>`).join("");
  }

  // The listing shown: the snapshot is the BASE (all three species); a
  // successful live refresh UPDATES the pack-species entries in place (by id —
  // replace or append) and NEVER removes the skills/MCP species — the live
  // listing only covers packs, so returning it alone would empty two of the
  // three tabs whenever the market is reachable.
  function currentMaterials() {
    const snap = store.catalog?.materials ?? [];
    if (store.liveState !== "live" || !store.live) return snap;
    const byId = new Map(snap.map((m) => [m.id, { ...m }]));
    for (const liveItem of store.live) {
      const prev = byId.get(liveItem.id);
      byId.set(liveItem.id, { ...prev, ...liveItem, human: { ...prev?.human, ...liveItem.human } });
    }
    return [...byId.values()];
  }

  function renderInventory() {
    const d = store.dict;
    const grid = $("#invGrid");
    const status = $("#invStatus");
    if (store.liveState === "live") {
      status.textContent = d.inventory.live;
      status.className = "inv-status mono live";
    } else if (store.catalog) {
      status.textContent = `${d.inventory.snapshot} · ${store.catalog.generatedAt}`;
      status.className = "inv-status mono";
    }
    const q = ($("#invSearch").value || "").trim().toLowerCase();
    const cat = $("#invCategory").value;
    const tab = store.speciesTab;
    const inTab = (c) =>
      tab === "all" ? true : tab === "agents" ? ["pack", "facade", "official-data"].includes(c) : tab === "skills" ? c === "skill" : c === "mcp";
    const mats = currentMaterials().filter((m) => {
      if (!inTab(m.category)) return false;
      if (cat && m.category !== cat) return false;
      if (!q) return true;
      const hay = [m.human?.[store.locale]?.name, m.human?.en?.name, m.human?.["zh-CN"]?.name, m.canonical?.brief, ...(m.tags ?? [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
    grid.innerHTML =
      mats
        .map((m) => {
          const name = m.human?.[store.locale]?.name ?? m.human?.en?.name ?? m.id;
          const desc = m.human?.[store.locale]?.summary ?? m.canonical?.brief ?? "";
          const badges = [
            m.badges?.official ? `<span class="badge official">${esc(d.inventory.official)}</span>` : "",
            m.badges?.facade ? `<span class="badge facade">${esc(d.inventory.facade)}</span>` : "",
            `<span class="badge">${esc(d.inventory.categoryNames[m.category] ?? m.category)}</span>`,
          ].join("");
          return `
          <article class="inv-card">
            <h4>${esc(name)}</h4>
            <div class="badges">${badges}</div>
            <p class="desc">${esc(desc)}</p>
            <div class="links">
              <a href="${FACET_BASE}/#/packs" target="_blank" rel="noopener">${esc(d.inventory.obtain)} ↗</a>
              <a href="generated/materials/${encodeURIComponent(m.slug)}.md">${esc(d.inventory.page)} →</a>
            </div>
          </article>`;
        })
        .join("") || `<p class="sec-ink">${esc(d.inventory.empty)}</p>`;
    // category filter options once
    const sel = $("#invCategory");
    if (sel.options.length <= 1) {
      for (const [value, label] of Object.entries(d.inventory.categoryNames)) {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = label;
        sel.appendChild(o);
      }
    }
  }

  async function refreshLive() {
    // Live refresh attempt (spec: graceful, silent, never blocking the page).
    try {
      // same-origin: the edge proxies /api/packs to the facet market — a
      // cross-origin fetch here would die on CORS and the live face would
      // never show (the snapshot fallback would silently become the only face)
      const res = await fetch(`/api/packs?page=1&pageSize=100&locale=${encodeURIComponent(store.locale)}`, {
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const packs = body?.packs ?? [];
      // admission mirror: public + non-unlisted + curated (category ∨ featured)
      const listed = packs.filter((p) => p.visibility !== "private" && (p.category || p.featured));
      const snapById = new Map((store.catalog?.materials ?? []).map((m) => [m.id, m]));
      store.live = listed.map((p) => {
        const snap = snapById.get(p.id);
        return {
          id: p.id,
          slug: snap?.slug ?? `pack-${String(p.id).toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`,
          // species mapping rides the snapshot when the id is known — the live
          // overlay never downgrades a material's category
          category: snap?.category ?? (p.badge === "facade" || p.badge === "assistant" ? "facade" : "pack"),
          canonical: { brief: p.description ?? "" },
          human: { [store.locale]: { name: p.name, summary: p.description ?? "" }, en: { name: p.name, summary: p.description ?? "" } },
          tags: p.tags ?? [],
          badges: snap?.badges ?? { official: Boolean(p.official), facade: p.badge === "facade" || p.badge === "assistant" },
          provenance: { source: FACET_BASE, updatedAt: new Date().toISOString().slice(0, 10) },
        };
      });
      store.liveState = "live";
    } catch {
      store.liveState = "snapshot"; // CORS, network, 429 — the snapshot face shows
    }
    renderInventory();
  }

  // v2 three-domain doors: the hostname preselects the species tab.
  // agent.finddatatech.cloud = canonical (all); skills. = skills; mcp. = mcp.
  function speciesFromHost() {
    const h = location.hostname;
    if (h.startsWith("skills.")) return "skills";
    if (h.startsWith("mcp.")) return "mcp";
    return "all";
  }

  async function boot() {
    store.locale = localeFromUrl();
    store.speciesTab = new URLSearchParams(location.search).get("species") || speciesFromHost();
    $("#localeSwitcher").value = store.locale;
    $("#localeSwitcher").addEventListener("change", (e) => {
      localStorage.setItem("plaza.locale", e.target.value);
      location.search = `lang=${e.target.value}`;
    });
    $("#invSearch").addEventListener("input", () => {
      renderInventory();
    });
    $("#invCategory").addEventListener("change", () => {
      renderInventory();
    });
    document.querySelectorAll(".inv-tab").forEach((b) => {
      b.addEventListener("click", () => {
        store.speciesTab = b.dataset.tab;
        document.querySelectorAll(".inv-tab").forEach((x) => {
          x.classList.toggle("active", x === b);
        });
        renderInventory();
      });
    });

    store.dict = await loadDict(store.locale).catch(() => loadDict(DEFAULT_LOCALE));
    const catRes = await fetch("generated/catalog.json").catch(() => null);
    if (catRes && catRes.ok) store.catalog = await catRes.json();
    if (store.catalog) {
      const c = store.catalog.counts ?? {};
      $("#countPacks").textContent = c.packs ?? "—";
      $("#countSkills").textContent = c.skills ?? "—";
      $("#countMcp").textContent = c.mcpServers ?? "—";
      $("#countTools").textContent = c.tools ?? "—";
      $("#asOfDate").textContent = store.catalog.generatedAt ?? "—";
      // 五物种 hero 计数（add-supply-catalog-unification）：facade/official-data
      // 自带槽位，缺源（source_absent）时按 0 呈现——诚实零，不留 "—"。
      // 计数从 counts.json 的 byCategory 读（catalog.json 不带该块）。
      const countsRes = await fetch("generated/counts.json").catch(() => null);
      const countsBody = countsRes && countsRes.ok ? await countsRes.json() : null;
      const byCat = new Map((countsBody?.byCategory ?? []).map((x) => [x.category, x.count]));
      $("#countFacade").textContent = byCat.get("facade") ?? 0;
      $("#countOfficialData").textContent = byCat.get("official-data") ?? 0;
    }
    applyStatic();
    // reflect the preselected tab in the UI
    document.querySelectorAll(".inv-tab").forEach((x) => {
      x.classList.toggle("active", x.dataset.tab === store.speciesTab);
    });
    void refreshLive();
  }

  boot();
})();
