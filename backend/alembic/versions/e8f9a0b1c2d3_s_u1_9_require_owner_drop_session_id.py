"""(S-U1-9) message/branch user_id NOT NULL, drop message.session_id

Revision ID: e8f9a0b1c2d3
Revises: d7e8f9a0b1c2
Create Date: 2026-11-06 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e8f9a0b1c2d3'
down_revision: Union[str, Sequence[str], None] = 'd7e8f9a0b1c2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 有 NULL 擁有者就中止：此時尚未做任何變更（同一個交易，raise 會整筆回復）。
    bind = op.get_bind()
    null_messages = bind.execute(sa.text("SELECT count(*) FROM message WHERE user_id IS NULL")).scalar()
    null_branches = bind.execute(sa.text("SELECT count(*) FROM branch WHERE user_id IS NULL")).scalar()
    if null_messages or null_branches:
        raise RuntimeError(
            "(S-U1-9) 中止：仍有沒有擁有者的資料 "
            f"(message user_id NULL = {null_messages}, branch user_id NULL = {null_branches})。"
            "請先指派擁有者後再執行 upgrade；本次未做任何變更。"
        )

    op.alter_column('message', 'user_id', existing_type=sa.Uuid(), nullable=False)
    op.alter_column('branch', 'user_id', existing_type=sa.Uuid(), nullable=False)

    op.drop_column('message', 'session_id')


def downgrade() -> None:
    op.add_column('message', sa.Column('session_id', sa.String(), nullable=True))
    op.execute("UPDATE message SET session_id = 'default'")
    op.alter_column('message', 'session_id', existing_type=sa.String(), nullable=False)

    op.alter_column('branch', 'user_id', existing_type=sa.Uuid(), nullable=True)
    op.alter_column('message', 'user_id', existing_type=sa.Uuid(), nullable=True)
