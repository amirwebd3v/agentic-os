-- Learned sender rules and early filing (owner's decision, 2026-11-02).
-- A Personal mail keeps a keyed one-way hash of its sender, never the address, so a Personal sender can be recognised
-- next time without reading the mail. A rule's `sender` is either an address or `#<hash>`.
ALTER TABLE mail_messages ADD COLUMN sender_hash TEXT;
CREATE INDEX mail_messages_sender ON mail_messages (sender);
CREATE INDEX mail_messages_sender_hash ON mail_messages (sender_hash);

-- `learned`: made from the owner's own sorting. `disabled`: a learned rule the owner removed, kept so it is never
-- learned again from the same history.
ALTER TABLE mail_sender_rules ADD COLUMN learned INTEGER NOT NULL DEFAULT 0 CHECK (learned IN (0, 1));
ALTER TABLE mail_sender_rules ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1));

-- Noise keeps its sender only (owner's decision): drop what it held before.
UPDATE mail_messages SET subject = NULL, excerpt = NULL, eligible = 0
WHERE category_id = (SELECT id FROM mail_categories WHERE system = 'noise');
