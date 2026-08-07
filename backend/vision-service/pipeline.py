"""
Grounded-SAM2 house-understanding pipeline.

Grounding DINO (open-vocabulary text-prompted detection) finds boxes for
architectural parts and common obstructions; SAM2 turns those boxes into
pixel-accurate masks. Thin architectural details that zero-shot text
detectors handle poorly (trim strips, gutters) are derived geometrically
from the real wall/roof/window masks, the same way the existing mock
provider does it — a hybrid of learned segmentation where it's strong and
proven geometry where a learned box detector isn't a good fit.

Output matches the app's existing house-understanding contract exactly
(see backend/src/services/ai/providers/httpVisionProvider.js) so this
service is a pure "bring your own model" backend — no app code changes.
"""
import io
import time
import base64

import numpy as np
import torch
from PIL import Image

from transformers import AutoProcessor, GroundingDinoForObjectDetection, Sam2Model, Sam2Processor

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
MAX_DIM = 640

DINO_MODEL_ID = "IDEA-Research/grounding-dino-tiny"
SAM_MODEL_ID = "facebook/sam2-hiera-tiny"

# Grounding DINO wants lowercase phrases separated by ". ".
PROMPT_CLASSES = ["roof", "wall", "window", "door", "tree", "car", "person", "fence", "sky", "ground"]
TEXT_PROMPT = ". ".join(PROMPT_CLASSES) + "."

# Model-level filter — kept low so weak-but-real detections (e.g. "wall",
# which scores much lower than visually distinctive things like doors or
# people) survive to the per-class filter below. Compound phrases the model
# merges across categories ("roof sky", "wall car fence") are handled by
# _detect's substring-match-in-PROMPT_CLASSES-order below, not here.
DETECT_THRESHOLD = 0.15
TEXT_THRESHOLD = 0.25

# Large structural surfaces (walls especially) are a harder, lower-confidence
# target for a generic zero-shot detector than compact, visually distinctive
# objects (doors, people, cars) — a single global threshold either misses
# walls or lets in noisy low-confidence object detections. Tuned empirically
# against real construction-site house photos.
CLASS_THRESHOLDS = {
    "roof": 0.20,
    "wall": 0.15,
    "door": 0.25,
    "window": 0.30,
    "tree": 0.30,
    "car": 0.30,
    "person": 0.30,
    "fence": 0.30,
    "sky": 0.15,
    "ground": 0.15,
}

# className -> (displayName, role) for paintable surfaces this pipeline emits directly.
SURFACE_META = {
    "roof": ("Roof", "roof"),
    "front-wall": ("Front wall", "primary-wall"),
    "left-wall": ("Left wall", "accent-wall"),
    "right-wall": ("Right wall", "accent-wall"),
    "trim": ("Trim", "trim"),
    "gutter": ("Gutter", "gutter"),
    "door": ("Door", "doors"),
}
OBJECT_META = {
    "window": ("Windows", "windows"),
    "tree": ("Tree", "tree"),
    "car": ("Car", "car"),
    "person": ("Person", "person"),
    "fence": ("Fence", "fence"),
}

_models = None


def _load_models():
    global _models
    if _models is not None:
        return _models
    t0 = time.time()
    dino_processor = AutoProcessor.from_pretrained(DINO_MODEL_ID)
    dino_model = GroundingDinoForObjectDetection.from_pretrained(DINO_MODEL_ID).to(DEVICE).eval()
    sam_processor = Sam2Processor.from_pretrained(SAM_MODEL_ID)
    sam_model = Sam2Model.from_pretrained(SAM_MODEL_ID).to(DEVICE).eval()
    _models = (dino_processor, dino_model, sam_processor, sam_model)
    print(f"[pipeline] models loaded on {DEVICE} in {time.time() - t0:.1f}s", flush=True)
    return _models


def _decode_image(data_uri: str) -> Image.Image:
    if "," in data_uri:
        data_uri = data_uri.split(",", 1)[1]
    raw = base64.b64decode(data_uri)
    return Image.open(io.BytesIO(raw)).convert("RGB")


def _resize(image: Image.Image, max_dim: int):
    w, h = image.size
    scale = min(1.0, max_dim / max(w, h))
    if scale < 1.0:
        image = image.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    return image, scale


@torch.inference_mode()
def _detect(image: Image.Image):
    dino_processor, dino_model, _, _ = _load_models()
    inputs = dino_processor(images=image, text=TEXT_PROMPT, return_tensors="pt").to(DEVICE)
    outputs = dino_model(**inputs)
    results = dino_processor.post_process_grounded_object_detection(
        outputs,
        inputs.input_ids,
        threshold=DETECT_THRESHOLD,
        text_threshold=TEXT_THRESHOLD,
        target_sizes=[image.size[::-1]],
    )[0]

    detections = []
    for box, score, label in zip(results["boxes"], results["scores"], results["labels"]):
        phrase = label.strip().lower()
        # A joint multi-class prompt makes Grounding DINO occasionally return
        # merged phrases ("roof sky", "wall car fence") whose box spans both
        # concepts — e.g. a "roof sky" box can cover the whole building plus
        # the sky above it. Attributing that to one class (even the "right"
        # one) feeds SAM2 a wildly oversized box and produces a mask that's
        # really "the whole scene", not the intended surface. Discard
        # anything ambiguous; only unambiguous single-concept phrases proceed.
        matches = [c for c in PROMPT_CLASSES if c in phrase]
        if len(matches) != 1:
            continue
        cls = matches[0]
        x0, y0, x1, y1 = [float(v) for v in box.tolist()]
        detections.append({"class": cls, "box": [x0, y0, x1, y1], "score": float(score)})
    return detections


@torch.inference_mode()
def _segment(image: Image.Image, boxes):
    if not boxes:
        return []
    _, _, sam_processor, sam_model = _load_models()
    inputs = sam_processor(images=image, input_boxes=[boxes], return_tensors="pt").to(DEVICE)
    outputs = sam_model(**inputs, multimask_output=False)
    masks = sam_processor.post_process_masks(outputs.pred_masks, inputs["original_sizes"])[0]
    # masks: (num_boxes, 1, H, W) bool tensor
    return [m[0].cpu().numpy().astype(bool) for m in masks]


def _dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    if radius <= 0:
        return mask
    t = torch.from_numpy(mask.astype(np.float32))[None, None].to(DEVICE)
    k = radius * 2 + 1
    out = torch.nn.functional.max_pool2d(t, kernel_size=k, stride=1, padding=radius)
    return (out[0, 0].cpu().numpy() > 0)


def _bbox_of(mask: np.ndarray):
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return None
    return {"x": int(xs.min()), "y": int(ys.min()), "w": int(xs.max() - xs.min() + 1), "h": int(ys.max() - ys.min() + 1)}


def _avg_color(rgb: np.ndarray, mask: np.ndarray):
    idx = mask
    if not idx.any():
        return {"r": 128, "g": 128, "b": 128}
    px = rgb[idx]
    return {"r": int(px[:, 0].mean()), "g": int(px[:, 1].mean()), "b": int(px[:, 2].mean())}


def _median_color(rgb: np.ndarray, mask: np.ndarray):
    if not mask.any():
        return None
    px = rgb[mask]
    return {"r": int(np.median(px[:, 0])), "g": int(np.median(px[:, 1])), "b": int(np.median(px[:, 2]))}


def _dominant_palette(rgb: np.ndarray, n=5):
    flat = rgb.reshape(-1, 3)
    buckets = (flat >> 4).astype(np.int32)
    keys = buckets[:, 0] * 256 + buckets[:, 1] * 16 + buckets[:, 2]
    uniq, counts = np.unique(keys, return_counts=True)
    top = uniq[np.argsort(-counts)][:n]
    out = []
    for key in top:
        sel = keys == key
        px = flat[sel]
        out.append({"r": int(px[:, 0].mean()), "g": int(px[:, 1].mean()), "b": int(px[:, 2].mean())})
    return out


def _rgb_to_hsl(r, g, b):
    rn, gn, bn = r / 255, g / 255, b / 255
    mx, mn = max(rn, gn, bn), min(rn, gn, bn)
    l = (mx + mn) / 2
    if mx == mn:
        return 0.0, 0.0, l
    d = mx - mn
    s = d / (2 - mx - mn) if l > 0.5 else d / (mx + mn)
    if mx == rn:
        h = (gn - bn) / d + (6 if gn < bn else 0)
    elif mx == gn:
        h = (bn - rn) / d + 2
    else:
        h = (rn - gn) / d + 4
    return (h / 6) * 360, s, l


def _guess_style(w, h, roof_frac):
    if not h:
        return "unknown"
    if w / h > 1.35:
        return "ranch"
    if roof_frac > 0.12:
        return "traditional"
    return "modern"


def _guess_material(wall_color):
    if not wall_color:
        return "unknown"
    h, s, l = _rgb_to_hsl(wall_color["r"], wall_color["g"], wall_color["b"])
    if s > 0.22 and 6 <= h <= 48:
        return "brick" if l < 0.45 else "wood"
    if l > 0.6 and s < 0.16:
        return "render"
    return "unknown"


def _to_alpha255(mask: np.ndarray):
    return (mask.astype(np.uint8) * 255).flatten().tolist()


def _union(masks):
    out = None
    for m in masks:
        out = m.copy() if out is None else (out | m)
    return out


def analyze(data_uri: str) -> dict:
    image = _decode_image(data_uri)
    image, scale = _resize(image, MAX_DIM)
    W, H = image.size
    rgb = np.array(image)  # H, W, 3

    detections = _detect(image)
    boxes = [d["box"] for d in detections]
    masks = _segment(image, boxes) if boxes else []
    for d, m in zip(detections, masks):
        d["mask"] = m

    by_class = {}
    for d in detections:
        by_class.setdefault(d["class"], []).append(d)

    def class_union(cls):
        min_score = CLASS_THRESHOLDS.get(cls, 0.30)
        items = [it for it in by_class.get(cls, []) if it["score"] >= min_score]
        if not items:
            return np.zeros((H, W), dtype=bool), 0.0
        m = _union([it["mask"] for it in items])
        conf = max(it["score"] for it in items)
        return m, conf

    roof_mask, roof_conf = class_union("roof")
    wall_mask_raw, wall_conf = class_union("wall")
    window_mask, window_conf = class_union("window")
    door_mask, door_conf = class_union("door")
    sky_mask, _ = class_union("sky")
    ground_mask, _ = class_union("ground")

    house_mask = roof_mask | wall_mask_raw
    house_bbox = _bbox_of(house_mask)
    present = house_bbox is not None and (house_bbox["w"] * house_bbox["h"]) / (W * H) > 0.03

    surfaces = []
    objects = []

    if present:
        hx, hy, hw, hh = house_bbox["x"], house_bbox["y"], house_bbox["w"], house_bbox["h"]

        # Sanity-bound the roof detection: a zero-shot box detector
        # occasionally boxes the whole building for "roof" (observed on
        # flat-roofed / under-construction houses where the roofline doesn't
        # stand out from the walls). A roof is architecturally never more
        # than the top portion of a building's silhouette, so clip to that
        # before it's allowed to claim pixels — the real segmentation still
        # decides the shape *within* that bound, this only bounds *how far
        # down* it can reach.
        ROOF_MAX_FRAC = 0.45
        if roof_mask.any():
            roof_row_limit = hy + max(1, round(hh * ROOF_MAX_FRAC))
            row_clip = np.zeros((H, W), dtype=bool)
            row_clip[hy:roof_row_limit, :] = True
            roof_mask = roof_mask & row_clip

        # Wall region, minus openings and minus the roof — matches the mock
        # provider's convention that every pixel belongs to at most one surface.
        wall_mask = wall_mask_raw & ~window_mask & ~door_mask & ~roof_mask

        # Trim: boundary band around the wall + around window openings.
        wall_dilated = _dilate(wall_mask, 3)
        trim_mask = wall_dilated & ~wall_mask
        window_dilated = _dilate(window_mask, 2)
        trim_mask = trim_mask | (window_dilated & ~window_mask)
        wall_mask = wall_mask & ~trim_mask

        # Left/right accent bands at the house's outer 10% — same split the
        # mock provider uses, now carved out of a real segmentation mask
        # instead of a naive LAB/HSL wall classification.
        left_end = min(hx + hw, hx + max(1, round(hw * 0.1)))
        right_start = max(hx, hx + hw - max(1, round(hw * 0.1)))
        col_idx = np.arange(W)
        left_band = (col_idx >= hx) & (col_idx < left_end)
        right_band = (col_idx >= right_start) & (col_idx < hx + hw)

        left_wall = wall_mask & left_band[None, :]
        right_wall = wall_mask & right_band[None, :]
        front_wall = wall_mask & ~left_band[None, :] & ~right_band[None, :]

        # Gutter: thin band directly under the roofline, matches mock.
        gutter_mask = np.zeros((H, W), dtype=bool)
        if roof_mask.any():
            roof_ys = np.where(roof_mask.any(axis=1))[0]
            roof_bottom = int(roof_ys.max())
            g_top = roof_bottom + 1
            g_bottom = min(H - 1, roof_bottom + max(2, round(hh * 0.04)))
            if g_bottom >= g_top:
                band = np.zeros((H, W), dtype=bool)
                band[g_top:g_bottom + 1, :] = True
                gutter_mask = band & (front_wall | left_wall | right_wall | trim_mask)

        def add_surface(class_key, mask, confidence):
            if not mask.any():
                return
            display_name, role = SURFACE_META[class_key]
            surfaces.append({
                "key": class_key,
                "className": class_key,
                "displayName": display_name,
                "paintable": True,
                "role": role,
                "confidence": round(float(confidence), 3),
                "mask": {"width": W, "height": H, "alpha": _to_alpha255(mask)},
                "geometry": {"bbox": _bbox_of(mask), "areaPx": int(mask.sum()), "areaRatio": float(mask.sum()) / (W * H)},
                "averageColor": _avg_color(rgb, mask),
                "properties": {"role": role},
            })

        add_surface("roof", roof_mask, roof_conf or 0.5)
        add_surface("front-wall", front_wall, wall_conf or 0.5)
        add_surface("left-wall", left_wall, wall_conf or 0.5)
        add_surface("right-wall", right_wall, wall_conf or 0.5)
        add_surface("trim", trim_mask, min(0.6, (wall_conf or 0.5)))
        add_surface("gutter", gutter_mask, min(0.5, roof_conf or 0.4))
        add_surface("door", door_mask, door_conf or 0.5)

        def add_object(class_key, mask, confidence):
            if not mask.any():
                return
            display_name, out_key = OBJECT_META[class_key]
            objects.append({
                "key": out_key,
                "className": out_key,
                "displayName": display_name,
                "paintable": False,
                "confidence": round(float(confidence), 3),
                "mask": {"width": W, "height": H, "alpha": _to_alpha255(mask)},
                "geometry": {"bbox": _bbox_of(mask), "areaPx": int(mask.sum()), "areaRatio": float(mask.sum()) / (W * H)},
            })

        add_object("window", window_mask, window_conf or 0.5)
        for cls in ("tree", "car", "person", "fence"):
            m, conf = class_union(cls)
            add_object(cls, m, conf or 0.5)

        wall_color = _avg_color(rgb, wall_mask_raw) if wall_mask_raw.any() else _avg_color(rgb, house_mask)
        roof_color = _avg_color(rgb, roof_mask) if roof_mask.any() else None
        sky_color = _median_color(rgb, sky_mask)
        ground_color = _median_color(rgb, ground_mask)

        wall_l = _rgb_to_hsl(wall_color["r"], wall_color["g"], wall_color["b"])[2] * 100 if wall_color else 50
        roof_row_frac = (roof_mask.sum() / max(1, house_mask.sum()))

        house = {
            "present": True,
            "bbox": house_bbox,
            "confidence": round(min(0.95, max(0.3, 0.45 + (hw * hh) / (W * H) * 1.4)), 3),
            "style": _guess_style(hw, hh, roof_row_frac),
            "material": _guess_material(wall_color),
            "color": wall_color,
        }
        context = {
            "skyColor": sky_color,
            "groundColor": ground_color,
            "roofColor": roof_color,
            "wallColor": wall_color,
            "lighting": round(min(1.3, max(0.7, wall_l / 55)), 3),
            "palette": _dominant_palette(rgb),
        }
    else:
        house = {"present": False, "bbox": None, "confidence": 0, "style": "unknown", "material": "unknown", "color": None}
        context = {"skyColor": None, "groundColor": None, "roofColor": None, "wallColor": None, "lighting": 1, "palette": _dominant_palette(rgb)}

    return {
        "scale": {"width": W, "height": H, "factor": scale},
        "house": house,
        "surfaces": surfaces,
        "objects": objects,
        "context": context,
    }
