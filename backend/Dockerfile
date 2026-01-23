# 使用輕量級的 Python 3.11 版本
FROM python:3.11-slim

# 設定工作目錄
WORKDIR /app

RUN pip install uv

# 安裝系統依賴 (Postgres 驅動需要 gcc 等編譯工具)
RUN apt-get update && apt-get install -y \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# 複製套件清單並安裝
COPY pyproject.toml uv.lock* ./
RUN uv pip install --system -r pyproject.toml

# 複製程式碼 (雖然 docker-compose 有掛載 volumes，但正規打包還是要 COPY)
COPY . .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]