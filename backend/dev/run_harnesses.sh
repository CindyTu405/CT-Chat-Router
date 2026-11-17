#!/usr/bin/env bash
# (CI-2) 依序跑完 9 支 harness；本機與 CI 共用。
# 用法（只用臨時資料庫，不要指向 chat_db）：
#     cd backend && POSTGRES_DB=g2_tmp ./dev/run_harnesses.sh
# 資料庫由呼叫者決定（DATABASE_URL 或 POSTGRES_DB），這支腳本不設定。
# 一支失敗不中斷，全部跑完；有任何失敗則結束碼 1。
set -u

cd "$(dirname "$0")/.."

HARNESSES=(auth quota regenerate branch_entries model_options pool limits guest openrouter_connect)

passed=0
failed=0
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

for name in "${HARNESSES[@]}"; do
    if SQL_ECHO=false uv run python "dev/${name}_harness.py" >"$log" 2>&1; then
        echo "PASS ${name}"
        passed=$((passed + 1))
    else
        echo "FAIL ${name}"
        grep -v sqlalchemy "$log" | tail -n 40 | sed 's/^/    /'
        failed=$((failed + 1))
    fi
done

echo "${passed} passed, ${failed} failed"
[ "$failed" -eq 0 ]
