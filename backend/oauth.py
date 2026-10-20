"""OAuth client 設定 (Google / GitHub)。

憑證一律從環境變數讀，程式碼裡不寫死任何 client id/secret：
    GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
    GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET

沒設定時 client_id/client_secret 就是 None，import 這支模組仍然不會壞
（authlib 只在真正發起 authorize / 換 token 時才需要憑證），
這樣測試環境或還沒建 OAuth app 的開發機都能正常啟動。
"""

import os

from authlib.integrations.starlette_client import OAuth
from dotenv import load_dotenv

# 與 database.py 一致：讀 repo 根目錄的 .env (backend/ 的上一層)。
# override=False 讓真正的環境變數 (docker-compose / 部署平台) 優先於 .env。
_ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
load_dotenv(_ENV_PATH, override=False)


def _get_env(name: str) -> str | None:
    """讀環境變數，空字串視同未設定 (回傳 None)。"""
    value = (os.getenv(name) or "").strip()
    return value or None


GOOGLE_CLIENT_ID = _get_env("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = _get_env("GOOGLE_CLIENT_SECRET")
GITHUB_CLIENT_ID = _get_env("GITHUB_CLIENT_ID")
GITHUB_CLIENT_SECRET = _get_env("GITHUB_CLIENT_SECRET")

oauth = OAuth()

# Google：用 OpenID Connect discovery，authorize/token/userinfo 端點自動取得
oauth.register(
    name="google",
    client_id=GOOGLE_CLIENT_ID,
    client_secret=GOOGLE_CLIENT_SECRET,
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile"},
)

# GitHub：沒有 OIDC discovery，端點要自己寫
oauth.register(
    name="github",
    client_id=GITHUB_CLIENT_ID,
    client_secret=GITHUB_CLIENT_SECRET,
    authorize_url="https://github.com/login/oauth/authorize",
    access_token_url="https://github.com/login/oauth/access_token",
    api_base_url="https://api.github.com/",
    client_kwargs={"scope": "user:email"},
)

# 給 route 層判斷用：哪個 provider 還沒設定憑證，就不要讓使用者點進去 (回 503 之類)
_PROVIDER_CREDENTIALS = {
    "google": (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET),
    "github": (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET),
}


def is_provider_configured(provider: str) -> bool:
    """該 provider 的 client_id / client_secret 是否都已設定。"""
    client_id, client_secret = _PROVIDER_CREDENTIALS.get(provider, (None, None))
    return bool(client_id and client_secret)
