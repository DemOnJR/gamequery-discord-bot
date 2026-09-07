-- Detach the bot's tables from the gamequery.dev platform schema.
--
-- The first version of the bot ran only as our hosted instance, so its history
-- keyed on `servers.id`, the platform's own table. That is unreachable for
-- anyone self-hosting: they have a Postgres of their own and no `servers` table
-- in it, so the bot could never have run outside our cluster.
--
-- This repoints everything at gq_servers, which the bot owns. On a fresh
-- install (a self-hoster running 001 then 002) there is nothing to convert and
-- every statement here is a no-op.
--
-- Written to be safe to run twice.

-- Carry across any address the bot already tracked, and any address that
-- already has history, so no graph loses its past.
INSERT INTO gq_servers (game, address)
SELECT DISTINCT t.game, t.address
FROM discord_tracked_servers t
ON CONFLICT (game, address) DO NOTHING;

DO $do$
BEGIN
    -- Only meaningful on the hosted instance, where the platform table exists.
    IF to_regclass('public.servers') IS NOT NULL THEN
        INSERT INTO gq_servers (game, address)
        SELECT DISTINCT s.game, s.server
        FROM servers s
        WHERE EXISTS (
            SELECT 1 FROM server_player_samples sp WHERE sp.server_id = s.id
        )
        ON CONFLICT (game, address) DO NOTHING;

        -- Re-key existing history from servers.id onto gq_servers.id.
        UPDATE server_player_samples sp
        SET server_id = g.id
        FROM servers s
        JOIN gq_servers g ON g.game = s.game AND g.address = s.server
        WHERE sp.server_id = s.id
          AND sp.server_id <> g.id;

        UPDATE server_player_hourly sh
        SET server_id = g.id
        FROM servers s
        JOIN gq_servers g ON g.game = s.game AND g.address = s.server
        WHERE sh.server_id = s.id
          AND sh.server_id <> g.id;

        UPDATE discord_tracked_servers t
        SET server_id = g.id
        FROM gq_servers g
        WHERE g.game = t.game
          AND g.address = t.address
          AND t.server_id IS DISTINCT FROM g.id;
    END IF;
END
$do$;

-- Drop any history row that could not be mapped, so the foreign keys below can
-- be created. A sample whose server is unknown cannot be plotted anyway.
DELETE FROM server_player_samples sp
WHERE NOT EXISTS (SELECT 1 FROM gq_servers g WHERE g.id = sp.server_id);

DELETE FROM server_player_hourly sh
WHERE NOT EXISTS (SELECT 1 FROM gq_servers g WHERE g.id = sh.server_id);

-- Repoint the constraints themselves.
DO $do$
DECLARE
    spec RECORD;
BEGIN
    FOR spec IN
        SELECT con.conname, rel.relname AS table_name
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_class ref ON ref.oid = con.confrelid
        WHERE con.contype = 'f'
          AND ref.relname = 'servers'
          AND rel.relname IN (
              'server_player_samples',
              'server_player_hourly',
              'discord_tracked_servers'
          )
    LOOP
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', spec.table_name, spec.conname);
    END LOOP;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'server_player_samples_server_fk'
    ) THEN
        ALTER TABLE server_player_samples
            ADD CONSTRAINT server_player_samples_server_fk
            FOREIGN KEY (server_id) REFERENCES gq_servers(id) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'server_player_hourly_server_fk'
    ) THEN
        ALTER TABLE server_player_hourly
            ADD CONSTRAINT server_player_hourly_server_fk
            FOREIGN KEY (server_id) REFERENCES gq_servers(id) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'discord_tracked_servers_server_fk'
    ) THEN
        ALTER TABLE discord_tracked_servers
            ADD CONSTRAINT discord_tracked_servers_server_fk
            FOREIGN KEY (server_id) REFERENCES gq_servers(id) ON DELETE SET NULL;
    END IF;
END
$do$;

-- Columns added after the first release; harmless on a fresh install.
ALTER TABLE discord_tracked_servers ADD COLUMN IF NOT EXISTS server_group VARCHAR(60);
ALTER TABLE discord_tracked_servers ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discord_counter_channels ADD COLUMN IF NOT EXISTS server_group VARCHAR(60);
ALTER TABLE discord_status_messages ADD COLUMN IF NOT EXISTS server_group VARCHAR(60);
ALTER TABLE discord_guilds ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NOT NULL DEFAULT 'UTC';

-- last_state holds a hashed map fingerprint, which needs more than 32 chars.
ALTER TABLE discord_alerts ALTER COLUMN last_state TYPE VARCHAR(64);

-- 'empty' and 'uptime' were added with the report and uptime features.
ALTER TABLE discord_alerts DROP CONSTRAINT IF EXISTS discord_alerts_type_check;
ALTER TABLE discord_alerts ADD CONSTRAINT discord_alerts_type_check
    CHECK (alert_type IN ('offline', 'online', 'players_above', 'players_below', 'full', 'empty', 'map_change'));

ALTER TABLE discord_status_messages DROP CONSTRAINT IF EXISTS discord_status_messages_mode_check;
ALTER TABLE discord_status_messages ADD CONSTRAINT discord_status_messages_mode_check
    CHECK (mode IN ('status', 'graph', 'list', 'uptime'));
