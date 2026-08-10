# API & Client Pipeline Specification: AI-Assisted Wall Detection & Repaint

**Module**: AI Wall Detection & Realistic Repaint (`/api/assets/:assetId/ai/segment-wall`)  
**Version**: 1.0.0  
**Status**: Production Specification  

---

## 1. Overview

This document specifies the REST API contract for promptable point-click wall segmentation (`/segment-wall`) and the client-side WebGL / 2D Canvas color rendering pipeline.

---

## 2. Server REST Endpoint: `POST /api/assets/:assetId/ai/segment-wall`

### Request Headers
- `Content-Type: application/json`
- `Authorization: Bearer <token>` (if authentication enabled)

### URL Parameters
- `assetId` (string, required): The target uploaded asset UUID.

### Request Body Schema
```json
{
  "x": 340.5,
  "y": 210.0,
  "positivePoints": [
    { "x": 380, "y": 220 }
  ],
  "negativePoints": [
    { "x": 310, "y": 180 }
  ],
  "mode": "new",
  "tolerance": 38
}
```

#### Field Descriptions
- `x` (number, required): Primary tap/click X coordinate on the asset image space.
- `y` (number, required): Primary tap/click Y coordinate on the asset image space.
- `positivePoints` (array of `{x, y}`, optional): Refinement points explicitly included in the wall selection (`+` tool).
- `negativePoints` (array of `{x, y}`, optional): Refinement points explicitly excluded from the wall selection (`-` tool).
- `mode` (string, optional): Selection mode (`"new"` | `"add"` | `"subtract"`). Defaults to `"new"`.
- `tolerance` (number, optional): Color & boundary gradient tolerance (10–80). Defaults to 38.

### Response Body Schema (200 OK)
```json
{
  "ok": true,
  "width": 1920,
  "height": 1080,
  "alphaBase64": "<base64-encoded-Uint8Array-0-255-alpha-bytes>",
  "pixelCount": 420150,
  "confidence": 0.94,
  "boundingBox": {
    "x": 120,
    "y": 80,
    "w": 1100,
    "h": 850
  },
  "wallPlaneId": "wall_plane_left_340_210",
  "processingTimeMs": 215,
  "provider": "fal-vision"
}
```

### Error Responses
- `400 Bad Request`: Invalid or missing `x` or `y` coordinates.
- `404 Not Found`: Asset ID not found.
- `500 Internal Server Error`: Segmentation failure with structured error payload:
```json
{
  "error": "Failed to segment wall surface",
  "reason": "MODEL_TIMEOUT",
  "fallbackAvailable": true
}
```

---

## 3. Client-Side WebGL / Canvas Recoloring Pipeline Spec

Recoloring operates **strictly on the client side** for sub-100ms real-time feedback during swatch preview.

### Pipeline Steps
1. **Luminance Extraction**:
   - Original pixel RGB converted to CIE-LAB space: `(L_orig, a_orig, b_orig)`.
2. **Target Color Normalization**:
   - Selected swatch HEX/RGB converted to CIE-LAB target: `(L_target, a_target, b_target)`.
3. **Lighting-Preserving Composite**:
   - `L_final = clamp(L_orig * (L_target / max(L_mean_wall, 1)), 0, 100)`
   - `a_final = a_target`
   - `b_final = b_target`
4. **Finish Specular Highlight Simulation**:
   - **Matte**: Specular exponent $s = 0.0$, Gloss scale $k_g = 0.0$
   - **Eggshell**: Specular exponent $s = 8.0$, Gloss scale $k_g = 0.08$
   - **Satin**: Specular exponent $s = 16.0$, Gloss scale $k_g = 0.18$
   - **Gloss**: Specular exponent $s = 64.0$, Gloss scale $k_g = 0.35$
5. **Alpha Mask Blend**:
   - `Pixel_out = Pixel_orig * (1 - Alpha) + Pixel_recolored * Alpha`
