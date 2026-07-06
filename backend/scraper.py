import json
import time
import httpx
from datetime import datetime, timezone
from sqlmodel import Session
from models import FreeModelsCache

CACHE_TTL = 86400
MAX_MODELS = 30
OPENROUTER_API = "https://openrouter.ai/api/v1/models"

_memory_cache = None
_memory_cache_time = 0.0


def _parse_models(api_data: dict) -> list[dict]:
    models = []
    for item in api_data.get("data", []):
        pricing = item.get("pricing", {})
        if pricing.get("prompt") == "0" and pricing.get("completion") == "0":
            models.append({
                "id": item["id"],
                "name": item.get("name", item["id"]),
            })
    return models[:MAX_MODELS]


def _db_read(session: Session):
    row = session.get(FreeModelsCache, 1)
    if row is None:
        return None
    age = (datetime.now(timezone.utc) - row.updated_at).total_seconds()
    if age < CACHE_TTL:
        return json.loads(row.models_json)
    return None


def _db_write(session: Session, models: list[dict]):
    row = session.get(FreeModelsCache, 1)
    if row is None:
        row = FreeModelsCache(id=1, models_json=json.dumps(models), updated_at=datetime.now(timezone.utc))
        session.add(row)
    else:
        row.models_json = json.dumps(models)
        row.updated_at = datetime.now(timezone.utc)
        session.add(row)
    session.commit()


def get_free_models(session: Session, force_refresh: bool = False) -> list[dict]:
    global _memory_cache, _memory_cache_time

    now = time.time()

    if not force_refresh:
        if _memory_cache is not None and now - _memory_cache_time < CACHE_TTL:
            return _memory_cache

        db_models = _db_read(session)
        if db_models is not None:
            _memory_cache = db_models
            _memory_cache_time = now
            return db_models

    try:
        with httpx.Client(timeout=30) as client:
            resp = client.get(OPENROUTER_API)
            resp.raise_for_status()
            models = _parse_models(resp.json())
            _memory_cache = models
            _memory_cache_time = now
            _db_write(session, models)
            return models
    except Exception as e:
        print(f"[scraper] 爬取失敗: {e}")
        db_models = _db_read(session)
        if db_models is not None:
            return db_models
        if _memory_cache is not None:
            return _memory_cache
        return []
