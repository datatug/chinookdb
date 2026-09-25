function k(s, t) {
  const r = new URL(s, t);
  if (!["http:", "https:"].includes(r.protocol) || r.username || r.password)
    throw new Error("Source URL must be HTTP(S) without embedded credentials.");
  return r;
}
function N(s) {
  return s !== null && typeof s == "object" && !Array.isArray(s);
}
function O(s) {
  const t = N(s) ? s : void 0, r = Array.isArray(s) ? s : t?.records ?? t?.rows ?? t?.data;
  if (!Array.isArray(r)) throw new Error("JSON source must be a row array or contain records, rows, or data.");
  const e = [], a = [];
  for (const o of r) {
    if (!N(o)) throw new Error("Every JSON row must be an object.");
    N(o.data) && typeof o.key == "string" ? (e.push(o.data), a.push(o.key)) : e.push(o);
  }
  const c = Array.isArray(t?.columns) && t.columns.every((o) => typeof o == "string") ? t.columns : [...new Set(e.flatMap((o) => Object.keys(o)))];
  return { rows: e, columns: c, keys: a.length === e.length ? a : void 0, metadata: t };
}
function U(s) {
  const t = [];
  let r = [], e = "", a = !1;
  const c = s.replace(/^\uFEFF/, "");
  for (let l = 0; l < c.length; l++) {
    const n = c[l];
    if (a)
      n === '"' && c[l + 1] === '"' ? (e += '"', l++) : n === '"' ? a = !1 : e += n;
    else if (n === '"') {
      if (e) throw new Error("Malformed CSV quote.");
      a = !0;
    } else n === "," ? (r.push(e), e = "") : n === `
` || n === "\r" ? (n === "\r" && c[l + 1] === `
` && l++, r.push(e), t.push(r), r = [], e = "") : e += n;
  }
  if (a) throw new Error("Unclosed CSV quote.");
  if ((e || r.length) && (r.push(e), t.push(r)), !t.length) return { rows: [], columns: [] };
  const o = t.shift() ?? [];
  if (o.some((l) => !l) || new Set(o).size !== o.length) throw new Error("CSV header columns must be nonempty and unique.");
  return { columns: o, rows: t.map((l) => {
    if (l.length !== o.length) throw new Error("CSV row has a different number of columns than its header.");
    return Object.fromEntries(o.map((n, d) => [n, l[d]]));
  }) };
}
function M(s, t, r) {
  const e = s?.split(";", 1)[0]?.trim().toLowerCase();
  if (e === "application/json" || e?.endsWith("+json")) return "json";
  if (e === "text/csv" || e === "application/csv") return "csv";
  const a = t.pathname.toLowerCase();
  if (a.endsWith(".json")) return "json";
  if (a.endsWith(".csv")) return "csv";
  if (r === "json" || r === "csv") return r;
  throw new Error('Cannot detect data format. Set format="json" or format="csv".');
}
async function L(s, t) {
  if (s.ok) return s;
  let r = "";
  try {
    const e = await s.json();
    N(e) && (r = String(e.message ?? e.error ?? ""));
  } catch {
  }
  throw new Error(`${t} failed (${s.status})${r ? `: ${r}` : ""}.`);
}
async function V(s, t, r) {
  const e = k(s, document.baseURI), a = await L(await fetch(e, { signal: r, credentials: "same-origin", headers: { Accept: "application/json, text/csv;q=0.9" } }), "Data request");
  return M(a.headers.get("Content-Type"), e, t) === "json" ? O(await a.json()) : U(await a.text());
}
async function R(s, t, r, e) {
  const a = k(s, document.baseURI), c = new URL("/.well-known/openvaultdb", a.origin), n = (await (await L(await fetch(c, { signal: e, credentials: "same-origin", headers: { Accept: "application/json" } }), "OVDB discovery")).json()).databases?.find((v) => {
    if (!v.url) return !1;
    try {
      return k(v.url, c.href).href.replace(/\/$/, "") === a.href.replace(/\/$/, "");
    } catch {
      return !1;
    }
  });
  if (!n?.apiUrl) throw new Error("OVDB discovery does not list this database connection URL.");
  const d = k(n.apiUrl, c.href), u = await (await L(await fetch(d, { signal: e, credentials: "same-origin", headers: { Accept: "application/json" } }), "OVDB database metadata")).json(), b = u.capabilities ?? n.capabilities;
  if (!(Array.isArray(b) ? b.includes("dtql") : N(b) && b.dtql === !0) || !u.endpoints?.dtql) throw new Error("This OVDB database does not advertise DTQL queries.");
  const g = k(u.endpoints.dtql, d.href);
  let E, x;
  if (u.queryFormat === "dtql-yaml+json")
    E = JSON.stringify({ query: t, parameters: r }), x = "application/json";
  else if (u.queryFormat === "dtql-yaml") {
    if (Object.keys(r).length) throw new Error("This OVDB endpoint does not support bound DTQL parameters.");
    E = t, x = "application/yaml";
  } else throw new Error(`Unsupported OVDB query format: ${u.queryFormat ?? "missing"}.`);
  const A = await L(await fetch(g, { method: "POST", signal: e, credentials: "same-origin", headers: { "Content-Type": x, Accept: "application/json" }, body: E }), "DTQL query");
  return O(await A.json());
}
const B = `
:host{display:block;box-sizing:border-box;color:var(--datatug-fg,#18304a);font:var(--datatug-font,14px/1.45 system-ui,sans-serif);background:var(--datatug-bg,#fff);border:1px solid var(--datatug-border,#dce5ee);border-radius:var(--datatug-radius,10px);overflow:hidden;min-width:0}
*{box-sizing:border-box}button,input,select{font:inherit;color:inherit}button{cursor:pointer;background:var(--datatug-button-bg,#f5f8fb);border:1px solid var(--datatug-border,#dce5ee);border-radius:5px;padding:.25rem .55rem}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,th button:focus-visible{outline:2px solid var(--datatug-accent,#2879b9);outline-offset:2px}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:.65rem;padding:.7rem .85rem;border-bottom:1px solid var(--datatug-border,#dce5ee);flex-wrap:wrap}.brand{font-weight:700;letter-spacing:.01em}.tools{display:flex;align-items:center;gap:.45rem;flex-wrap:wrap}.tools input{max-width:13rem;min-width:7rem;border:1px solid var(--datatug-border,#dce5ee);border-radius:5px;padding:.26rem .45rem}.status{padding:.8rem;color:var(--datatug-muted,#587087)}.error{color:var(--datatug-error,#ab2e39)}.scroller{overflow:auto;max-height:var(--datatug-max-height,32rem)}table{border-collapse:collapse;min-width:100%;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:.46rem .7rem;border-bottom:1px solid var(--datatug-border,#dce5ee);vertical-align:top;white-space:nowrap;max-width:32rem;overflow:hidden;text-overflow:ellipsis}th{position:sticky;top:0;background:var(--datatug-header-bg,#f4f8fb);color:var(--datatug-muted,#587087);font-size:.84em;font-weight:650}th button{border:0;background:none;padding:0;font-weight:inherit;color:inherit}tbody tr:hover{background:var(--datatug-hover,#f5f9fc)}tbody tr[aria-selected=true]{background:var(--datatug-selected,#e7f3fc)}.footer{display:flex;align-items:center;justify-content:space-between;gap:.6rem;padding:.55rem .85rem;color:var(--datatug-muted,#587087);font-size:.85em}.pager{display:flex;gap:.35rem;align-items:center}.chart{padding:.8rem}.bar{display:grid;grid-template-columns:minmax(5rem, 30%) 1fr auto;gap:.6rem;align-items:center;margin:.38rem 0}.track{height:.8rem;border-radius:3px;background:var(--datatug-header-bg,#f4f8fb);overflow:hidden}.fill{height:100%;background:var(--datatug-accent,#2879b9)}.label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;
function i(s, t) {
  const r = document.createElement(s);
  return t !== void 0 && (r.textContent = t), r;
}
function q(s) {
  return s == null ? "—" : typeof s == "object" ? JSON.stringify(s) : String(s);
}
function F(s, t) {
  if (t === "string" || !t) return s;
  if (t === "number") {
    if (!s.trim() || !Number.isFinite(Number(s))) throw new Error("Invalid number parameter.");
    return Number(s);
  }
  if (t === "boolean") {
    if (s !== "true" && s !== "false") throw new Error("Boolean parameter must be true or false.");
    return s === "true";
  }
  if (t === "null") return null;
  throw new Error(`Unsupported DTQL parameter type: ${t}.`);
}
class Q extends HTMLElement {
  connectedCallback() {
    this.style.display = "none", this.observer = new MutationObserver(() => this.notify()), this.observer.observe(this, { childList: !0, characterData: !0, subtree: !0 });
  }
  disconnectedCallback() {
    this.observer?.disconnect();
  }
  notify() {
    this.dispatchEvent(new Event("dtql-change", { bubbles: !0 }));
  }
}
class z extends HTMLElement {
  constructor() {
    super(...arguments), this.propertySet = !1;
  }
  static get observedAttributes() {
    return ["name", "value", "type"];
  }
  get value() {
    return this.propertySet ? this.propertyValue : F(this.getAttribute("value") ?? "", this.getAttribute("type"));
  }
  set value(t) {
    if (t !== null && !["string", "number", "boolean"].includes(typeof t)) throw new TypeError("DTQL parameter value must be a JSON scalar.");
    this.propertySet = !0, this.propertyValue = t, this.notify();
  }
  attributeChangedCallback(t) {
    (t === "value" || t === "type") && (this.propertySet = !1), this.notify();
  }
  connectedCallback() {
    this.style.display = "none", this.notify();
  }
  notify() {
    this.dispatchEvent(new Event("dtql-change", { bubbles: !0 }));
  }
}
class $ extends HTMLElement {
  constructor() {
    super(), this.root = this.attachShadow({ mode: "open" }), this.state = "loading", this.message = "", this.scheduled = !1, this.revision = 0, this.onChildChange = () => this.schedule(), this.root.append(i("style", B));
  }
  static get observedAttributes() {
    return ["connection", "data-url", "format", "type", "page-size"];
  }
  connectedCallback() {
    this.addEventListener("dtql-change", this.onChildChange), this.observer = new MutationObserver(() => this.schedule()), this.observer.observe(this, { childList: !0, subtree: !1 }), this.schedule();
  }
  disconnectedCallback() {
    this.removeEventListener("dtql-change", this.onChildChange), this.observer?.disconnect(), this.controller?.abort(), this.revision++;
  }
  attributeChangedCallback() {
    this.schedule();
  }
  schedule() {
    !this.isConnected || this.scheduled || (this.scheduled = !0, queueMicrotask(() => {
      this.scheduled = !1, this.isConnected && this.refresh();
    }));
  }
  async refresh() {
    this.controller?.abort();
    const t = new AbortController();
    this.controller = t;
    const r = ++this.revision;
    this.state = "loading", this.message = "Loading data…", this.render();
    try {
      const e = this.getAttribute("connection"), a = this.getAttribute("data-url"), c = [...this.children].filter((h) => h.localName === "dtql-query"), o = c[0], l = [...this.children].filter((h) => h.localName === "dtql-param");
      if (!!e == !!a) throw new Error("Set exactly one of connection or data-url.");
      if (a && (c.length || l.length)) throw new Error("data-url cannot be combined with DTQL query or parameters.");
      if (e && (c.length !== 1 || !o?.textContent?.trim())) throw new Error("A connection requires one nonempty <dtql-query>.");
      const n = {};
      for (const h of l) {
        const u = h.getAttribute("name");
        if (!u || Object.hasOwn(n, u)) throw new Error("Every <dtql-param> needs a unique nonempty name.");
        n[u] = h.value;
      }
      if (!a && (!e || !o?.textContent)) throw new Error("A connection requires one nonempty <dtql-query>.");
      const d = a ? await V(a, this.getAttribute("format"), t.signal) : await R(e, o?.textContent?.trim() ?? "", n, t.signal);
      if (t.signal.aborted || r !== this.revision) return;
      this.data = d, this.state = d.rows.length ? "ready" : "empty", this.message = d.rows.length ? "" : "No rows found.", this.render(), this.dispatchEvent(new CustomEvent("datatug-data-loaded", { detail: { rows: d.rows.length, columns: d.columns, metadata: d.metadata }, bubbles: !0 }));
    } catch (e) {
      if (t.signal.aborted || r !== this.revision) return;
      this.data = void 0, this.state = "error", this.message = e instanceof Error ? e.message : "Could not load data.", this.render(), this.dispatchEvent(new CustomEvent("datatug-error", { detail: { message: this.message }, bubbles: !0 }));
    }
  }
  reload() {
    return this.refresh();
  }
  shell(t) {
    [...this.root.children].filter((c) => c.localName !== "style").forEach((c) => c.remove());
    const r = i("div"), e = i("div");
    e.className = "toolbar";
    const a = i("span", t);
    return a.className = "brand", e.append(a), r.append(e), this.root.append(r), r;
  }
  statusNode(t) {
    if (this.state === "ready") return !1;
    const r = i("div", this.message);
    return r.className = `status ${this.state === "error" ? "error" : ""}`, r.setAttribute("role", this.state === "error" ? "alert" : "status"), t.append(r), !0;
  }
}
class J extends $ {
  constructor() {
    super(...arguments), this.search = "", this.sortDesc = !1, this.page = 0;
  }
  render() {
    const t = this.shell("DataTug"), r = t.firstElementChild, e = i("div");
    e.className = "tools";
    const a = i("input");
    a.type = "search", a.placeholder = "Search rows", a.setAttribute("aria-label", "Search rows"), a.value = this.search, a.addEventListener("input", () => {
      this.search = a.value, this.page = 0, this.render(), this.root.querySelector("input")?.focus();
    });
    const c = i("button", "Refresh");
    if (c.type = "button", c.addEventListener("click", () => {
      this.refresh();
    }), e.append(a, c), r.append(e), this.statusNode(t)) return;
    const o = this.data;
    if (!o) return;
    const l = this.search.toLocaleLowerCase(), n = o.rows.map((m, p) => ({ row: m, index: p })).filter(({ row: m }) => !l || o.columns.some((p) => q(m[p]).toLocaleLowerCase().includes(l)));
    if (this.sortColumn) {
      const m = this.sortColumn;
      n.sort((p, f) => {
        const C = p.row[m], w = f.row[m], T = typeof C == "number" && typeof w == "number" ? C - w : q(C).localeCompare(q(w), void 0, { numeric: !0 });
        return (this.sortDesc ? -T : T) || p.index - f.index;
      });
    }
    const d = Number(this.getAttribute("page-size")), h = Number.isInteger(d) && d > 0 ? Math.min(d, 500) : 50, u = Math.max(1, Math.ceil(n.length / h));
    this.page = Math.min(this.page, u - 1);
    const b = n.slice(this.page * h, (this.page + 1) * h), y = i("div");
    y.className = "scroller";
    const g = i("table"), E = i("thead"), x = i("tr");
    for (const m of o.columns) {
      const p = i("th");
      p.scope = "col";
      const f = i("button", `${m}${this.sortColumn === m ? this.sortDesc ? " ↓" : " ↑" : ""}`);
      f.type = "button", f.addEventListener("click", () => {
        this.sortDesc = this.sortColumn === m && !this.sortDesc, this.sortColumn = m, this.page = 0, this.render();
      }), p.append(f), x.append(p);
    }
    E.append(x), g.append(E);
    const A = i("tbody");
    for (const { row: m, index: p } of b) {
      const f = i("tr");
      f.tabIndex = 0, f.setAttribute("aria-selected", String(this.selected === p));
      const C = () => {
        this.selected = p, this.render(), this.dispatchEvent(new CustomEvent("datatug-select", { detail: { row: m, index: p, key: o.keys?.[p] }, bubbles: !0 }));
      };
      f.addEventListener("click", C), f.addEventListener("keydown", (w) => {
        (w.key === "Enter" || w.key === " ") && (w.preventDefault(), C());
      });
      for (const w of o.columns) f.append(i("td", q(m[w])));
      A.append(f);
    }
    g.append(A), y.append(g), t.append(y);
    const v = i("div");
    v.className = "footer", v.append(i("span", `${n.length} of ${o.rows.length} rows`));
    const j = i("div");
    j.className = "pager";
    const D = i("button", "Previous");
    D.disabled = this.page === 0, D.addEventListener("click", () => {
      this.page--, this.render();
    });
    const S = i("button", "Next");
    S.disabled = this.page >= u - 1, S.addEventListener("click", () => {
      this.page++, this.render();
    }), j.append(D, i("span", `${this.page + 1} / ${u}`), S), v.append(j), t.append(v);
  }
}
class H extends $ {
  render() {
    const t = this.shell("DataTug chart");
    if (this.statusNode(t)) return;
    const r = this.data;
    if (!r) return;
    const e = this.getAttribute("type") ?? "auto";
    if (e !== "auto" && e !== "bar") {
      this.message = `Unsupported chart type: ${e}.`, this.state = "error", this.statusNode(t);
      return;
    }
    const a = r.columns.find((d) => r.rows.some((h) => typeof h[d] == "number")), c = r.columns.find((d) => d !== a);
    if (!a || !c) {
      this.message = "Chart needs one numeric and one label column.", this.state = "error", this.statusNode(t);
      return;
    }
    const o = r.rows.slice(0, 20), l = Math.max(0, ...o.map((d) => Number(d[a]) || 0)), n = i("div");
    n.className = "chart", n.setAttribute("role", "img"), n.setAttribute("aria-label", `Bar chart of ${a} by ${c}`);
    for (const d of o) {
      const h = Number(d[a]) || 0, u = i("div");
      u.className = "bar";
      const b = i("span", q(d[c]));
      b.className = "label";
      const y = i("div");
      y.className = "track";
      const g = i("div");
      g.className = "fill", g.style.width = `${Math.max(0, l ? h / l * 100 : 0)}%`, y.append(g), u.append(b, y, i("span", q(h))), n.append(u);
    }
    t.append(n);
  }
}
customElements.get("dtql-query") || customElements.define("dtql-query", Q);
customElements.get("dtql-param") || customElements.define("dtql-param", z);
customElements.get("datatug-grid") || customElements.define("datatug-grid", J);
customElements.get("datatug-chart") || customElements.define("datatug-chart", H);
export {
  H as DataTugChart,
  J as DataTugGrid,
  z as DtqlParam,
  Q as DtqlQuery
};
//# sourceMappingURL=datatug.js.map
