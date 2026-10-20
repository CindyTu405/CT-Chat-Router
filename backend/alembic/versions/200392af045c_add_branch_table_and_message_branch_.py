"""add branch table and message branch fields

Revision ID: 200392af045c
Revises: 20110ec0fb4a
Create Date: 2026-10-20 16:59:17.674264

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel  # noqa: F401  # SQLModel 的 AutoString 型別需要


# revision identifiers, used by Alembic.
revision: str = '200392af045c'
down_revision: Union[str, Sequence[str], None] = '20110ec0fb4a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# branch 和 message 之間是「互相參考」的外鍵 (branch -> message,
# message.branch_id -> branch)，Alembic 無法自動排序，會出現
# "unresolvable cycles between tables" 警告。
# 所以這裡手動固定順序：先建 branch 表 (它參考已存在的 message)，
# 再為 message 加上指向 branch 的新欄位。downgrade 反過來。
#
# 另外 autogenerate 產生的是無名外鍵，降級時 drop_constraint(None, ...)
# 會直接失敗，因此所有新外鍵都給明確名稱。

def upgrade() -> None:
    """Upgrade schema."""
    # 1. 先建 branch 表 (只依賴既有的 message 表)
    op.create_table('branch',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('root_message_id', sa.Uuid(), nullable=False),
    sa.Column('anchor_message_id', sa.Uuid(), nullable=False),
    sa.Column('title', sqlmodel.sql.sqltypes.AutoString(), nullable=True),
    sa.Column('parent_branch_id', sa.Uuid(), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['anchor_message_id'], ['message.id'], name='fk_branch_anchor_message_id_message'),
    sa.ForeignKeyConstraint(['parent_branch_id'], ['branch.id'], name='fk_branch_parent_branch_id_branch'),
    sa.ForeignKeyConstraint(['root_message_id'], ['message.id'], name='fk_branch_root_message_id_message'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_branch_anchor_message_id'), 'branch', ['anchor_message_id'], unique=False)
    op.create_index(op.f('ix_branch_root_message_id'), 'branch', ['root_message_id'], unique=False)

    # 2. branch 表存在後，才為 message 加欄位與外鍵
    op.add_column('message', sa.Column('branch_id', sa.Uuid(), nullable=True))
    op.add_column('message', sa.Column('anchor_message_id', sa.Uuid(), nullable=True))
    op.create_index(op.f('ix_message_branch_id'), 'message', ['branch_id'], unique=False)
    op.create_foreign_key(
        'fk_message_anchor_message_id_message',
        'message', 'message', ['anchor_message_id'], ['id'],
    )
    op.create_foreign_key(
        'fk_message_branch_id_branch',
        'message', 'branch', ['branch_id'], ['id'],
    )


def downgrade() -> None:
    """Downgrade schema."""
    # 反序：先移除 message 的新外鍵與欄位，最後才 drop branch 表
    op.drop_constraint('fk_message_branch_id_branch', 'message', type_='foreignkey')
    op.drop_constraint('fk_message_anchor_message_id_message', 'message', type_='foreignkey')
    op.drop_index(op.f('ix_message_branch_id'), table_name='message')
    op.drop_column('message', 'anchor_message_id')
    op.drop_column('message', 'branch_id')

    op.drop_index(op.f('ix_branch_root_message_id'), table_name='branch')
    op.drop_index(op.f('ix_branch_anchor_message_id'), table_name='branch')
    op.drop_table('branch')
