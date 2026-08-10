# QA Test Plan: AI-Assisted Wall Detection & Repaint Feature

**Module**: Quality Assurance & Validation Test Plan  
**Target Coverage**: 100% Core Requirements Acceptance  

---

## 1. Test Matrix: Wall Surface Types & Conditions

| Test ID | Test Scenario | Expected Outcome | Verification |
|---------|---------------|------------------|--------------|
| QA-W01 | Smooth Painted Drywall | Single tap detects full wall surface up to trim/baseboard | Mask boundaries align to wall edges within ±2px |
| QA-W02 | Exposed Brick Wall | Soft alpha matte preserves textured brick mortar edges | No harsh pixelation at brick edge boundary |
| QA-W03 | Patterned Wallpaper | Wall detected without tearing or stopping at wallpaper pattern boundaries | Contiguous mask spans wallpaper area |
| QA-W04 | Wood Paneling | Detects vertical wood paneled wall excluding baseboards | Bounding mask cleanly excludes floor trim |
| QA-W05 | Low-Light Indoor Room | Detects wall surface in shadow without bleeding into dark floor | Mask does not spill into carpet or floor |
| QA-W06 | Multi-Wall Corner Room | Tap left wall selects left plane only; tap right wall selects right plane | Plane boundaries respected at corner line |
| QA-W07 | Occluded Wall (Sofa/Window) | Mask cleanly cuts around sofa outline and window glass | Sofa and window excluded from paint mask |
| QA-W08 | Refinement Tool (+ / -) | Tapping '+' adds region; tapping '-' subtracts region | Mask update renders instantaneously |
| QA-W09 | Finish Simulator Swap | Switching Satin -> Gloss increases specular highlight intensity | Specular highlight updates without re-inference |
| QA-W10 | Independent Undo/Redo | Undo reverses mask edit step; redo restores it | Undo/redo stack works independently |

---

## 2. Touch & Cross-Platform Compliance

- [ ] Mobile touch tap targets ≥ 44px × 44px verified on iOS Safari & Android Chrome.
- [ ] Pinch-to-zoom on canvas allows precision edge refinement with brush tool.
- [ ] Keyboard shortcut `W` toggles AI Wall tool on desktop.
