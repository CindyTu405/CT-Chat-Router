"""(G2-2) slowapi limiter 的單一實例。main 與 auth_routes 都從這裡匯入，避免循環匯入。"""
from slowapi import Limiter
from slowapi.util import get_remote_address

# 預設 key 是來源 IP；/chat 與 regenerate 另外用 main.rate_limit_key（依登入者）。
limiter = Limiter(key_func=get_remote_address)
