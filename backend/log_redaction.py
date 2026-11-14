"""(G2-8) uvicorn 存取日誌（access log）的查詢字串遮罩。

為什麼需要：OAuth 回呼網址是 `/auth/.../callback?code=...&state=...`，uvicorn 的 access log 會把完整
路徑（含查詢字串）寫進 log，等於把授權碼與 state 寫進 docker log。這個 filter 只改寫 uvicorn.access 的
記錄：路徑含 /auth/ 且有查詢字串時，查詢字串換成 [redacted]。其他路徑不動。
"""

import logging

ACCESS_LOGGER_NAME = "uvicorn.access"
REDACTED_SUFFIX = "?[redacted]"
REDACTED_FALLBACK_PATH = "/auth/[redacted]"


def _is_auth_path(path: str) -> bool:
    # 同時涵蓋 --root-path 之後的 /api/auth/... 形式
    return "/auth/" in path


class AuthQueryRedactionFilter(logging.Filter):
    """把 uvicorn.access 記錄裡 /auth/ 路徑的查詢字串換成 [redacted]。永遠回傳 True（不丟掉任何記錄）。"""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            args = record.args
            if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str):
                full_path = args[2]
                path, sep, _query = full_path.partition("?")
                if sep and _is_auth_path(path):
                    new_args = list(args)
                    new_args[2] = f"{path}{REDACTED_SUFFIX}"
                    record.args = tuple(new_args)
        except Exception:  # noqa: BLE001
            # 解析失敗時：若看起來是 auth 路徑就整段換成固定字串；否則不動
            try:
                args = record.args
                if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str) and "/auth/" in args[2]:
                    new_args = list(args)
                    new_args[2] = REDACTED_FALLBACK_PATH
                    record.args = tuple(new_args)
            except Exception:  # noqa: BLE001
                pass
        return True


def install_access_log_redaction() -> None:
    """把 AuthQueryRedactionFilter 掛到 uvicorn.access 上；重複呼叫不會重複加。"""
    logger = logging.getLogger(ACCESS_LOGGER_NAME)
    if any(isinstance(f, AuthQueryRedactionFilter) for f in logger.filters):
        return
    logger.addFilter(AuthQueryRedactionFilter())
