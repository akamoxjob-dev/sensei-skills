async () => {
  // Раскраска схемы процесса Sensei в открытом конструкторе (my.sensei.plus/constructor/...).
  // ТОЛЬКО картинка: меняет цвета SVG на экране. В модель схемы, в черновик и в Sensei ничего не пишет.
  // Настройки (необязательно) — до запуска положить в window.__rbOptions:
  //   { hub: "<id элемента-центра>", names: { "<result_id>": "подпись ветки" } }
  // Без настроек центр = блок, из которого выходит больше всего стрелок (обычно главная задача).
  const O = window.__rbOptions || {};
  const PALETTE = ["#e6194b", "#f58231", "#c9a400", "#3cb44b", "#00a3a3", "#1e90ff", "#4363d8", "#911eb4",
    "#f032e6", "#9a6324", "#808000", "#800000", "#ff69b4", "#2f4f4f", "#008080", "#b8860b"];
  const START_COLOR = "#555555", ORPHAN_COLOR = "#ff0000";
  const svgs = [...document.querySelectorAll("svg")];
  const root = document.querySelector("svg#tests") || svgs.sort((a, b) => b.querySelectorAll("*").length - a.querySelectorAll("*").length)[0];
  if (!root) return { error: "схема не найдена — дождись загрузки конструктора" };

  const typeOf = (s) => ([...s.attributes].map((a) => a.name).find((n) => n.startsWith("sensei_")) || "").slice(7);
  const labelOf = (s) => {
    const t = s.querySelector(".sensei-element-title"), x = s.querySelector(".test");
    return [t && t.textContent.trim(), x && x.textContent.trim()].filter(Boolean).join(": ").slice(0, 90);
  };
  const nodes = [...root.querySelectorAll("svg[id]")].filter((s) => /^\d+$/.test(s.id));
  const big = new Map();   // id -> основной блок (не мини-копия)
  nodes.forEach((s) => {
    if (s.querySelector("foreignObject.border_element_small")) return;
    if (!big.has(s.id)) big.set(s.id, s);
  });
  const edges = [...root.querySelectorAll("g[id]")].filter((g) => /^\d+_\d+_\d+$/.test(g.id)).map((g) => {
    const [from, to, rid] = g.id.split("_");
    const cap = ((g.querySelector(".caption") || {}).textContent || "").trim();
    const p = g.querySelector("path");
    const nums = ((p && p.getAttribute("d")) || "").match(/-?\d+(\.\d+)?/g) || [];
    const end = nums.length >= 2 ? [parseFloat(nums[nums.length - 2]), parseFloat(nums[nums.length - 1])] : null;
    return { g, from, to, rid, cap, end };
  });
  const out = {}, inc = {};
  edges.forEach((e) => { (out[e.from] = out[e.from] || []).push(e); (inc[e.to] = inc[e.to] || []).push(e); });

  // центр
  let hub = O.hub ? String(O.hub) : null;
  if (!hub) {
    let best = 0;
    big.forEach((s, id) => {
      const n = new Set((out[id] || []).map((e) => e.to)).size + (typeOf(s) === "task" ? 0.5 : 0);
      if (n > best) { best = n; hub = id; }
    });
  }
  const starts = [...big.keys()].filter((id) => typeOf(big.get(id)) === "start");
  // оторванные входы: блок, в который не ведёт ни одна стрелка (кроме старта и служебных пустышек)
  const orphans = [...big.keys()].filter((id) => !inc[id] && !["start", "fake"].includes(typeOf(big.get(id))));

  const branches = [], byTarget = {}, extraEdges = [];
  (out[hub] || []).forEach((e) => {
    if (byTarget[e.to] !== undefined) { extraEdges.push([e.g, byTarget[e.to]]); branches[byTarget[e.to]].name += " / " + (e.cap || "?"); return; }
    byTarget[e.to] = branches.length;
    branches.push({ name: (O.names && O.names[e.rid]) || e.cap || ("→ " + labelOf(big.get(e.to) || { querySelector: () => null })), first: e });
  });
  const memb = {}, edgeBranch = new Map();
  const walk = (bi, from) => {
    const st = [from], seen = new Set();
    while (st.length) {
      const n = st.pop();
      if (seen.has(n) || n === hub) continue;
      seen.add(n);
      (memb[n] = memb[n] || new Set()).add(bi);
      (out[n] || []).forEach((e) => { if (!edgeBranch.has(e.g)) edgeBranch.set(e.g, bi); st.push(e.to); });
    }
  };
  branches.forEach((b, i) => { b.color = PALETTE[i % PALETTE.length]; edgeBranch.set(b.first.g, i); walk(i, b.first.to); });
  extraEdges.forEach(([g, bi]) => edgeBranch.set(g, bi));
  const SB = branches.length; branches.push({ name: "Старт процесса (до центра)", color: START_COLOR });
  starts.forEach((s) => walk(SB, s));
  let OB = -1;
  if (orphans.length) { OB = branches.length; branches.push({ name: "Оторванный вход — в него ничего не ведёт", color: ORPHAN_COLOR }); orphans.forEach((s) => walk(OB, s)); }

  // стрелки
  edges.forEach((e) => {
    const bi = edgeBranch.get(e.g);
    if (bi === undefined) return;
    const c = branches[bi].color;
    e.g.querySelectorAll("path").forEach((p) => {
      if (p.getAttribute("visibility") === "hidden") return;
      const arrow = (p.getAttribute("fill") || "none") !== "none";
      p.setAttribute("stroke", c);
      if (arrow) p.setAttribute("fill", c); else p.setAttribute("stroke-width", "4");
    });
  });
  // блоки
  const shared = [], unreached = [];
  let stubs = 0;
  nodes.forEach((s) => {
    const fo = s.querySelector("foreignObject.border_element, foreignObject.border_element_small");
    if (!fo) return;
    if (fo.classList.contains("border_element_small")) {
      const x = +s.getAttribute("x"), y = +s.getAttribute("y"), w = +s.getAttribute("width"), h = +s.getAttribute("height");
      const e = (inc[s.id] || []).find((e) => e.end && e.end[0] >= x - 15 && e.end[0] <= x + w + 15 && e.end[1] >= y - 15 && e.end[1] <= y + h + 15);
      const bi = e ? edgeBranch.get(e.g) : undefined;
      if (bi !== undefined) { fo.style.outline = `3px solid ${branches[bi].color}`; fo.style.outlineOffset = "-3px"; stubs++; }
      return;
    }
    if (big.get(s.id) !== s) return;
    if (s.id === hub) { fo.style.outline = "6px double #000"; fo.style.outlineOffset = "-6px"; return; }
    const set = memb[s.id];
    if (!set) { unreached.push(s.id); return; }
    const arr = [...set];
    if (orphans.includes(s.id)) { fo.style.outline = `6px dashed ${ORPHAN_COLOR}`; fo.style.outlineOffset = "-6px"; return; }
    if (arr.length === 1) { fo.style.outline = `5px solid ${branches[arr[0]].color}`; fo.style.outlineOffset = "-5px"; return; }
    fo.style.outline = "3px dashed #000"; fo.style.outlineOffset = "-3px";
    fo.style.boxShadow = arr.map((bi, k) => `inset 0 0 0 ${6 + k * 5}px ${branches[bi].color}`).join(",");
    shared.push(s.id);
  });

  // легенда
  const hubLabel = big.get(hub) ? labelOf(big.get(hub)) : hub;
  let lg = document.getElementById("rainbow-legend");
  if (!lg) { lg = document.createElement("div"); lg.id = "rainbow-legend"; document.body.appendChild(lg); }
  lg.style.cssText = "position:fixed;top:70px;right:12px;z-index:99999;background:#fff;border:1px solid #999;border-radius:8px;padding:10px 12px;font:12px/1.35 sans-serif;max-width:360px;max-height:80vh;overflow:auto;box-shadow:0 2px 10px rgba(0,0,0,.2)";
  const sw = (css) => `<span style="display:inline-block;width:14px;height:10px;${css};margin-right:6px;vertical-align:middle"></span>`;
  lg.innerHTML = `<b>Ветки от «${hubLabel}»</b><br>` +
    branches.map((b) => `<div>${sw("background:" + b.color)}${b.name}</div>`).join("") +
    `<hr style="margin:6px 0"><div>${sw("outline:3px double #000")}центр (от него ветки)</div>` +
    `<div>${sw("outline:2px dashed #000")}общий блок — сюда сходятся несколько веток (кольца их цветов)</div>` +
    `<div>${sw("outline:2px dashed " + ORPHAN_COLOR)}оторванный вход — проверить по аналитике, срабатывал ли</div>` +
    `<div>маленький блок = ссылка на блок, нарисованный в другом месте; рамка — цвет ветки, которая в него ведёт</div>` +
    (orphans.length ? `<div style="margin-top:4px"><b>Оторванные:</b> ${orphans.map((id) => id + " " + labelOf(big.get(id))).join("; ")}</div>` : "") +
    `<div style="color:#888;margin-top:4px">Только подсветка в браузере, схема не меняется. Обновить страницу — подсветка пропадёт.</div>`;

  return {
    hub: { id: hub, label: hubLabel, out: (out[hub] || []).length },
    branches: branches.map((b) => `${b.name} ${b.color}`),
    starts, orphans: orphans.map((id) => ({ id, type: typeOf(big.get(id)), label: labelOf(big.get(id)) })),
    shared: shared.length, stubs, unreached,
    counts: { blocks: big.size, miniCopies: nodes.length - big.size, edges: edges.length, coloredEdges: edgeBranch.size },
  };
}
