"""baseline

Revision ID: e4d003f1bea8
Revises: 
Create Date: 2026-10-20 13:13:23.224697

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e4d003f1bea8'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # (CI-1) 導入 Alembic 時 message、freemodelscache 已由 create_all 建好，所以原本這裡是空的，
    # 空資料庫無法從零執行 migration。補上兩張表「當時」的樣子；表已存在就跳過，
    # 已執行過 baseline 的資料庫不會重跑這支，不受影響。
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    if 'message' not in existing:
        op.create_table(
            'message',
            sa.Column('content', sa.String(), nullable=False),
            sa.Column('role', sa.String(), nullable=False),
            sa.Column('model_used', sa.String(), nullable=True),
            sa.Column('created_at', sa.DateTime(), nullable=False),
            sa.Column('session_id', sa.String(), nullable=False),
            sa.Column('parent_id', sa.Uuid(), nullable=True),
            sa.Column('title', sa.String(), nullable=True),
            sa.Column('has_branch', sa.Boolean(), nullable=False),
            sa.Column('id', sa.Uuid(), nullable=False),
            sa.ForeignKeyConstraint(['parent_id'], ['message.id'], name='message_parent_id_fkey'),
            sa.PrimaryKeyConstraint('id', name='message_pkey'),
        )
    if 'freemodelscache' not in existing:
        op.create_table(
            'freemodelscache',
            sa.Column('id', sa.Integer(), autoincrement=False, nullable=False),
            sa.Column('models_json', sa.String(), nullable=False),
            sa.Column('updated_at', sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint('id', name='freemodelscache_pkey'),
        )


def downgrade() -> None:
    """Downgrade schema."""
    pass
