'use strict';

function int(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return String(value).toLowerCase() === 'true' || value === '1';
}

/*
  Plan limits. FREE is deliberately usable on its own: a small community can
  invite the bot, track its server, and get a live counter channel plus a 24h
  graph without ever seeing a paywall. PRO raises the ceilings and adds the
  things that only matter once you run more than one server.
*/
const PLANS = {
  FREE: {
    name: 'Free',
    trackedServers: int(process.env.FREE_TRACKED_SERVERS, 2),
    counterChannels: int(process.env.FREE_COUNTER_CHANNELS, 1),
    statusMessages: int(process.env.FREE_STATUS_MESSAGES, 1),
    alerts: int(process.env.FREE_ALERTS, 0),
    // Minutes between automatic refreshes of counters and live messages.
    refreshMinutes: int(process.env.FREE_REFRESH_MINUTES, 10),
    graphRanges: ['24h'],
    compareServers: 1,
    playerList: false,
    exports: false,
    customTemplates: false,
  },
  PRO: {
    name: 'Pro',
    trackedServers: int(process.env.PRO_TRACKED_SERVERS, 25),
    counterChannels: int(process.env.PRO_COUNTER_CHANNELS, 10),
    statusMessages: int(process.env.PRO_STATUS_MESSAGES, 10),
    alerts: int(process.env.PRO_ALERTS, 25),
    refreshMinutes: int(process.env.PRO_REFRESH_MINUTES, 2),
    graphRanges: ['24h', '7d', '30d', '90d'],
    compareServers: 5,
    playerList: true,
    exports: true,
    customTemplates: true,
  },
};

// One subscription powers a person, not a reseller. Stated on the pricing card.
const PRO_GUILD_LIMIT = int(process.env.PRO_GUILD_LIMIT, 3);

const { version } = require('../package.json');

const config = {
  version,

  /*
    Where live server data comes from.

    `api`    the public gamequery.dev API. The default, and the only mode that
             works outside our cluster, so this is what every self-hosted copy
             uses.
    `direct` the platform's own Redis and Postgres. Skips the HTTP hop and the
             API quota, and only works inside the gamequery.dev cluster.

    A gamequery.dev API key is required either way. The bot is a client of the
    service; it never speaks a game protocol itself.
  */
  source: String(process.env.GAMEQUERY_SOURCE || 'api').trim().toLowerCase(),

  /*
    How the Free/Pro split is decided.

    `unlimited` every feature is on. This is the default, and it is what a
                self-hosted copy gets: you brought your own gamequery.dev API
                key and you are paying for your own hosting, so there is
                nothing left to meter. It also means the bot needs no billing
                tables, which a self-hoster's database does not have.

    `hosted`    Pro is granted by an active API PRO subscription, checked
                against the billing tables. Only the instance we run sets this.
  */
  planMode: String(process.env.PLAN_MODE || 'unlimited').trim().toLowerCase(),

  api: {
    baseUrl: (process.env.GAMEQUERY_API_URL || 'https://api.gamequery.dev').replace(/\/+$/, ''),
    token: String(process.env.GAMEQUERY_API_TOKEN || '').trim(),
    email: String(process.env.GAMEQUERY_API_EMAIL || '').trim().toLowerCase(),
    type: String(process.env.GAMEQUERY_API_TYPE || 'FREE').trim().toUpperCase(),
    timeoutMs: int(process.env.GAMEQUERY_API_TIMEOUT_MS, 15000),
  },

  token: process.env.DISCORD_BOT_TOKEN || '',

  /*
    The bot's own application id.

    DISCORD_CLIENT_ID is the WEBSITE's Discord login app, and on gamequery.dev
    that is a different application from the one the bot token belongs to. Using
    it here produced an invite link for an app with no bot user: clicking it
    appeared to work and added nothing, and the bot showed as offline because it
    was never in the guild at all.

    So this is only a fallback. setClientId() overwrites it at boot with
    client.application.id, which comes from the token and therefore cannot
    disagree with the bot that is actually running.
  */
  clientId: process.env.DISCORD_BOT_CLIENT_ID || process.env.DISCORD_CLIENT_ID || '',
  siteUrl: (process.env.SITE_URL || 'https://gamequery.dev').replace(/\/+$/, ''),
  proUpgradeUrl: process.env.PRO_UPGRADE_URL || '',
  supportInviteUrl: process.env.SUPPORT_INVITE_URL || '',

  /*
    DATABASE_URL is the one a self-hoster sets. The DB_* variables are how the
    hosted deployment already supplies credentials, so both are accepted rather
    than forcing one environment to carry the other's shape.
  */
  db: {
    connectionString: process.env.DATABASE_URL || '',
    host: process.env.DB_HOST || 'postgres',
    port: int(process.env.DB_PORT, 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    ssl: bool(process.env.DATABASE_SSL, false),
    max: int(process.env.DB_CONNECTION_LIMIT, 8),
  },

  redis: {
    host: process.env.REDIS_HOST || 'redis',
    port: int(process.env.REDIS_PORT, 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    database: int(process.env.REDIS_DB, 1),
    keyPrefix: process.env.REDIS_KEY_PREFIX || 'API_V1_',
  },

  // A cached payload older than this is reported as stale rather than live,
  // matching how the v1 API decides freshness.
  maxServerAgeSeconds: int(process.env.MAX_SERVER_AGE_SECONDS, 600),

  intervals: {
    samplerMinutes: int(process.env.SAMPLER_INTERVAL_MINUTES, 5),
    counterSeconds: int(process.env.COUNTER_TICK_SECONDS, 60),
    statusSeconds: int(process.env.STATUS_TICK_SECONDS, 60),
    alertSeconds: int(process.env.ALERT_TICK_SECONDS, 120),
    entitlementMinutes: int(process.env.ENTITLEMENT_INTERVAL_MINUTES, 15),
    pruneHours: int(process.env.PRUNE_INTERVAL_HOURS, 6),
    reportSeconds: int(process.env.REPORT_TICK_SECONDS, 300),
  },

  retention: {
    sampleDays: int(process.env.SAMPLE_RETENTION_DAYS, 35),
    hourlyDays: int(process.env.HOURLY_RETENTION_DAYS, 400),
    linkCodeMinutes: int(process.env.LINK_CODE_TTL_MINUTES, 15),
  },

  fontDir: process.env.FONT_DIR || '/usr/share/fonts/dejavu',
  gamesJsonPath: process.env.GAMES_JSON_PATH || '/app/data/games.json',
  registerCommandsOnBoot: bool(process.env.REGISTER_COMMANDS_ON_BOOT, true),
  debug: bool(process.env.BOT_DEBUG, false),

  plans: PLANS,
  proGuildLimit: PRO_GUILD_LIMIT,
};

/*
  125968 = Manage Channels | View Channel | Send Messages | Manage Messages |
  Embed Links | Attach Files | Read Message History. Manage Channels is the
  only privileged-looking bit and it is what renames the counter channels;
  without it every other feature still works.
*/
config.invitePermissions = process.env.INVITE_PERMISSIONS || '125968';

function buildInviteUrl(clientId) {
  return clientId
    ? `https://discord.com/oauth2/authorize?client_id=${clientId}`
      + `&permissions=${config.invitePermissions}&scope=bot%20applications.commands`
    : '';
}

config.inviteUrl = buildInviteUrl(config.clientId);

// Called once the gateway is up, with the id the token actually belongs to.
config.setClientId = (clientId) => {
  const value = String(clientId || '').trim();

  if (!value) {
    return;
  }

  if (config.clientId && config.clientId !== value) {
    console.warn(
      `[config] DISCORD_CLIENT_ID is ${config.clientId} but this token belongs to application ${value}. `
      + 'Using the token\'s application for the invite link.'
    );
  }

  config.clientId = value;
  config.inviteUrl = buildInviteUrl(value);
};

module.exports = config;
