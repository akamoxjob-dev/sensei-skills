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
// Там же: data.statuses[] — события этапа (forward_events) и подсказки (descriptions);
// data.lead_sources, unsorted, duplication_control, scoring — левая колонка настройки;
// data.custom_task_types, chat_sources, element_custom_fields — справочники для названий.
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
  const NOISE = new Set(["is_trial_expired", "relative_date", "task_created", "field_value_changed", "optional_conditions", "widget_info", "button_id"]);
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

  // Источники чата приходят то списком id, то списком объектов.
  const listOrIds = (v) => (Array.isArray(v) ? v : Object.values(v || {})).map((x) => (x && typeof x === "object" ? x.id : x)).filter((x) => x !== undefined && x !== null && x !== "");

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

  const out = { account: location.hostname, read_at: new Date().toISOString(), pipelines: [], triggers: [], stage_events: [], stage_hints: [], warnings: [], problems: [] };

  // Справочники страницы бывают и списком, и объектом по id; название лежит в name, option или title.
  const listOf = (v) => (Array.isArray(v) ? v : Object.values(v || {})).filter((x) => x && typeof x === "object");
  const nameOf = (x) => (x && (x.name || x.option || x.title)) || undefined;
  const lookup = (dict, id) => nameOf(listOf(dict).find((x) => String(x.id) === String(id)));
  const STANDARD_TASK_TYPES = { 1: "Связаться", 2: "Встреча" };

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
    const data = params.data;
    const fields = data.element_custom_fields || {};
    const fieldKnown = (id) => Object.keys(fields).length === 0 || Object.hasOwn(fields, String(id));
    const sources = listOf(data.lead_sources);
    const panel = {
      lead_sources: sources.length,
      lead_source_names: sources.map((x) => nameOf(x) || x.origin_name).filter(Boolean).slice(0, 60),
      unsorted_enabled: Boolean(data.unsorted && data.unsorted.enabled),
      duplication_control_enabled: Boolean(data.duplication_control && data.duplication_control.enabled),
      scoring_enabled: Boolean(data.scoring && data.scoring.enabled),
    };
    const stageList = listOf(data.statuses);
    for (const st of stageList) {
      const hints = listOf(st.descriptions).map((h) => ({ level: h.level, text: clean(h.description) })).filter((h) => h.text);
      if (hints.length) out.stage_hints.push({ pipeline_id: p.id, pipeline: p.name, status_id: Number(st.id), stage: stages[String(st.id)] || st.option || null, hints });
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
        // Уточнения события: в каких источниках чата, входящим или любым сообщением и т. п.
        const { id: _eid, event_id: _ev, name: _en, hidden_cool_down: _hc, ...eventRest } = t.execution_condition || {};
        const eventOptions = clean(eventRest);
        if (eventOptions) trigger.event_options = eventOptions;
        const chatIds = [...new Set([...(listOrIds(t.execution_condition && t.execution_condition.chat_sources)), ...(listOrIds(t.conditions && t.conditions.chat_sources))])];
        if (chatIds.length) trigger.chat_sources = chatIds.map((id) => ({ id, name: lookup(data.chat_sources, id) }));
        // «Только в рабочее время», точная дата, повтор — когда заданы.
        const workTime = clean(t.work_time);
        if (workTime || t.work_time_id) trigger.work_time = workTime || { id: t.work_time_id };
        if (t.date_exec && t.date_exec !== "0") trigger.date_exec = t.date_exec;
        const recurrent = clean(t.recurrent);
        if (recurrent) trigger.recurrent = recurrent;
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
        // Широкий триггер стоит сразу на нескольких этапах: в данных он один, под первым этапом.
        const span = (Array.isArray(t.statuses) ? t.statuses : []).filter((id) => String(id) !== String(statusId));
        if (span.length) trigger.also_on_stages = span.map((id) => ({ status_id: Number(id), stage: stages[String(id)] || SYSTEM_STAGES[id] || null }));
        if (t.action === "create_task") {
          // Срок задачи (deadline) — не задержка триггера (delay_sec): не путать.
          trigger.task = {
            type_id: s.task_type,
            type: lookup(data.custom_task_types, s.task_type) || STANDARD_TASK_TYPES[s.task_type] || undefined,
            text: s.task_text || undefined,
            deadline: s.deadline || undefined,
            responsible: s.user_name || s.responsible_user || undefined,
          };
        }
        if (!sensei) trigger.settings = clean(s);
        // Мёртвые ссылки: триггер пишет в поле или проверяет поле, которого на странице уже нет.
        const usedFields = [
          ...listOf(s.fields).map((f) => f.field_id),
          ...conditions.filter((c) => c.type === "custom_field" && c.field_id !== undefined).map((c) => c.field_id),
        ].filter((id) => id !== undefined && id !== "");
        for (const id of [...new Set(usedFields.map(String))]) {
          if (!fieldKnown(id)) out.warnings.push({ trigger_id: t.id, pipeline: p.name, stage: trigger.stage, row: trigger.row, action: t.action, warning: `поле ${id} не найдено среди полей аккаунта: возможно, удалено` });
        }
        out.triggers.push(trigger);
      }
    }
    out.pipelines.push({ pipeline_id: p.id, name: p.name, stages: Object.keys(stages).length, triggers: count, ...panel });
    if (data.triggers_count !== undefined) out.amocrm_triggers_count = data.triggers_count;
  }

  const byAction = {};
  for (const t of out.triggers) byAction[t.action] = (byAction[t.action] || 0) + 1;
  // Отпечаток для сверки двух чтений: одинаковый набор триггеров даёт одинаковое число.
  let print = 0;
  for (const line of out.triggers.map((t) => `${t.trigger_id}:${t.status_id}:${t.row}:${t.action}:${t.delay_sec}`).sort()) {
    for (let i = 0; i < line.length; i++) print = (print * 31 + line.charCodeAt(i)) >>> 0;
  }
  out.summary = { triggers: out.triggers.length, sensei: out.triggers.filter((t) => t.sensei).length, stage_events: out.stage_events.length, stage_hints: out.stage_hints.length, warnings: out.warnings.length, by_action: byAction, fingerprint: print };
  return out;
};
