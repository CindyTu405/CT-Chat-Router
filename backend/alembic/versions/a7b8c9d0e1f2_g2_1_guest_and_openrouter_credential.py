"""(G2-1) add user.last_active_at, guest_ip_usage, openrouter_credential

Revision ID: a7b8c9d0e1f2
Revises: f1a2b3c4d5e6
Create Date: 2026-11-14 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a7b8c9d0e1f2'
down_revision: Union[str, Sequence[str], None] = 'f1a2b3c4d5e6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('user', sa.Column('last_active_at', sa.DateTime(), nullable=True))
    op.create_table(
        'guest_ip_usage',
        sa.Column('ip_hash', sa.String(length=64), nullable=False),
        sa.Column('day', sa.Date(), nullable=False),
        sa.Column('guests_created', sa.Integer(), server_default='0', nullable=False),
        sa.Column('messages', sa.Integer(), server_default='0', nullable=False),
        sa.PrimaryKeyConstraint('ip_hash', 'day'),
    )
    op.create_table(
        'openrouter_credential',
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('key_encrypted', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['user.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('user_id'),
    )


def downgrade() -> None:
    op.drop_table('openrouter_credential')
    op.drop_table('guest_ip_usage')
    op.drop_column('user', 'last_active_at')
