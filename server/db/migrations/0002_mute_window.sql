-- ---------------------------------------------------------------------------
-- 0002: silenciamento (mute) separado de suspensao.
--
-- Antes, o mute escrevia `users.status = 'suspended'`, o que:
--   1) bloqueava o LOGIN (o requisito e' bloquear escrita, nao entrar) e
--   2) confundia dois numeros de painel (suspensos x silenciados).
--
-- Agora `muted_until` guarda a janela (2/4/6/10 min, decidida pelo backend) e
-- `status` continua signifying apenas active/suspended/banned/deleted.
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN muted_until INTEGER;

CREATE INDEX IF NOT EXISTS idx_users_muted ON users(muted_until)
  WHERE muted_until IS NOT NULL;

-- Contas que foram silenciadas (status = 'suspended' sem motivo de suspensao
-- real) voltam para active com a janela corretamente preenchida a partir de
-- `status_until`, para nao deixar ninguem preso no estado antigo.
UPDATE users
   SET muted_until = status_until,
       status = 'active',
       status_until = NULL,
       status_reason = NULL
 WHERE status = 'suspended'
   AND status_until IS NOT NULL
   AND (status_reason LIKE 'Silenciado%' OR status_reason IS NULL);