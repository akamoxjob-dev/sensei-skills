// Установка триггеров цифровой воронки amoCRM запросом — с проверкой и откатом.
// Запускать в браузере, где аккаунт открыт и вы в нём авторизованы (администратор).
//
// ВНИМАНИЕ. amoCRM сохраняет цифровую воронку целиком: что не прислано в запросе — удаляется.
// Поэтому скрипт всегда: читает все триггеры воронки → добавляет новые → отправляет всё вместе →
// перечитывает → сверяет, что старые не изменились, а новые сохранились так, как просили.
// Не сошлось — возвращает воронку к прежнему набору и говорит, что не так.
//
// Как запустить:
//   1. Положить задание в window.__dpSet (пример ниже).
//   2. Выполнить эту функцию. По умолчанию это ПРОБНЫЙ прогон: ничего не отправляется,
//      скрипт только проверяет задание и показывает, что отправил бы.
//   3. Чтобы записать, добавить в задание apply: true.
//
//   window.__dpSet = {
//     pipeline_id: 1234567,
//     apply: false,
//     triggers: [
//       { stage: 111, action: "create_task", settings: { task_text: "Позвонить", task_type: 1, responsible_user: "current" } },
//       { stage: 111, action: "change_status", delay_sec: 300, settings: { pipe_id: 1234567, status_id: 222 },
//         conditions: [{ type: "tag", id: 5, name: "vip" }] },
//     ],
//   };
//
// Поля триггера: stage (id этапа), action, settings, event (по умолчанию lead_status_changed),
// event_options, delay_sec, row (по умолчанию первая свободная строка этапа), conditions.
// Условия: { type: "tag", id, name, operator? } · { type: "responsible", users: [{id, name}], groups: [{id, name}] } ·
//   { type: "price", from, to } · { type: "source", id, name } ·
//   { type: "field", field_id, operator, values: [...] }   — текстовое поле
//   { type: "field", field_id, enums: [id, ...] }          — список
//   { type: "field", field_id, from, to }                  — число
// Группа условий: logic: "or" (по умолчанию) или "and".
// Проверено 18.11.2026 на тестовой воронке. Это внутренний запрос интерфейса amoCRM, а не API:
// после обновления amoCRM скрипт может потребовать правки — тогда проверка после записи это покажет.
async () => {
  const job = window.__dpSet;
  if (!job || !job.pipeline_id || !Array.isArray(job.triggers) || !job.triggers.length) return { ok: false, error: "нет задания: window.__dpSet = { pipeline_id, triggers: [...] }" };
  const PID = job.pipeline_id;
  const CONSTANT = "settings_pipeline_template_params";
  // Чего скрипт не ставит: нужны данные, которых на странице нет, или формат не проверен.
  const UNSUPPORTED = { send_chat_message: "Salesbot", business_bot: "Businessbot", send_email: "письмо (нужна подключённая почта и шаблон)", create_and_fill_form: "анкета", link_customer: "блок «покупатель»" };
  const SUPPORTED = ["create_task", "change_status", "change_tags", "change_responsible", "close_tasks", "change_field_value", "send_hook", "delete_files", "create_lead", "send_widget_hook"];

  const readConstant = (html) => {
    const at = html.indexOf(`AMOCRM.constant('${CONSTANT}'`);
    if (at < 0) return null;
    const start = html.indexOf("{", at);
    let depth = 0, inString = false, escaped = false;
    for (let k = start; k < html.length; k++) {
      const ch = html[k];
      if (inString) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') inString = false; continue; }
      if (ch === '"') inString = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") { depth--; if (depth === 0) return JSON.parse(html.slice(start, k + 1)); }
    }
    return null;
  };
  const state = async () => { const c = readConstant(await fetch(`/settings/pipeline/leads/${PID}`, { credentials: "same-origin" }).then((r) => r.text())); return c && c.data; };
  const flat = (data) => { const out = []; for (const row of Object.keys(data.actions || {})) for (const st of Object.keys(data.actions[row] || {})) out.push(data.actions[row][st]); return [...new Map(out.map((t) => [t.id, t])).values()]; };
  const listOf = (v) => (Array.isArray(v) ? v : Object.values(v || {}));

  // Форма для отправки. Булевы значения — только 1/0: строку "false" сервер читает как «да».
  const norm = (v) => (v === true ? 1 : v === false ? 0 : v === null ? "" : Array.isArray(v) ? v.map(norm) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)])) : v);
  // Существующий триггер шлём как есть. У виджета подпись хранится отдельно: без поля name сервер её сотрёт.
  const resend = (t) => { const o = norm(t); const info = t.settings && t.settings.widget_info; if (t.handler_code === "widget" && info && info.name) o.name = info.name; return o; };
  // Суть триггера для сравнения «до» и «после». Автора и служебные поля сервер меняет сам.
  const sortKeys = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : Array.isArray(v) ? v.map(sortKeys) : v);
  const essence = (t) => { const s = Object.assign({}, t.settings || {}); delete s.created_by; delete s.task_created; return JSON.stringify(sortKeys({ a: t.action, st: t.statuses, row: t.row, ev: t.execution_condition, d: t.delay, cg: t.conditions_groups, s, wt: t.work_time, de: t.date_exec, rec: t.recurrent })); };
  const post = async (actions) => {
    const body = window.jQuery.param({ actions });
    const res = await fetch(`/ajax/settings/pipeline/leads/${PID}/save`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" }, body });
    const text = await res.text();
    try { return Object.assign({ http: res.status }, JSON.parse(text)); } catch (e) { return { http: res.status, status: "fail", error: `сервер ответил не JSON (HTTP ${res.status})` }; }
  };

  if (!window.jQuery || !window.jQuery.param) return { ok: false, error: "на странице нет jQuery: откройте страницу аккаунта amoCRM" };
  const before = await state();
  if (!before) return { ok: false, error: `настройка воронки ${PID} не прочитана: нет доступа или изменилась разметка amoCRM` };
  const existing = flat(before);
  const stages = new Set(listOf(before.statuses).map((s) => String(s.id)));
  const events = Object.fromEntries(listOf(before.condition_variants).map((e) => [e.name, e]));
  const fields = before.element_custom_fields || {};
  const users = new Set(listOf(before.users).map((u) => String(u.id)));
  const handler = (code) => (listOf(before.handlers).find((h) => h.code === code) || {}).id;
  const problems = [];
  const built = [];
  const taken = new Set(existing.flatMap((t) => (t.statuses || []).map((s) => `${s}:${t.row}`)));

  const buildConditions = (list, where) => {
    const groups = [];
    for (const c of list || []) {
      const logic = c.logic === "and" ? "and" : "or";
      if (c.type === "tag") {
        if (!c.id) { problems.push(`${where}: условие по тегу без id тега (по одному названию amoCRM отказывает)`); continue; }
        groups.push({ type: "tag", options: { name: "Теги", condition_id: "tag" }, logic_operator: logic, tmpl: "tag", conditions: [{ id: c.id, name: c.name || "", operator: c.operator === "not_equal" ? "not_equal" : "equal" }] });
      } else if (c.type === "responsible") {
        const items = [...(c.users || []).map((u) => ({ id: u.id, type: "user", name: u.name || "" })), ...(c.groups || []).map((g) => ({ id: g.id, type: "group", name: g.name || "" }))];
        if (!items.length) { problems.push(`${where}: условие по ответственному без пользователей и групп`); continue; }
        for (const u of c.users || []) if (!users.has(String(u.id))) problems.push(`${where}: пользователь ${u.id} не найден в аккаунте`);
        groups.push({ type: "responsible_user", options: { name: "Ответственный" }, logic_operator: logic, tmpl: "responsible_user", conditions: items });
      } else if (c.type === "price") {
        if (!Number.isFinite(Number(c.from)) || (c.to !== undefined && !Number.isFinite(Number(c.to)))) { problems.push(`${where}: бюджет должен быть числом`); continue; }
        if (c.to !== undefined && Number(c.to) && Number(c.from) > Number(c.to)) problems.push(`${where}: бюджет «от» больше «до» — amoCRM примет, но условие не выполнится никогда`);
        groups.push({ type: "price", options: { name: "Бюджет" }, logic_operator: logic, tmpl: "price", conditions: [Object.assign({ from: Number(c.from) }, c.to !== undefined ? { to: Number(c.to) } : {})] });
      } else if (c.type === "source") {
        if (!c.id) { problems.push(`${where}: условие по источнику без id источника`); continue; }
        groups.push({ type: "source", options: { name: "Источник", cf_type: 5 }, logic_operator: logic, tmpl: "source", conditions: [{ id: c.id, name: c.name || "", operator: "equal" }] });
      } else if (c.type === "field") {
        const f = fields[String(c.field_id)];
        if (!f) { problems.push(`${where}: поле ${c.field_id} не найдено в аккаунте`); continue; }
        const options = { id: f.id, cf_type: f.type_id, name: f.name };
        let conditions;
        if (Array.isArray(c.enums)) {
          const known = f.enums || {};
          const bad = c.enums.filter((e) => !known[String(e)]);
          if (!c.enums.length) { problems.push(`${where}: условие по списку «${f.name}» без вариантов`); continue; }
          if (bad.length) { problems.push(`${where}: у поля «${f.name}» нет вариантов ${bad.join(", ")}`); continue; }
          conditions = c.enums.map((e) => ({ enum: e, name: known[String(e)].value }));
        } else if (c.from !== undefined || c.to !== undefined) {
          if (f.type_id !== 2) { problems.push(`${where}: «от — до» работает только у числового поля, «${f.name}» другого типа (даты этим скриптом не ставятся)`); continue; }
          conditions = [{ from: Number(c.from) || 0, to: Number(c.to) || 0 }];
        } else {
          if (f.type_id === 2) { problems.push(`${where}: для числового поля «${f.name}» задавайте from и to — условие со значением amoCRM молча выбрасывает`); continue; }
          if (f.type_id === 6 || f.type_id === 14 || f.type_id === 19) { problems.push(`${where}: условие по полю-дате «${f.name}» этим скриптом не ставится (формат не проверен) — поставьте через интерфейс`); continue; }
          if (f.enums && Object.keys(f.enums).length) { problems.push(`${where}: «${f.name}» — список: задавайте enums: [id вариантов]`); continue; }
          const op = c.operator || "equal";
          if (!["equal", "not_equal", "contains", "not_contains", "filled", "not_filled"].includes(op)) { problems.push(`${where}: оператор «${op}» amoCRM не знает (примет, но условие работать не будет)`); continue; }
          const values = op === "filled" || op === "not_filled" ? ["1"] : (c.values || []).map(String).filter((v) => v !== "");
          if (!values.length) { problems.push(`${where}: условие по полю «${f.name}» без значения`); continue; }
          conditions = values.map((v) => ({ value: v, operator: op }));
        }
        groups.push({ type: "custom_field", options, logic_operator: logic, tmpl: "custom_field", conditions });
      } else {
        problems.push(`${where}: тип условия «${c.type}» неизвестен — amoCRM такое молча выбрасывает, и триггер сработал бы на всех сделках`);
      }
    }
    return groups;
  };

  job.triggers.forEach((t, i) => {
    const where = `триггер ${i + 1} (${t.action})`;
    if (UNSUPPORTED[t.action]) { problems.push(`${where}: ${UNSUPPORTED[t.action]} этим скриптом не ставится — поставьте через интерфейс`); return; }
    if (!SUPPORTED.includes(t.action)) { problems.push(`${where}: действие неизвестно — amoCRM ответит «успех» и ничего не создаст`); return; }
    if (!stages.has(String(t.stage))) { problems.push(`${where}: этапа ${t.stage} нет в воронке ${PID} — amoCRM ответит «успех» и ничего не создаст`); return; }
    const ev = events[t.event || "lead_status_changed"];
    if (!ev) { problems.push(`${where}: события «${t.event}» нет — amoCRM молча подставил бы «после перехода или создания в этапе»`); return; }
    const delay = Number(t.delay_sec || 0);
    if (!Number.isInteger(delay) || delay < 0) { problems.push(`${where}: задержка должна быть целым числом секунд, не меньше нуля`); return; }
    const s = Object.assign({}, t.settings || {});
    if (t.action === "change_status") {
      if (delay < 300) problems.push(`${where}: смена этапа без задержки запрещена amoCRM (защита от зацикливания): нужно delay_sec не меньше 300`);
      if (!s.pipe_id || !s.status_id) problems.push(`${where}: нужны settings.pipe_id и settings.status_id`);
    }
    if (t.action === "change_tags") {
      const tags = listOf(s.tags);
      if (!tags.length || tags.some((x) => !x.id)) problems.push(`${where}: нужны теги с id — тег по одному названию создаёт сломанный триггер, который блокирует все сохранения воронки`);
      else s.tags = Object.fromEntries(tags.map((x) => [`t_${x.id}`, { id: x.id, name: x.name || "" }]));
      s.action = s.action === "unlink" ? "unlink" : "link";
    }
    if (t.action === "change_responsible" && !users.has(String(s.responsible_id))) problems.push(`${where}: пользователь ${s.responsible_id} не найден в аккаунте`);
    if (t.action === "create_task") {
      if (s.responsible_user !== undefined && !users.has(String(s.responsible_user))) problems.push(`${where}: ответственный ${s.responsible_user} не найден (допустимо: current, creator или id пользователя)`);
      for (const k of ["deadline-days", "deadline-hours", "deadline-minutes"]) if (Number(s[k])) problems.push(`${where}: срок задачи (${k}) запросом не ставится — amoCRM сохраняет «в момент создания». Срок задайте в интерфейсе`);
      Object.assign(s, { task_type: s.task_type || 1, "deadline-days": 0, "deadline-hours": 0, "deadline-minutes": 0, "within-deadline": 0, responsible_user: s.responsible_user === undefined ? "current" : s.responsible_user });
    }
    if (t.action === "change_field_value") {
      const fs = listOf(s.fields);
      if (!fs.length) problems.push(`${where}: нужен settings.fields: [{ field_id, value }]`);
      for (const f of fs) if (!fields[String(f.field_id)]) problems.push(`${where}: поле ${f.field_id} не найдено — amoCRM такой триггер сохранит, но он ничего не сделает`);
      s.fields = fs.map((f) => { const d = fields[String(f.field_id)] || {}; return { field_id: f.field_id, value: f.value, field_type: d.type_id, option: d.name }; });
    }
    if (t.action === "send_hook" && !/^https?:\/\/[^\s/]+\.[^\s/]+/.test(String(s.url || ""))) problems.push(`${where}: settings.url должен быть адресом http(s)`);
    if (t.action === "delete_files" && !Object.keys(s).length) Object.assign(s, { origin_type_custom_field: 1, origin_type_note: 1, origin_type_manual_load: 1, origin_type_chat: 1, file_size_from: "", file_size_to: "", file_size_unit: 1048576 });
    let row = Number(t.row);
    if (!Number.isInteger(row) || row < 1) { row = 1; while (taken.has(`${t.stage}:${row}`)) row++; }
    else if (taken.has(`${t.stage}:${row}`)) problems.push(`${where}: строка ${row} этапа ${t.stage} занята — amoCRM сдвинул бы стоящий там триггер вниз`);
    taken.add(`${t.stage}:${row}`);
    const groups = buildConditions(t.conditions, where);
    const widget = t.action === "send_widget_hook";
    if (widget && (!s.widget_id || !s.widget_code || !s.widget || !s.name)) problems.push(`${where}: для виджета нужны settings.widget_id, widget_code, name (подпись триггера) и widget: { settings: {...} }`);
    const action = {
      handler_code: widget ? "widget" : "amocrm",
      handler_id: widget ? s.widget_id : handler("amocrm"),
      statuses: [t.stage],
      settings: widget ? { widget: s.widget } : Object.assign({ is_trial_expired: 0, change_in_related: "", relative_date: "", task_created: "" }, s),
      row,
      execution_condition: Object.assign({ id: ev.id, event_id: 0, name: ev.name }, t.event_options || {}),
      action: t.action,
      free: 0,
      cid: `c${Date.now() % 100000}${i}`,
      date_exec: 0,
      recurrent: "",
      delay,
    };
    if (widget) Object.assign(action, { widget_id: s.widget_id, widget_code: s.widget_code, name: s.name });
    if (groups.length) action.conditions_groups = groups;
    built.push({ spec: t, action, groups: groups.length, event_id: ev.id });
  });

  const report = { ok: false, pipeline_id: PID, existing_triggers: existing.length, new_triggers: built.length, problems };
  if (problems.length) return Object.assign(report, { error: "задание не прошло проверку, ничего не отправлено" });
  if (!job.apply) return Object.assign(report, { ok: true, dry_run: true, would_add: built.map((b) => ({ stage: b.action.statuses[0], row: b.action.row, action: b.action.action, event: b.action.execution_condition.name, delay_sec: b.action.delay, conditions: b.groups })), note: "пробный прогон: ничего не отправлено. Чтобы записать, добавьте apply: true" });

  const snapshot = Object.fromEntries(existing.map((t) => [t.id, essence(t)]));
  const rollback = async (why) => {
    const cur = await state();
    const mine = flat(cur).filter((t) => !snapshot[t.id]).map((t) => t.id);
    const back = await post(flat(cur).filter((t) => snapshot[t.id]).map(resend));
    const fin = flat(await state());
    const restored = fin.length === existing.length && fin.every((t) => snapshot[t.id] === essence(t));
    return Object.assign(report, { error: why, rolled_back: back.status === "success" && restored, removed: mine, warning: restored ? undefined : "ОТКАТ НЕ ПОДТВЕРЖДЁН: откройте настройку воронки и проверьте триггеры глазами" });
  };

  const answer = await post([...existing.map(resend), ...built.map((b) => b.action)]);
  if (answer.status !== "success") return Object.assign(report, { error: `amoCRM отказал: ${answer.error || "без текста"}`, note: "при отказе amoCRM не сохраняет ничего из запроса" });
  const result = answer.response.result.actions;
  const after = flat(await state());
  if ((result.delete || []).length) return rollback(`amoCRM удалил триггеры ${result.delete.join(", ")}, которых мы не трогали`);
  if ((result.add || []).length !== built.length) return rollback(`amoCRM создал ${(result.add || []).length} триггеров вместо ${built.length}: часть он молча отбросил`);
  const changed = existing.filter((t) => { const now = after.find((x) => x.id === t.id); return !now || essence(now) !== snapshot[t.id]; });
  if (changed.length) return rollback(`после записи изменились существующие триггеры: ${changed.map((t) => `${t.id} (${t.action})`).join(", ")}`);
  const created = after.filter((t) => !snapshot[t.id]);
  const mismatches = [];
  for (const b of built) {
    const t = created.find((x) => x.action === b.action.action && x.row === b.action.row && String((x.statuses || [])[0]) === String(b.action.statuses[0]));
    if (!t) { mismatches.push(`${b.action.action} на этапе ${b.action.statuses[0]}: не найден после записи`); continue; }
    const groups = listOf(t.conditions_groups).length;
    if (groups !== b.groups) mismatches.push(`${b.action.action} (${t.id}): условий сохранено ${groups} из ${b.groups}`);
    if (t.execution_condition.id !== b.event_id) mismatches.push(`${b.action.action} (${t.id}): событие сохранено как ${t.execution_condition.name}`);
    if (Number(t.delay) !== b.action.delay) mismatches.push(`${b.action.action} (${t.id}): задержка сохранена ${t.delay}`);
    if (listOf(t.errors).length) mismatches.push(`${b.action.action} (${t.id}): amoCRM пометил триггер ошибкой`);
  }
  if (mismatches.length) return rollback(`триггеры сохранились не так, как просили: ${mismatches.join("; ")}`);
  return Object.assign(report, { ok: true, added: created.map((t) => ({ trigger_id: t.id, stage: (t.statuses || [])[0], row: t.row, action: t.action, event: t.execution_condition.name, delay_sec: Number(t.delay), conditions: listOf(t.conditions_groups).length })), existing_unchanged: true, note: "записано и проверено. Откройте настройку воронки и посмотрите новые карточки глазами" });
};
