// Триггеры цифровой воронки amoCRM: что на каком этапе запускается (любые триггеры: задачи,
// Salesbot, смена этапа, теги, поля, вебхуки, виджеты — включая Sensei).
// В публичном API amoCRM этого нет. Запускать в браузере, где аккаунт открыт и вы в нём
// авторизованы: DevTools → Console, либо инструмент ИИ, который выполняет JavaScript на странице.
// Только читает: GET-запросы с куками текущей сессии, ничего не меняет и никуда, кроме самого
// аккаунта, не ходит.
//
// Откуда берётся: страница /settings/pipeline/leads/<id воронки> несёт в HTML вызов
//   AMOCRM.constant('settings_pipeline_template_params', {...})
// и в нём data.actions[<ряд>][<id этапа>] — по объекту на триггер:
//   action               — что делает (create_task, change_status, send_widget_hook, ...),
//   handler_code         — "amocrm" (встроенный) или "widget" (виджет, тогда widget_code),
//   execution_condition  — событие (lead_status_changed = «после перехода в этап»),
//   delay                — задержка в секундах,
//   conditions_groups    — условия «для всех сделок, у которых…»,
//   settings             — настройки действия (у Sensei: settings.widget.settings.process_id).
// Там же data.statuses[].forward_events — события этапа («входящее письмо → в этот этап»).
//
// Это внутреннее устройство интерфейса amoCRM, а не обещанный API: после обновления amoCRM
// разметка может измениться. Скрипт тогда не соврёт, а скажет в problems, что блок не найден.
//
// Как запустить:
//   в консоли браузера:   copy(JSON.stringify(await (<эта функция>)(), null, 2))
//   в инструменте ИИ:     window.__dp = await (<эта функция>)(); затем читать window.__dp по частям
async () => {
  const CONSTANT = "settings_pipeline_template_params";
  const SYSTEM_STAGES = { 142: "Успешно реализовано", 143: "Закрыто и не реализовано" };

  const readConstant = (html) => {
    const at = html.indexOf(`AMOCRM.constant('${CONSTANT}'`);
    if (at < 0) return null;
    const start = html.indexOf("{", at);
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let k = start; k < html.length; k++) {
      const ch = html[k];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return JSON.parse(html.slice(start, k + 1));
      }
    }
    return null;
  };

  // Настройки без пустых значений и служебного шума: то, что отличает один триггер от другого.
  const NOISE = new Set(["is_trial_expired", "relative_date", "task_created", "field_value_changed", "change_in_related", "optional_conditions", "widget_info", "button_id"]);
  const clean = (v, depth = 0) => {
    if (v === null || v === undefined || v === "" || v === false) return undefined;
    if (typeof v === "string") return v.length > 300 ? v.slice(0, 300) + "…" : v;
    if (typeof v !== "object") return v;
    if (depth > 5) return "…";
    if (Array.isArray(v)) {
      const items = v.map((x) => clean(x, depth + 1)).filter((x) => x !== undefined);
      return items.length ? items : undefined;
    }
    const out = {};
    for (const k of Object.keys(v)) {
      if (NOISE.has(k)) continue;
      const c = clean(v[k], depth + 1);
      if (c !== undefined) out[k] = c;
    }
    return Object.keys(out).length ? out : undefined;
  };

  const readConditions = (t) =>
    (Array.isArray(t.conditions_groups) ? t.conditions_groups : Object.values(t.conditions_groups || {})).map((g) => ({
      type: g.type,
      ...(g.options && g.options.id !== undefined ? { field_id: g.options.id } : {}),
      name: g.options && g.options.name,
      logic: g.logic_operator,
      values: (Array.isArray(g.conditions) ? g.conditions : Object.values(g.conditions || {})).map((c) => ({
        operator: c.operator,
        ...(c.id !== undefined ? { id: c.id } : {}),
        ...(c.name !== undefined ? { name: c.name } : {}),
        ...(c.value !== undefined ? { value: c.value } : {}),
      })),
    }));

  const pipelines = (await fetch("/api/v4/leads/pipelines", { credentials: "same-origin" }).then((r) => r.json()))._embedded.pipelines;
  const stageNames = {};
  for (const p of pipelines) for (const s of p._embedded.statuses || []) stageNames[`${p.id}:${s.id}`] = `${p.name} → ${s.name}`;

  const out = { account: location.hostname, read_at: new Date().toISOString(), pipelines: [], triggers: [], stage_events: [], problems: [] };

  for (const p of pipelines) {
    const stages = Object.fromEntries((p._embedded.statuses || []).map((s) => [String(s.id), s.name]));
    const res = await fetch(`/settings/pipeline/leads/${p.id}`, { credentials: "same-origin" });
    const params = res.ok ? readConstant(await res.text()) : null;
    const actions = params && params.data && params.data.actions;
    if (!actions) {
      out.pipelines.push({ pipeline_id: p.id, name: p.name, stages: Object.keys(stages).length, triggers: null });
      out.problems.push({ pipeline_id: p.id, problem: `страница настройки не прочитана (HTTP ${res.status}) или в ней нет ${CONSTANT}` });
      continue;
    }
    // «Входящее письмо / звонок / заход на сайт / чат → перевести сделку в этап»: включённые события этапов.
    const stageList = Array.isArray(params.data.statuses) ? params.data.statuses : Object.values(params.data.statuses || {});
    for (const st of stageList) {
      for (const ev of Object.values((st && st.forward_events) || {})) {
        if (!ev || !Number(ev.enabled)) continue;
        out.stage_events.push({ pipeline_id: p.id, pipeline: p.name, status_id: Number(st.id), stage: stages[String(st.id)] || st.option || null, event_id: ev.id, event: ev.name, settings: clean(ev.settings) });
      }
    }
    let count = 0;
    for (const row of Object.keys(actions)) {
      for (const statusId of Object.keys(actions[row] || {})) {
        const t = actions[row][statusId];
        if (!t || typeof t !== "object" || !t.id) continue;
        count++;
        const s = t.settings || {};
        const w = (s.widget && s.widget.settings) || {};
        const sensei = t.widget_code === "amo_sensei";
        const conditions = readConditions(t);
        const trigger = {
          trigger_id: t.id,
          pipeline_id: p.id,
          pipeline: p.name,
          status_id: Number(statusId),
          stage: stages[statusId] || SYSTEM_STAGES[statusId] || null,
          row: Number(row),
          action: t.action,
          handler: t.handler_code === "widget" ? `widget:${t.widget_code || t.widget_id}` : t.handler_code,
          title: (s.widget_info && s.widget_info.name) || undefined,
          event: t.execution_condition && t.execution_condition.name,
          delay_sec: Number(t.delay) || 0,
          conditions: conditions.length ? conditions : undefined,
        };
        if (sensei) {
          trigger.sensei = {
            process_id: Number(w.process_id),
            process_name_at_setup: w.process_name,
            direction: w.process_direction === "stop" ? "stop" : "start",
            close_tasks: Boolean(w.close_tasks),
          };
        } else if (t.action === "change_status") {
          trigger.moves_to = { pipeline_id: Number(s.pipe_id), status_id: Number(s.status_id), name: stageNames[`${s.pipe_id}:${s.status_id}`] || SYSTEM_STAGES[s.status_id] || null };
        }
        if (!sensei) trigger.settings = clean(s);
        out.triggers.push(trigger);
      }
    }
    out.pipelines.push({ pipeline_id: p.id, name: p.name, stages: Object.keys(stages).length, triggers: count });
  }

  const byAction = {};
  for (const t of out.triggers) byAction[t.action] = (byAction[t.action] || 0) + 1;
  // Отпечаток для сверки двух чтений: одинаковый набор триггеров даёт одинаковое число.
  let print = 0;
  for (const line of out.triggers.map((t) => `${t.trigger_id}:${t.status_id}:${t.row}:${t.action}:${t.delay_sec}`).sort()) {
    for (let i = 0; i < line.length; i++) print = (print * 31 + line.charCodeAt(i)) >>> 0;
  }
  out.summary = { triggers: out.triggers.length, sensei: out.triggers.filter((t) => t.sensei).length, stage_events: out.stage_events.length, by_action: byAction, fingerprint: print };
  return out;
};
