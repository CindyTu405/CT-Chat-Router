# backend/migrate_branches.py
from sqlmodel import text, Session
from database import engine

def migrate():
    print("1. 正在嘗試新增 has_branch 欄位...")
    try:
        with Session(engine) as session:
            # 加上布林值欄位，預設為 False
            session.exec(text("ALTER TABLE message ADD COLUMN IF NOT EXISTS has_branch BOOLEAN DEFAULT FALSE;"))
            session.commit()
            print("✅ 成功新增 has_branch 欄位！")
    except Exception as e:
        print(f"⚠️ 欄位可能已存在，略過新增。細節: {e}")

    print("2. 開始掃描並標記舊有分支...")
    try:
        with Session(engine) as session:
            # 邏輯：先找出「擁有多個小孩的 parent_id」，然後用遞迴往上找，找出它們的 Root 節點
            query = text("""
            WITH RECURSIVE branch_parents AS (
                SELECT parent_id FROM message 
                WHERE parent_id IS NOT NULL 
                GROUP BY parent_id HAVING COUNT(*) > 1
            ),
            chat_tree AS (
                SELECT id, parent_id FROM message WHERE id IN (SELECT parent_id FROM branch_parents)
                UNION ALL
                SELECT m.id, m.parent_id FROM message m
                JOIN chat_tree ct ON m.id = ct.parent_id
            )
            SELECT DISTINCT id FROM chat_tree WHERE parent_id IS NULL;
            """)
            
            results = session.exec(query).all()
            root_ids = [r[0] for r in results]
            
            if root_ids:
                # 找到根節點了，把它們的 has_branch 設為 True
                for rid in root_ids:
                    session.exec(text("UPDATE message SET has_branch = TRUE WHERE id = :rid"), params={"rid": rid})
                session.commit()
                print(f"✅ 成功標記 {len(root_ids)} 個具有分支的舊對話串！")
            else:
                print("✅ 歷史紀錄中沒有發現需要標記的分支對話。")
    except Exception as e:
        print(f"❌ 標記舊資料失敗: {e}")

if __name__ == "__main__":
    migrate()