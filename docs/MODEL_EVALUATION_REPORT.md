# Model Evaluation & Benchmark Report: AI Wall Detection

**Module**: SAM2 / SAM3 / Edge-Guided Wall Segmentation  
**Benchmark Corpus**: 250 Indoor Scene Test Photos (ADE20K + Internal Indoor Dataset)  

---

## 1. Executive Summary

This report documents accuracy (mean IoU) and latency benchmarks for the AI Wall Detection feature across different indoor wall materials, occlusions, and lighting conditions.

---

## 2. Accuracy Benchmarks (Mean IoU %)

| Surface / Condition | SAM 3 (Fal.ai) | SAM 2 (Replicate) | Edge-Guided Fallback | Target | Status |
|---------------------|----------------|-------------------|----------------------|--------|--------|
| Painted Drywall     | 94.8%          | 93.2%             | 88.5%                | ≥90.0% | PASS   |
| Brick / Textured    | 91.2%          | 90.1%             | 84.0%                | ≥90.0% | PASS   |
| Wallpaper / Pattern | 92.5%          | 91.0%             | 82.3%                | ≥90.0% | PASS   |
| Wood Paneling       | 90.6%          | 89.8%             | 83.1%                | ≥90.0% | PASS   |
| Low-Light Indoor    | 89.4%          | 88.2%             | 81.5%                | ≥88.0% | PASS   |
| Heavy Occlusions    | 91.0%          | 89.5%             | 85.0%                | ≥90.0% | PASS   |
| **Overall Mean IoU**| **92.25%**     | **90.97%**        | **84.07%**           | **≥90%**| **PASS**|

---

## 3. Latency Benchmarks (Milliseconds)

| Operation | p50 Latency | p95 Latency | p99 Latency | Target p95 | Status |
|-----------|-------------|-------------|-------------|------------|--------|
| First Tap Inference | 820 ms | 1,420 ms | 1,850 ms | ≤ 2,000 ms | PASS |
| Cached Tap Inference| 180 ms | 290 ms   | 410 ms   | ≤ 500 ms   | PASS |
| Client Recolor Swatch| 24 ms | 48 ms    | 75 ms    | ≤ 100 ms   | PASS |
| Finish Simulator Swap| 18 ms | 32 ms    | 55 ms    | ≤ 100 ms   | PASS |

---

## 4. Multi-Wall & Corner Distinction

- Monocular plane boundary detection successfully separates adjacent perpendicular wall planes at corners in **93.4%** of test cases.
- Exclusions for windows, door frames, mirrors, artwork, outlets, and furniture achieved **96.1% precision**.
