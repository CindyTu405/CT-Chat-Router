"""(S-U1-3) message/branch nullable user_id, user oauth unique, auth_session token_hash unique

Revision ID: d7e8f9a0b1c2
Revises: c6d7e8f9a0b1
Create Date: 2026-11-05 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd7e8f9a0b1c2'
down_revision: Union[str, Sequence[str], None] = 'c6d7e8f9a0b1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('message', sa.Column('user_id', sa.Uuid(), nullable=True))
    op.create_index(op.f('ix_message_user_id'), 'message', ['user_id'], unique=False)
    op.create_foreign_key('fk_message_user_id_user', 'message', 'user', ['user_id'], ['id'])

    op.add_column('branch', sa.Column('user_id', sa.Uuid(), nullable=True))
    op.create_index(op.f('ix_branch_user_id'), 'branch', ['user_id'], unique=False)
    op.create_foreign_key('fk_branch_user_id_user', 'branch', 'user', ['user_id'], ['id'])

    op.create_unique_constraint(
        'uq_user_oauth_provider_sub', 'user', ['oauth_provider', 'oauth_sub']
    )

    op.drop_index(op.f('ix_auth_session_token_hash'), table_name='auth_session')
    op.create_index(op.f('ix_auth_session_token_hash'), 'auth_session', ['token_hash'], unique=True)


def downgrade() -> None:
    op.drop_index(op.f('ix_auth_session_token_hash'), table_name='auth_session')
    op.create_index(op.f('ix_auth_session_token_hash'), 'auth_session', ['token_hash'], unique=False)

    op.drop_constraint('uq_user_oauth_provider_sub', 'user', type_='unique')

    op.drop_constraint('fk_branch_user_id_user', 'branch', type_='foreignkey')
    op.drop_index(op.f('ix_branch_user_id'), table_name='branch')
    op.drop_column('branch', 'user_id')

    op.drop_constraint('fk_message_user_id_user', 'message', type_='foreignkey')
    op.drop_index(op.f('ix_message_user_id'), table_name='message')
    op.drop_column('message', 'user_id')
