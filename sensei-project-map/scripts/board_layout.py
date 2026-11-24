# Раскладывает карту воронки на доске Whiteboard по описанию (spec.json).
#
# Запуск:  python board_layout.py spec.json out_dir [--start 1]
#   --start  номер первого id элемента (e1, e2, ...). На доске, где уже есть элементы,
#            ставь номер выше самого большого e-номера на ней.
#
# Что получится в out_dir:
#   e<N>.json   — по файлу на элемент доски (секции, блоки, тексты, стрелки);
#   meta.json   — {"v": 1, "title", "order"}: порядок элементов сзади вперёд;
#   writes.json — готовые пачки записей для ArtifactData batch (по 50, через file_path).
#
# Формат spec.json — в SKILL.md, раздел «Описание доски». Пример — example_spec.json.
# Скрипт ничего не отправляет: он только считает координаты и высоты.

import json, math, os, re, sys

try:
    sys.stdout.reconfigure(encoding="utf-8")  # консоль Windows не всегда в UTF-8
except Exception:
    pass

args = sys.argv[1:]
if len(args) < 2:
    sys.exit("python board_layout.py spec.json out_dir [--start N]")
spec = json.load(open(args[0], encoding="utf-8"))
OUT = args[1]
START = int(args[args.index("--start") + 1]) if "--start" in args else 1
os.makedirs(OUT, exist_ok=True)

BASE = spec.get("constructor_url", "")          # https://my.sensei.plus/constructor/<id аккаунта>/
W = spec.get("card_width", 330)                 # ширина карточки этапа
STEP = spec.get("column_step", 450)             # шаг колонок: карточка + 120 под стрелки
GAP = 20                                        # между блоками одной колонки
LANE_GAP = spec.get("lane_gap", 180)            # между полосами

def links(text):
    # (P:12345) → ссылка на процесс в конструкторе
    return re.sub(r"\(P:(\d+)\)", lambda m: "(" + BASE + m.group(1) + ")", text)

def vis(s):
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)
    return s.replace("**", "")

def height(text, w):
    # ~7.6 px на букву при шрифте 15 px, строка 22.5 px; с запасом — иначе блок наползёт на соседей
    cpl = max(10, int((w - 30) / 7.6))
    lines = sum(max(1, math.ceil(len(vis(ln)) / cpl)) for ln in text.split("\n"))
    return int(math.ceil((lines * 22.5 + 42) / 10.0) * 10)

els, order = {}, []
n = [START - 1]
def add(d):
    n[0] += 1
    i = f"e{n[0]}"
    els[i] = d
    order.append(i)
    return i

def block(x, y, w, text, color, kind="rect"):
    text = links(text)
    h = height(text, w)
    return add({"type": "shape", "kind": kind, "x": x, "y": y, "w": w, "h": h,
                "color": color, "text": text, "textAlign": "left"}), h

lanes = spec["lanes"]
sections = [add({"type": "container", "x": 0, "y": 0, "w": 100, "h": 100, "text": ln["title"]}) for ln in lanes]
exits = spec.get("exits")
sec_exit = add({"type": "container", "x": 0, "y": 0, "w": 100, "h": 100, "text": exits["title"]}) if exits else None

add({"type": "text", "x": 0, "y": -250, "text": spec["title"], "size": "title"})
add({"type": "text", "x": 0, "y": -176, "text": spec["subtitle"], "size": "large"})
lx = spec.get("legend_x", 1900)
legend = [("Этап, его процесс и кнопки", "blue", "rect", 250), ("Процесс без своего этапа", "green", "rounded", 250),
          ("Поля, которые заполняет", "yellow", "rect", 250), ("Проблема", "pink", "rect", 180)]
x = lx
for t, c, k, w in legend:
    add({"type": "shape", "kind": k, "x": x, "y": -250, "w": w, "h": 46, "color": c, "text": t})
    x += w + 20
add({"type": "text", "x": lx, "y": -188, "wrap": 990, "size": "small", "text": spec.get("legend_note",
     "Стрелка — кнопка задачи переводит сделку в этап. Двойная стрелка — туда и обратно. "
     "Дальние переходы и закрытие в отказ написаны в карточке этапа, чтобы не путать стрелками.")})

nodes = {}
lane_top = []
y = 0
for li, ln in enumerate(lanes):
    lane_top.append(y)
    bottoms = []
    for nd in ln["nodes"]:
        x = nd["col"] * STEP
        hub = nd.get("kind") == "hub"
        i, h = block(x, y, W, nd["text"], "green" if hub else "blue", "rounded" if hub else "rect")
        last, last_box = i, (y, h)
        yy = y + h + GAP
        if nd.get("fields"):
            fi, fh = block(x, yy, W, nd["fields"], "yellow")
            last, last_box = fi, (yy, fh)
            yy += fh + GAP
        for p in nd.get("problems", []):
            pi, ph = block(x, yy, W, p, "pink")
            last, last_box = pi, (yy, ph)
            yy += ph + GAP
        nodes[nd["key"]] = {"id": i, "last": last, "last_box": last_box, "bottom": yy}
        bottoms.append(yy)
    end = max(bottoms)
    maxcol = max(nd["col"] for nd in ln["nodes"])
    els[sections[li]].update({"x": -30, "y": y - 50, "w": maxcol * STEP + W + 60, "h": end - (y - 50) + 10})
    y = end + LANE_GAP

if exits:
    ecol = exits.get("col", 7)
    lane = exits.get("lane", 0)
    ex, ey = ecol * STEP + 60, lane_top[lane]
    yy = ey
    for b in exits["blocks"]:
        _, h = block(ex, yy, 400, b["text"], "white")
        yy += h + GAP
        for p in b.get("problems", []):
            _, ph = block(ex, yy, 400, p, "pink")
            yy += ph + GAP
        yy += 20
    els[sec_exit].update({"x": ex - 30, "y": ey - 50, "w": 460, "h": yy - ey + 40})
    nxt = lane + 1
    if nxt < len(lane_top) and yy > lane_top[nxt] - 60:
        print(f"ВНИМАНИЕ: колонка выходов (до y={int(yy)}) наползает на полосу {nxt + 1} (y={lane_top[nxt]}). "
              f"Сдвинь её: exits.col правее последней колонки той полосы или exits.lane ниже.")

for a in spec.get("arrows", []):
    src, dst = nodes[a["from"]], nodes[a["to"]]
    d = {"type": "arrow"}
    if a.get("route"):
        # стрелка вниз из колонки: от последнего блока колонки, ровная часть проходит в просвете
        d["from"], d["to"] = src["last"], dst["id"]
        fy, fh = src["last_box"]
        cy = fy + fh / 2.0
        r = a["route"]
        if r == "below_from":
            level = fy + fh + 26
        elif r == "above_to":
            level = els[dst["id"]]["y"] - 34
        elif r.startswith("gap:"):
            level = lane_top[int(r.split(":")[1])] - 90
        else:
            sys.exit("route: below_from | above_to | gap:<номер полосы>")
        d["bends"] = ["v", int(round(level - cy))]
    else:
        fs = a.get("from_side", "right")
        d["from"] = src["last"] if fs == "bottom" else src["id"]
        d["to"] = dst["id"]
        d["fromSide"], d["toSide"] = fs, a.get("to_side", "left")
    if a.get("head"):
        d["head"] = a["head"]
    add(d)

for k, v in els.items():
    json.dump(v, open(os.path.join(OUT, k + ".json"), "w", encoding="utf-8"), ensure_ascii=False)
json.dump({"v": 1, "title": spec.get("board_title", spec["title"]), "order": order},
          open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8"), ensure_ascii=False)

absout = os.path.abspath(OUT)
writes = [{"op": "set", "collection": "elements", "doc_id": k, "file_path": os.path.join(absout, k + ".json")} for k in order]
batches = [writes[i:i + 50] for i in range(0, len(writes), 50)]
json.dump(batches, open(os.path.join(OUT, "writes.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"{len(order)} элементов ({order[0]}…{order[-1]}), пачек записи: {len(batches)}; "
      f"доска примерно {int(max(e.get('x', 0) + e.get('w', 0) for e in els.values()))} × {int(y)}")
