"""(G6-1) branch: nullable anchor_message_id, is_orphaned, attach_root_id

Revision ID: c6d7e8f9a0b1
Revises: b1a2c3d4e5f6
Create Date: 2026-11-03 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c6d7e8f9a0b1'
down_revision: Union[str, Sequence[str], None] = 'b1a2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # (G6-1) 幽靈分支與底部入口都沒有錨點，所以 anchor_message_id 要允許 NULL（DESIGN_P3 主題 2）
    op.alter_column('branch', 'anchor_message_id',
               existing_type=sa.UUID(),
               nullable=True)
    # 幽靈旗標；server_default 讓既有列自動補 false
    op.add_column('branch', sa.Column('is_orphaned', sa.Boolean(), nullable=False,
                                      server_default=sa.false()))
    # 底部入口所屬對話（本次只加欄位，重連 API 之後才做）
    op.add_column('branch', sa.Column('attach_root_id', sa.UUID(), nullable=True))
    op.create_foreign_key('fk_branch_attach_root_id_message', 'branch', 'message',
                          ['attach_root_id'], ['id'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('fk_branch_attach_root_id_message', 'branch', type_='foreignkey')
    op.drop_column('branch', 'attach_root_id')
    op.drop_column('branch', 'is_orphaned')
    # 舊 schema 的 anchor_message_id 是 NOT NULL；若已有幽靈／底部入口分支（anchor 為 NULL），
    # 這裡直接失敗，不自動刪資料，由人決定如何處理。
    op.execute(sa.text("""
    DO $$
    BEGIN
        IF EXISTS (SELECT 1 FROM branch WHERE anchor_message_id IS NULL) THEN
            RAISE EXCEPTION 'downgrade 中止：branch 內仍有 anchor_message_id 為 NULL 的幽靈／底部入口分支';
        END IF;
    END $$;
    """))
    op.alter_column('branch', 'anchor_message_id',
               existing_type=sa.UUID(),
               nullable=False)
