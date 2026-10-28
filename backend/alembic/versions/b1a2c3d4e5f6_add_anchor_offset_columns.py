"""add anchor_start and anchor_end offsets to branch

Revision ID: b1a2c3d4e5f6
Revises: 29e924b14bfa
Create Date: 2026-10-28 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel  # noqa: F401  # SQLModel 的 AutoString 型別需要


# revision identifiers, used by Alembic.
revision: str = 'b1a2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = '29e924b14bfa'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # 半開區間 [anchor_start, anchor_end)，指向來源 markdown 的字元位移
    op.add_column('branch', sa.Column('anchor_start', sa.Integer(), nullable=True))
    op.add_column('branch', sa.Column('anchor_end', sa.Integer(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('branch', 'anchor_end')
    op.drop_column('branch', 'anchor_start')
