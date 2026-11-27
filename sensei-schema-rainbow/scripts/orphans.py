"""Оторванные и недостижимые блоки процесса Sensei и срабатывали ли они (только чтение, ключ API Sensei).

  python -X utf8 orphans.py <process_id> [--draft] [--days 90]

Ключ — переменная окружения SENSEI_TOKEN (заголовок X-Auth-Sensei-Token, https://api.sensei.plus/v1/).
Ключ не печатается.

Что делает:
  1) берёт боевую версию (или черновик с --draft): process/versions/get-last → versions/get?with=params;
  2) строит стрелки по полю edges (в этом формате стрелки лежат в edges, НЕ в results — иначе всё «недостижимо»);
  3) достижимость от item_start; отдельно — other_start (лишние точки старта) и блоки без входящих стрелок;
  4) аналитика веток за N дней (process/stats, date_preset previous_days_N, date_switch=started):
     у блока есть доля на выходе — значит, он срабатывал.
Ничего не пишет.
"""
import json
import os
import sys

import httpx

B = "https://api.sensei.plus/v1/"


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit(__doc__)
    pid = int(args[0])
    draft = "--draft" in sys.argv
    days = int(sys.argv[sys.argv.index("--days") + 1]) if "--days" in sys.argv else 90
    tok = os.environ.get("SENSEI_TOKEN")
    if not tok:
        sys.exit("нет SENSEI_TOKEN в окружении")
    c = httpx.Client(timeout=180, headers={"X-Auth-Sensei-Token": tok})

    def get(path, params=None):
        r = c.get(B + path, params=params)
        r.raise_for_status()
        j = r.json()
        return j.get("data", j)

    last = get(f"process/versions/get-last/{pid}")
    ver = last.get("draft_version_id") if draft else last.get("deployed_version_id")
    if not ver:
        sys.exit(f"нет {'черновика' if draft else 'боевой версии'}: {last}")
    # боевую берём из process/get: в versions/get список other_start бывает неполным (проверено 27.11.2026)
    d = get(f"process/versions/get/{pid}/{ver}", {"with": "params"}) if draft else get(f"process/get/{pid}", {"with": "params"})
    items = d.get("items") or {}
    nxt = {k: [str(e.get("item_next")) for e in (v.get("edges") or v.get("results") or []) if e.get("item_next")]
           for k, v in items.items()}
    inc = {}
    for k, ns in nxt.items():
        for n in ns:
            inc.setdefault(n, []).append(k)
    start = str(d.get("item_start"))
    other = [str(x.get("id") if isinstance(x, dict) else x) for x in (d.get("other_start") or [])]
    def reach(roots):
        seen, st = set(), [r for r in roots if r in items]
        while st:
            k = st.pop()
            if k in seen:
                continue
            seen.add(k)
            st += [n for n in nxt.get(k, []) if n in items]
        return seen

    no_inc = [k for k in items if k != start and not inc.get(k) and items[k].get("element_type") not in ("start", "fake")]
    from_main, from_any = reach([start]), reach([start] + other + no_inc)
    real = lambda k: items[k].get("element_type") != "fake"
    unreach = [k for k in items if k not in from_any and real(k)]            # ни от одного входа (замкнутые куски)
    only_other = [k for k in items if k in from_any and k not in from_main and real(k)]  # только через другие входы

    stats = get(f"process/stats/{pid}", {"date_preset": f"previous_days_{days}", "date_switch": "started"})
    sc = (stats.get("scheme") or {}).get("items") or {}

    def fired(k):
        s = sc.get(k) or sc.get(int(k)) or {}
        return any(r.get("percentage") for r in (s.get("results") or []))

    def label(k):
        dc = items[k].get("display_config") or {}
        return (dc.get("label") or dc.get("signature") or (items[k].get("config") or {}).get("text") or "")[:70]

    print(f"процесс {pid}, {'черновик' if draft else 'боевая'} версия {ver}: блоков {len(items)}, старт {start}, другие старты {other}")
    print(f"не достижимы от главного старта: {len(only_other)} блоков (из них срабатывали за {days} дн.: "
          f"{sum(1 for k in only_other if fired(k))}); входов без стрелок: {len(no_inc)}; "
          f"не достижимы ни от одного входа: {len(unreach)}")
    for title, ids in (("другие точки старта (other_start) — в них может заходить внешняя система, проверь", other),
                       ("оторванные входы: блоки без входящих стрелок", [k for k in no_inc if k not in other]),
                       ("не достижимы ни от одного входа", unreach)):
        if not ids:
            continue
        print(f"\n{title}:")
        for k in ids:
            if k not in items:
                print(f"  {k} — нет в версии")
                continue
            print(f"  {k} {items[k].get('element_type'):12} «{label(k)}» → {nxt.get(k, [])} | срабатывал за {days} дн.: {'да' if fired(k) else 'нет'}")
    print(f"\nВывод: удалять можно только то, что и не достижимо/без входа, и не срабатывало. "
          f"Перед удалением — найти прямые переходы в блок (instance/continue из внешних систем, ссылки по id в коде).")


if __name__ == "__main__":
    main()
