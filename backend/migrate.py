from sqlmodel import text
from database import engine, Session

def add_title_column():
    print("正在嘗試新增 title 欄位...")
    try:
        with Session(engine) as session:
            # 這是標準 SQL 指令：如果沒有 title 欄位，就加進去
            # 舊資料的 title 會自動變成 NULL (None)
            session.exec(text("ALTER TABLE message ADD COLUMN IF NOT EXISTS title VARCHAR;"))
            session.commit()
            print("✅ 成功！資料庫已新增 title 欄位，舊資料已保留。")
    except Exception as e:
        print(f"⚠️ 發生錯誤 (可能欄位已存在): {e}")

if __name__ == "__main__":
    add_title_column()