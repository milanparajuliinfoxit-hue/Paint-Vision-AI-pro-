# Fallback & Error-State Handling Specification: AI Wall Detection

**Module**: AI Wall Detection Error Resilience  
**Status**: Production Specification  

---

## 1. Failure Modes & Degradation Matrix

| Scenario | Primary Cause | Automatic Action | User Notification |
|----------|---------------|------------------|-------------------|
| API Key Missing / Unset | Cloud provider not configured | Switch immediately to Edge-Guided Flood-Fill + Soft Matte engine | Silent fallback to fast local segmenter; notification toast optional |
| Model Inference Timeout (>2.0s) | Network congestion or queue delay | Abort cloud request, execute edge-guided matte fallback | Toast: *"Cloud AI response delayed. Used fast local edge detection."* |
| Low Confidence Score (<0.50) | Extremely complex wall texture or ambiguous point | Suggest manual polygon / brush tool overlay | Toast + Highlight manual polygon/brush icon |
| Server Disconnect / Network Offline | No internet connection | Execute client/local fallback segmenter | Banner: *"Working Offline — Local detection active"* |

---

## 2. Fallback Transition Guidance

1. **No Silent Failures**: If segmentation cannot identify a wall surface, the system alerts the user and seamlessly transitions cursor focus to the **Polygon / Manual Brush Tool**.
2. **Preservation of Manual Tools**: Manual rectangle, polygon, and brush tools are never removed or disabled; they remain accessible in the toolbar as secondary/advanced options.
