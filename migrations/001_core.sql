-- GameQuery Discord bot: core schema.
--
-- Self-contained on purpose. Everything the bot needs is created here, and
-- nothing references a table belonging to the gamequery.dev platform, so a
-- self-hosted copy pointed at an empty Postgres works exactly like the hosted
-- one. The bot applies this itself at boot; there is no separate migrate step.
--
-- The one thing worth understanding is gq_servers. Player history is keyed on
-- it rather than on a guild, which means two Discord servers tracking the same
-- address share one history, history survives an untrack and retrack, and a
-- graph is useful the moment a server is added rather than a day later.

CREATE TABLE IF NOT EXISTS gq_servers (
    id BIGSERIAL PRIMARY KEY,
    game VARCHAR(128) NOT NULL,
    address VARCHAR(255) NOT NULL,
    last_hostname VARCHAR(255),
    last_map VARCHAR(160),
    last_players INTEGER,
    last_max_players INTEGER,
    last_online_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT gq_servers_unique UNIQUE (game, address)
);

CREATE INDEX IF NOT EXISTS idx_gq_servers_address ON gq_servers (address);

-- Account linking ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS discord_account_links (
    discord_user_id VARCHAR(32) PRIMARY KEY,
    user_email VARCHAR(255) NOT NULL,
    discord_username VARCHAR(64),
    linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discord_account_links_email
    ON discord_account_links (lower(user_email));

CREATE TABLE IF NOT EXISTS discord_link_codes (
    code VARCHAR(16) PRIMARY KEY,
    discord_user_id VARCHAR(32) NOT NULL,
    discord_username VARCHAR(64),
    guild_id VARCHAR(32),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    consumed_by_email VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discord_link_codes_expires ON discord_link_codes (expires_at);
CREATE INDEX IF NOT EXISTS idx_discord_link_codes_discord_user
    ON discord_link_codes (discord_user_id, created_at DESC);

-- Guilds ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS discord_guilds (
    guild_id VARCHAR(32) PRIMARY KEY,
    guild_name VARCHAR(255),
    pro_discord_user_id VARCHAR(32),
    pro_email VARCHAR(255),
    pro_active BOOLEAN NOT NULL DEFAULT FALSE,
    pro_claimed_at TIMESTAMPTZ,
    pro_checked_at TIMESTAMPTZ,
    timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    left_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discord_guilds_pro_email
    ON discord_guilds (lower(pro_email)) WHERE pro_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_discord_guilds_active
    ON discord_guilds (left_at) WHERE left_at IS NULL;

-- Tracked servers ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS discord_tracked_servers (
    id BIGSERIAL PRIMARY KEY,
    guild_id VARCHAR(32) NOT NULL REFERENCES discord_guilds(guild_id) ON DELETE CASCADE,
    server_id BIGINT REFERENCES gq_servers(id) ON DELETE SET NULL,
    game VARCHAR(128) NOT NULL,
    address VARCHAR(255) NOT NULL,
    label VARCHAR(100),
    server_group VARCHAR(60),
    sort_order INTEGER NOT NULL DEFAULT 0,
    added_by_discord_user_id VARCHAR(32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT discord_tracked_servers_unique UNIQUE (guild_id, address)
);

CREATE INDEX IF NOT EXISTS idx_discord_tracked_servers_guild
    ON discord_tracked_servers (guild_id, sort_order, created_at);
CREATE INDEX IF NOT EXISTS idx_discord_tracked_servers_server
    ON discord_tracked_servers (server_id) WHERE server_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_discord_tracked_servers_group
    ON discord_tracked_servers (guild_id, server_group) WHERE server_group IS NOT NULL;

-- Counter channels -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS discord_counter_channels (
    id BIGSERIAL PRIMARY KEY,
    guild_id VARCHAR(32) NOT NULL REFERENCES discord_guilds(guild_id) ON DELETE CASCADE,
    channel_id VARCHAR(32) NOT NULL UNIQUE,
    channel_kind VARCHAR(16) NOT NULL DEFAULT 'voice',
    tracked_server_id BIGINT REFERENCES discord_tracked_servers(id) ON DELETE CASCADE,
    server_group VARCHAR(60),
    name_template VARCHAR(120) NOT NULL,
    last_rendered_name VARCHAR(120),
    last_updated_at TIMESTAMPTZ,
    fail_streak SMALLINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT discord_counter_channels_kind_check
        CHECK (channel_kind IN ('voice', 'text', 'category', 'stage'))
);

CREATE INDEX IF NOT EXISTS idx_discord_counter_channels_guild
    ON discord_counter_channels (guild_id);

-- Self-updating messages -----------------------------------------------------

CREATE TABLE IF NOT EXISTS discord_status_messages (
    id BIGSERIAL PRIMARY KEY,
    guild_id VARCHAR(32) NOT NULL REFERENCES discord_guilds(guild_id) ON DELETE CASCADE,
    channel_id VARCHAR(32) NOT NULL,
    message_id VARCHAR(32) NOT NULL UNIQUE,
    tracked_server_id BIGINT REFERENCES discord_tracked_servers(id) ON DELETE CASCADE,
    server_group VARCHAR(60),
    mode VARCHAR(16) NOT NULL DEFAULT 'status',
    graph_range VARCHAR(8),
    last_updated_at TIMESTAMPTZ,
    fail_streak SMALLINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT discord_status_messages_mode_check
        CHECK (mode IN ('status', 'graph', 'list', 'uptime'))
);

CREATE INDEX IF NOT EXISTS idx_discord_status_messages_guild
    ON discord_status_messages (guild_id);

-- Alerts ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS discord_alerts (
    id BIGSERIAL PRIMARY KEY,
    guild_id VARCHAR(32) NOT NULL REFERENCES discord_guilds(guild_id) ON DELETE CASCADE,
    tracked_server_id BIGINT NOT NULL REFERENCES discord_tracked_servers(id) ON DELETE CASCADE,
    channel_id VARCHAR(32) NOT NULL,
    alert_type VARCHAR(24) NOT NULL,
    threshold INTEGER,
    mention_role_id VARCHAR(32),
    last_state VARCHAR(64),
    last_fired_at TIMESTAMPTZ,
    cooldown_minutes SMALLINT NOT NULL DEFAULT 15,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT discord_alerts_type_check
        CHECK (alert_type IN ('offline', 'online', 'players_above', 'players_below', 'full', 'empty', 'map_change')),
    CONSTRAINT discord_alerts_cooldown_check CHECK (cooldown_minutes >= 0)
);

CREATE INDEX IF NOT EXISTS idx_discord_alerts_active
    ON discord_alerts (tracked_server_id) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_discord_alerts_guild ON discord_alerts (guild_id);

-- Scheduled reports ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS discord_reports (
    id BIGSERIAL PRIMARY KEY,
    guild_id VARCHAR(32) NOT NULL REFERENCES discord_guilds(guild_id) ON DELETE CASCADE,
    channel_id VARCHAR(32) NOT NULL,
    cadence VARCHAR(16) NOT NULL DEFAULT 'daily',
    hour_utc SMALLINT NOT NULL DEFAULT 9,
    mention_role_id VARCHAR(32),
    last_sent_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT discord_reports_cadence_check CHECK (cadence IN ('daily', 'weekly')),
    CONSTRAINT discord_reports_hour_check CHECK (hour_utc BETWEEN 0 AND 23)
);

CREATE INDEX IF NOT EXISTS idx_discord_reports_active
    ON discord_reports (is_active, hour_utc) WHERE is_active = TRUE;

-- Player-count history -------------------------------------------------------

CREATE TABLE IF NOT EXISTS server_player_samples (
    server_id BIGINT NOT NULL REFERENCES gq_servers(id) ON DELETE CASCADE,
    bucket_at TIMESTAMPTZ NOT NULL,
    players INTEGER NOT NULL DEFAULT 0,
    max_players INTEGER,
    online BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (server_id, bucket_at)
);

CREATE INDEX IF NOT EXISTS idx_server_player_samples_bucket
    ON server_player_samples (bucket_at);

CREATE TABLE IF NOT EXISTS server_player_hourly (
    server_id BIGINT NOT NULL REFERENCES gq_servers(id) ON DELETE CASCADE,
    bucket_hour TIMESTAMPTZ NOT NULL,
    players_avg NUMERIC(8,2) NOT NULL DEFAULT 0,
    players_peak INTEGER NOT NULL DEFAULT 0,
    players_min INTEGER NOT NULL DEFAULT 0,
    max_players INTEGER,
    samples INTEGER NOT NULL DEFAULT 0,
    online_samples INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (server_id, bucket_hour)
);

CREATE INDEX IF NOT EXISTS idx_server_player_hourly_bucket
    ON server_player_hourly (bucket_hour);

-- updated_at -----------------------------------------------------------------

CREATE OR REPLACE FUNCTION gq_set_updated_at() RETURNS trigger AS $fn$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DO $do$
DECLARE
    target TEXT;
BEGIN
    FOREACH target IN ARRAY ARRAY[
        'discord_account_links',
        'discord_guilds',
        'discord_tracked_servers',
        'discord_counter_channels',
        'discord_status_messages',
        'discord_alerts',
        'discord_reports'
    ] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON %1$I', target);
        EXECUTE format(
            'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$I '
            'FOR EACH ROW EXECUTE FUNCTION gq_set_updated_at()', target
        );
    END LOOP;
END
$do$;
