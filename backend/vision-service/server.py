"""
HTTP entrypoint for the local Grounded-SAM2 vision service.

Speaks the exact contract backend/src/services/ai/providers/httpVisionProvider.js
expects: POST /analyze with {"image": "data:...;base64,...", "task": "house-understanding"},
response {"output": {...}}. Point the Node backend at this with:

  AI_ANALYSIS_PROVIDER=http
  AI_VISION_URL=http://127.0.0.1:8008/analyze
"""
import time

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

import pipeline

app = FastAPI(title="paint-visualizer vision service")


class AnalyzeRequest(BaseModel):
    image: str
    task: str = "house-understanding"


@app.get("/health")
def health():
    return {"status": "ok", "device": pipeline.DEVICE}


@app.post("/analyze")
def analyze(req: AnalyzeRequest):
    if req.task != "house-understanding":
        raise HTTPException(400, f"unsupported task: {req.task}")
    t0 = time.time()
    try:
        output = pipeline.analyze(req.image)
    except Exception as exc:  # surfaced to the Node provider as a 500 -> job failure
        raise HTTPException(500, f"analysis failed: {exc}") from exc
    return {"output": output, "processingTimeMs": round((time.time() - t0) * 1000)}
