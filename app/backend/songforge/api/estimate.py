"""Length and context estimate for a draft, before the GPU is involved."""
from __future__ import annotations

from fastapi import APIRouter

from .. import budget
from ..schemas import EstimateRequest, EstimateResponse

router = APIRouter(tags=["estimate"])


@router.post(
    "/estimate",
    response_model=EstimateResponse,
    summary="Estimate song length and context use for a draft",
)
def estimate(payload: EstimateRequest) -> EstimateResponse:
    """Pure arithmetic: no database, no model, safe to call on every keystroke."""
    result = budget.estimate(
        payload.style_prompt,
        payload.lyrics,
        cot=payload.cot.value,
        score_abc=payload.score_abc,
        instrumental=payload.instrumental,
    )
    return EstimateResponse(**result.to_dict())
