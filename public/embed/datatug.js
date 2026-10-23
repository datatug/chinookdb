// libs/datatug/embed/src/legacy-dtql-ovdb-metadata.ts
var e = [
	"",
	"Streaming",
	"StreamingErrors"
];
function t(t) {
	let n = t, r = { ...n };
	for (let t of e) {
		let e = n[`dtql${t}`];
		r[`tugql${t}`] === void 0 && e !== void 0 && (r[`tugql${t}`] = e);
	}
	return r;
}
function n(e) {
	return e.includes("tugql") || e.includes("dtql");
}
function r(e) {
	return e?.tugql ? e.tugql : e?.dtql?.replace(/\/dtql(?=$|[?#])/u, "/tugql");
}
function i(e) {
	return e?.replace(/^dtql-/u, "tugql-");
}
// libs/datatug/embed/src/data.ts
function a(e, t) {
	let n = new URL(e, t);
	if (!["http:", "https:"].includes(n.protocol) || n.username || n.password) throw Error("Source URL must be HTTP(S) without embedded credentials.");
	return n;
}
function o(e) {
	return typeof e == "object" && !!e && !Array.isArray(e);
}
function s(e) {
	let t = o(e) ? e : void 0, n = Array.isArray(e) ? e : t?.records ?? t?.rows ?? t?.data;
	if (!Array.isArray(n)) throw Error("JSON source must be a row array or contain records, rows, or data.");
	let r = [], i = [];
	for (let e of n) {
		if (!o(e)) throw Error("Every JSON row must be an object.");
		o(e.data) && typeof e.key == "string" ? (r.push(e.data), i.push(e.key)) : r.push(e);
	}
	return {
		rows: r,
		columns: Array.isArray(t?.columns) && t.columns.every((e) => typeof e == "string") ? t.columns : [...new Set(r.flatMap((e) => Object.keys(e)))],
		keys: i.length === r.length ? i : void 0,
		metadata: t
	};
}
function c(e) {
	let t = [], n = [], r = "", i = !1, a = e.replace(/^\uFEFF/, "");
	for (let e = 0; e < a.length; e++) {
		let o = a[e];
		if (i) o === "\"" && a[e + 1] === "\"" ? (r += "\"", e++) : o === "\"" ? i = !1 : r += o;
		else if (o === "\"") {
			if (r) throw Error("Malformed CSV quote.");
			i = !0;
		} else o === "," ? (n.push(r), r = "") : o === "\n" || o === "\r" ? (o === "\r" && a[e + 1] === "\n" && e++, n.push(r), t.push(n), n = [], r = "") : r += o;
	}
	if (i) throw Error("Unclosed CSV quote.");
	if ((r || n.length) && (n.push(r), t.push(n)), !t.length) return {
		rows: [],
		columns: []
	};
	let o = t.shift() ?? [];
	if (o.some((e) => !e) || new Set(o).size !== o.length) throw Error("CSV header columns must be nonempty and unique.");
	return {
		columns: o,
		rows: t.map((e) => {
			if (e.length !== o.length) throw Error("CSV row has a different number of columns than its header.");
			return Object.fromEntries(o.map((t, n) => [t, e[n]]));
		})
	};
}
function l(e, t, n) {
	let r = e?.split(";", 1)[0]?.trim().toLowerCase();
	if (r === "application/json" || r?.endsWith("+json")) return "json";
	if (r === "text/csv" || r === "application/csv") return "csv";
	let i = t.pathname.toLowerCase();
	if (i.endsWith(".json")) return "json";
	if (i.endsWith(".csv")) return "csv";
	if (n === "json" || n === "csv") return n;
	throw Error("Cannot detect data format. Set format=\"json\" or format=\"csv\".");
}
async function u(e, t) {
	if (e.ok) return e;
	let n = "";
	try {
		let t = await e.json();
		if (o(t)) {
			let e = t.error, r = t.message ?? (o(e) ? e.message : e);
			typeof r == "string" && (n = r);
		}
	} catch {}
	throw Error(`${t} failed (${e.status})${n ? `: ${n}` : ""}.`);
}
async function d(e, t, n) {
	let r = a(e, document.baseURI), i = await u(await fetch(r, {
		signal: n,
		credentials: "same-origin",
		headers: { Accept: "application/json, text/csv;q=0.9" }
	}), "Data request");
	return l(i.headers.get("Content-Type"), r, t) === "json" ? s(await i.json()) : c(await i.text());
}
async function f(e, c, l, d) {
	let f = a(e, document.baseURI), p = new URL("/.well-known/openvaultdb", f.origin), m = (await (await u(await fetch(p, {
		signal: d,
		credentials: "same-origin",
		headers: { Accept: "application/json" }
	}), "OVDB discovery")).json()).databases?.find((e) => {
		if (!e.url) return !1;
		try {
			return a(e.url, p.href).href.replace(/\/$/, "") === f.href.replace(/\/$/, "");
		} catch {
			return !1;
		}
	});
	if (!m?.apiUrl) throw Error("OVDB discovery does not list this database connection URL.");
	let h = a(m.apiUrl, p.href), g = await (await u(await fetch(h, {
		signal: d,
		credentials: "same-origin",
		headers: { Accept: "application/json" }
	}), "OVDB database metadata")).json(), _ = g.capabilities ?? m.capabilities, v = Array.isArray(_) ? n(_) : o(_) && t(_).tugql === !0, y = r(g.endpoints);
	if (!v || !y) throw Error("This OVDB database does not advertise TugQL queries.");
	let b = a(y, h.href), x = i(g.queryFormat), S, C;
	if (x === "tugql-yaml+json") S = JSON.stringify({
		query: c,
		parameters: l
	}), C = "application/json";
	else if (x === "tugql-yaml") {
		if (Object.keys(l).length) throw Error("This OVDB endpoint does not support bound TugQL parameters.");
		S = c, C = "application/yaml";
	} else throw Error(`Unsupported OVDB query format: ${x ?? "missing"}.`);
	return s(await (await u(await fetch(b, {
		method: "POST",
		signal: d,
		credentials: "same-origin",
		headers: {
			"Content-Type": C,
			Accept: "application/json"
		},
		body: S
	}), "TugQL query")).json());
}
// libs/datatug/embed/src/index.ts
var p = "\n:host{display:block;box-sizing:border-box;color:var(--datatug-fg,#18304a);font:var(--datatug-font,14px/1.45 system-ui,sans-serif);background:var(--datatug-bg,#fff);border:1px solid var(--datatug-border,#dce5ee);border-radius:var(--datatug-radius,10px);overflow:hidden;min-width:0}\n*{box-sizing:border-box}button,input,select{font:inherit;color:inherit}button{cursor:pointer;background:var(--datatug-button-bg,#f5f8fb);border:1px solid var(--datatug-border,#dce5ee);border-radius:5px;padding:.25rem .55rem}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,th button:focus-visible{outline:2px solid var(--datatug-accent,#2879b9);outline-offset:2px}\n.toolbar{display:flex;align-items:center;justify-content:space-between;gap:.65rem;padding:.7rem .85rem;border-bottom:1px solid var(--datatug-border,#dce5ee);flex-wrap:wrap}.brand{font-weight:700;letter-spacing:.01em}.tools{display:flex;align-items:center;gap:.45rem;flex-wrap:wrap}.tools input{max-width:13rem;min-width:7rem;border:1px solid var(--datatug-border,#dce5ee);border-radius:5px;padding:.26rem .45rem}.status{padding:.8rem;color:var(--datatug-muted,#587087)}.error{color:var(--datatug-error,#ab2e39)}.scroller{overflow:auto;max-height:var(--datatug-max-height,32rem)}table{border-collapse:collapse;min-width:100%;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:.46rem .7rem;border-bottom:1px solid var(--datatug-border,#dce5ee);vertical-align:top;white-space:nowrap;max-width:32rem;overflow:hidden;text-overflow:ellipsis}th{position:sticky;top:0;background:var(--datatug-header-bg,#f4f8fb);color:var(--datatug-muted,#587087);font-size:.84em;font-weight:650}th button{border:0;background:none;padding:0;font-weight:inherit;color:inherit}tbody tr:hover{background:var(--datatug-hover,#f5f9fc)}tbody tr[aria-selected=true]{background:var(--datatug-selected,#e7f3fc)}.footer{display:flex;align-items:center;justify-content:space-between;gap:.6rem;padding:.55rem .85rem;color:var(--datatug-muted,#587087);font-size:.85em}.pager{display:flex;gap:.35rem;align-items:center}.chart{padding:.8rem}.bar{display:grid;grid-template-columns:minmax(5rem, 30%) 1fr auto;gap:.6rem;align-items:center;margin:.38rem 0}.track{height:.8rem;border-radius:3px;background:var(--datatug-header-bg,#f4f8fb);overflow:hidden}.fill{height:100%;background:var(--datatug-accent,#2879b9)}.label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n";
function m(e, t) {
	let n = document.createElement(e);
	return t !== void 0 && (n.textContent = t), n;
}
function h(e) {
	return e == null ? "—" : typeof e == "object" ? JSON.stringify(e) : String(e);
}
function g(e, t) {
	if (t === "string" || !t) return e;
	if (t === "number") {
		if (!e.trim() || !Number.isFinite(Number(e))) throw Error("Invalid number parameter.");
		return Number(e);
	}
	if (t === "boolean") {
		if (e !== "true" && e !== "false") throw Error("Boolean parameter must be true or false.");
		return e === "true";
	}
	if (t === "null") return null;
	throw Error(`Unsupported TugQL parameter type: ${t}.`);
}
var _ = class extends HTMLElement {
	connectedCallback() {
		this.style.display = "none", this.observer = new MutationObserver(() => this.notify()), this.observer.observe(this, {
			childList: !0,
			characterData: !0,
			subtree: !0
		});
	}
	disconnectedCallback() {
		this.observer?.disconnect();
	}
	notify() {
		this.dispatchEvent(new Event("tugql-change", { bubbles: !0 }));
	}
}, v = class extends HTMLElement {
	constructor(...e) {
		super(...e), this.propertySet = !1;
	}
	static get observedAttributes() {
		return [
			"name",
			"value",
			"type"
		];
	}
	get value() {
		return this.propertySet ? this.propertyValue : g(this.getAttribute("value") ?? "", this.getAttribute("type"));
	}
	set value(e) {
		if (e !== null && ![
			"string",
			"number",
			"boolean"
		].includes(typeof e)) throw TypeError("TugQL parameter value must be a JSON scalar.");
		this.propertySet = !0, this.propertyValue = e, this.notify();
	}
	attributeChangedCallback(e) {
		(e === "value" || e === "type") && (this.propertySet = !1), this.notify();
	}
	connectedCallback() {
		this.style.display = "none", this.notify();
	}
	notify() {
		this.dispatchEvent(new Event("tugql-change", { bubbles: !0 }));
	}
}, y = class extends HTMLElement {
	static get observedAttributes() {
		return [
			"connection",
			"data-url",
			"format",
			"type",
			"page-size"
		];
	}
	constructor() {
		super(), this.root = this.attachShadow({ mode: "open" }), this.state = "loading", this.message = "", this.scheduled = !1, this.revision = 0, this.onChildChange = () => this.schedule(), this.root.append(m("style", p));
	}
	connectedCallback() {
		this.addEventListener("tugql-change", this.onChildChange), this.observer = new MutationObserver(() => this.schedule()), this.observer.observe(this, {
			childList: !0,
			subtree: !1
		}), this.schedule();
	}
	disconnectedCallback() {
		this.removeEventListener("tugql-change", this.onChildChange), this.observer?.disconnect(), this.controller?.abort(), this.revision++;
	}
	attributeChangedCallback() {
		this.schedule();
	}
	schedule() {
		this.isConnected && !this.scheduled && (this.scheduled = !0, queueMicrotask(() => {
			this.scheduled = !1, this.isConnected && this.refresh();
		}));
	}
	async refresh() {
		this.controller?.abort();
		let e = new AbortController();
		this.controller = e;
		let t = ++this.revision;
		this.state = "loading", this.message = "Loading data…", this.render();
		try {
			let n = this.getAttribute("connection"), r = this.getAttribute("data-url"), i = [...this.children].filter((e) => e.localName === "tugql-query"), a = i[0], o = [...this.children].filter((e) => e.localName === "tugql-param");
			if (!!n == !!r) throw Error("Set exactly one of connection or data-url.");
			if (r && (i.length || o.length)) throw Error("data-url cannot be combined with TugQL query or parameters.");
			if (n && (i.length !== 1 || !a?.textContent?.trim())) throw Error("A connection requires one nonempty <tugql-query>.");
			let s = Object.create(null);
			for (let e of o) {
				let t = e.getAttribute("name");
				if (!t || Object.hasOwn(s, t)) throw Error("Every <tugql-param> needs a unique nonempty name.");
				s[t] = e.value;
			}
			if (!r && (!n || !a?.textContent)) throw Error("A connection requires one nonempty <tugql-query>.");
			let c = r ? await d(r, this.getAttribute("format"), e.signal) : await f(n, a?.textContent?.trim() ?? "", s, e.signal);
			if (e.signal.aborted || t !== this.revision) return;
			this.validateData(c), this.data = c, this.state = c.rows.length ? "ready" : "empty", this.message = c.rows.length ? "" : "No rows found.", this.render(), this.dispatchEvent(new CustomEvent("datatug-data-loaded", {
				detail: {
					rows: c.rows.length,
					columns: c.columns,
					metadata: c.metadata
				},
				bubbles: !0
			}));
		} catch (n) {
			if (e.signal.aborted || t !== this.revision) return;
			this.data = void 0, this.state = "error", this.message = n instanceof Error ? n.message : "Could not load data.", this.render(), this.dispatchEvent(new CustomEvent("datatug-error", {
				detail: { message: this.message },
				bubbles: !0
			}));
		}
	}
	reload() {
		return this.refresh();
	}
	validateData(e) {
		if (!Array.isArray(e.rows)) throw Error("The source did not return rows.");
	}
	shell(e) {
		[...this.root.children].filter((e) => e.localName !== "style").forEach((e) => e.remove());
		let t = m("div"), n = m("div");
		n.className = "toolbar";
		let r = m("span", e);
		return r.className = "brand", n.append(r), t.append(n), this.root.append(t), t;
	}
	statusNode(e) {
		if (this.state === "ready") return !1;
		let t = m("div", this.message);
		return t.className = `status ${this.state === "error" ? "error" : ""}`, t.setAttribute("role", this.state === "error" ? "alert" : "status"), e.append(t), !0;
	}
}, b = class extends y {
	constructor(...e) {
		super(...e), this.search = "", this.sortDesc = !1, this.page = 0;
	}
	render() {
		let e = this.shell("DataTug"), t = e.firstElementChild, n = m("div");
		n.className = "tools";
		let r = m("input");
		r.type = "search", r.placeholder = "Search rows", r.setAttribute("aria-label", "Search rows"), r.value = this.search;
		let i = () => {
			let e = r.selectionStart, t = r.selectionEnd;
			this.search = r.value, this.page = 0, this.render();
			let n = this.root.querySelector("input");
			n?.focus(), e !== null && t !== null && n?.setSelectionRange(e, t);
		};
		r.addEventListener("input", (e) => {
			e.isComposing || i();
		}), r.addEventListener("compositionend", i);
		let a = m("button", "Refresh");
		if (a.type = "button", a.addEventListener("click", () => void this.refresh()), n.append(r, a), t.append(n), this.statusNode(e)) return;
		let o = this.data;
		if (!o) return;
		let s = this.search.toLocaleLowerCase(), c = o.rows.map((e, t) => ({
			row: e,
			index: t
		})).filter(({ row: e }) => !s || o.columns.some((t) => h(e[t]).toLocaleLowerCase().includes(s)));
		if (this.sortColumn) {
			let e = this.sortColumn;
			c.sort((t, n) => {
				let r = t.row[e], i = n.row[e], a = typeof r == "number" && typeof i == "number" ? r - i : h(r).localeCompare(h(i), void 0, { numeric: !0 });
				return (this.sortDesc ? -a : a) || t.index - n.index;
			});
		}
		let l = Number(this.getAttribute("page-size")), u = Number.isInteger(l) && l > 0 ? Math.min(l, 500) : 50, d = Math.max(1, Math.ceil(c.length / u));
		this.page = Math.min(this.page, d - 1);
		let f = c.slice(this.page * u, (this.page + 1) * u), p = m("div");
		p.className = "scroller";
		let g = m("table"), _ = m("thead"), v = m("tr");
		for (let e of o.columns) {
			let t = m("th");
			t.scope = "col";
			let n = m("button", `${e}${this.sortColumn === e ? this.sortDesc ? " ↓" : " ↑" : ""}`);
			n.type = "button", n.addEventListener("click", () => {
				this.sortDesc = this.sortColumn === e && !this.sortDesc, this.sortColumn = e, this.page = 0, this.render();
			}), t.append(n), v.append(t);
		}
		_.append(v), g.append(_);
		let y = m("tbody");
		for (let { row: e, index: t } of f) {
			let n = m("tr");
			n.tabIndex = 0, n.setAttribute("aria-selected", String(this.selected === t));
			let r = () => {
				this.selected = t, y.querySelectorAll("tr").forEach((e) => e.setAttribute("aria-selected", String(e === n))), this.dispatchEvent(new CustomEvent("datatug-select", {
					detail: {
						row: e,
						index: t,
						key: o.keys?.[t]
					},
					bubbles: !0
				}));
			};
			n.addEventListener("click", r), n.addEventListener("keydown", (e) => {
				(e.key === "Enter" || e.key === " ") && (e.preventDefault(), r());
			});
			for (let t of o.columns) n.append(m("td", h(e[t])));
			y.append(n);
		}
		g.append(y), p.append(g), e.append(p);
		let b = m("div");
		b.className = "footer", b.append(m("span", `${c.length} of ${o.rows.length} rows`));
		let x = m("div");
		x.className = "pager";
		let S = m("button", "Previous");
		S.disabled = this.page === 0, S.addEventListener("click", () => {
			this.page--, this.render();
		});
		let C = m("button", "Next");
		C.disabled = this.page >= d - 1, C.addEventListener("click", () => {
			this.page++, this.render();
		}), x.append(S, m("span", `${this.page + 1} / ${d}`), C), b.append(x), e.append(b);
	}
}, x = class extends y {
	validateData(e) {
		let t = this.getAttribute("type") ?? "auto";
		if (t !== "auto" && t !== "bar") throw Error(`Unsupported chart type: ${t}.`);
		if (!e.rows.length) return;
		let n = e.columns.find((t) => e.rows.some((e) => typeof e[t] == "number")), r = e.columns.find((e) => e !== n);
		if (!n || !r) throw Error("Chart needs one numeric and one label column.");
	}
	render() {
		let e = this.shell("DataTug chart");
		if (this.statusNode(e)) return;
		let t = this.data;
		if (!t) return;
		let n = t.columns.find((e) => t.rows.some((t) => typeof t[e] == "number")), r = t.columns.find((e) => e !== n);
		if (!n || !r) return;
		let i = t.rows.slice(0, 20), a = Math.max(0, ...i.map((e) => Number(e[n]) || 0)), o = m("div");
		o.className = "chart", o.setAttribute("role", "img"), o.setAttribute("aria-label", `Bar chart of ${n} by ${r}`);
		for (let e of i) {
			let t = Number(e[n]) || 0, i = m("div");
			i.className = "bar";
			let s = m("span", h(e[r]));
			s.className = "label";
			let c = m("div");
			c.className = "track";
			let l = m("div");
			l.className = "fill", l.style.width = `${Math.max(0, a ? t / a * 100 : 0)}%`, c.append(l), i.append(s, c, m("span", h(t))), o.append(i);
		}
		e.append(o);
	}
};
customElements.get("tugql-query") || customElements.define("tugql-query", _), customElements.get("tugql-param") || customElements.define("tugql-param", v), customElements.get("datatug-grid") || customElements.define("datatug-grid", b), customElements.get("datatug-chart") || customElements.define("datatug-chart", x);
export { x as DataTugChart, b as DataTugGrid, v as TugqlParam, _ as TugqlQuery };

//# sourceMappingURL=datatug.js.map