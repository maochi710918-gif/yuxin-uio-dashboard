import json
import math
import sys
from pathlib import Path

import shapefile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "county-boundaries" / "COUNTY_MOI_1140318.shp"
OUTPUT = ROOT / "app" / "taiwan-counties.json"
WIDTH, HEIGHT = 500, 600


def distance(point, start, end):
    x, y = point
    x1, y1 = start
    x2, y2 = end
    if start == end:
        return math.hypot(x - x1, y - y1)
    t = max(0, min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / ((x2 - x1) ** 2 + (y2 - y1) ** 2)))
    px, py = x1 + t * (x2 - x1), y1 + t * (y2 - y1)
    return math.hypot(x - px, y - py)


def simplify(points, tolerance=0.0022):
    if len(points) <= 3:
        return points
    first, last = points[0], points[-1]
    index, maximum = 0, 0
    for i in range(1, len(points) - 1):
        value = distance(points[i], first, last)
        if value > maximum:
            index, maximum = i, value
    if maximum > tolerance:
        left = simplify(points[: index + 1], tolerance)
        right = simplify(points[index:], tolerance)
        return left[:-1] + right
    return [first, last]


def signed_area(points):
    return sum(points[i][0] * points[(i + 1) % len(points)][1] - points[(i + 1) % len(points)][0] * points[i][1] for i in range(len(points))) / 2


reader = shapefile.Reader(str(SOURCE))
items = list(zip(reader.records(), reader.shapes()))
offshore = {"連江縣", "金門縣", "澎湖縣"}
main_bounds = (119.95, 21.75, 122.15, 25.42)
inset_boxes = {"連江縣": (22, 38, 82, 76), "金門縣": (18, 166, 96, 62), "澎湖縣": (18, 326, 105, 112)}


def make_projector(bounds, box):
    min_x, min_y, max_x, max_y = bounds
    box_x, box_y, box_width, box_height = box
    scale = min(box_width / (max_x - min_x), box_height / (max_y - min_y))
    x_offset = box_x + (box_width - (max_x - min_x) * scale) / 2
    y_offset = box_y + (box_height - (max_y - min_y) * scale) / 2
    return lambda point: ((point[0] - min_x) * scale + x_offset, (max_y - point[1]) * scale + y_offset)


main_project = make_projector(main_bounds, (105, 18, 374, 564))


def centroid(points):
    area = signed_area(points)
    if not area:
        return points[0]
    cx = cy = 0
    for i, (x1, y1) in enumerate(points):
        x2, y2 = points[(i + 1) % len(points)]
        cross = x1 * y2 - x2 * y1
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
    return cx / (6 * area), cy / (6 * area)


name_aliases = {"臺北市": "台北市", "臺中市": "台中市", "臺南市": "台南市", "臺東縣": "台東縣"}
features = []
for record, shape in items:
    name = name_aliases.get(record[2], record[2])
    project = make_projector(shape.bbox, inset_boxes[name]) if name in inset_boxes else main_project
    boundaries = list(shape.parts) + [len(shape.points)]
    rings = []
    for start, stop in zip(boundaries, boundaries[1:]):
        ring = shape.points[start:stop]
        if len(ring) < 4:
            continue
        ring_center = centroid(ring)
        if name not in offshore and not (119.8 <= ring_center[0] <= 122.25 and 21.65 <= ring_center[1] <= 25.5):
            continue
        area = abs(signed_area(ring))
        rings.append((area, ring))
    rings.sort(key=lambda item: item[0], reverse=True)
    selected = [ring for index, (area, ring) in enumerate(rings) if index < 16 and (index == 0 or area >= 0.000012)]
    commands = []
    for ring in selected:
        reduced = simplify(ring)
        projected = [project(point) for point in reduced]
        commands.append("M" + "L".join(f"{x:.1f},{y:.1f}" for x, y in projected) + "Z")
    center = project(centroid(rings[0][1]))
    features.append({"name": name, "path": "".join(commands), "labelX": round(center[0], 1), "labelY": round(center[1], 1)})

features.sort(key=lambda item: item["name"])
OUTPUT.write_text(json.dumps(features, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"Wrote {len(features)} counties to {OUTPUT} ({OUTPUT.stat().st_size:,} bytes)")
