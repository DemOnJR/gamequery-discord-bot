'use strict';

const db = require('./db');
const config = require('../config');

/*
  API PRO product/price ids, read from the same environment the website uses so
  the bot and the checkout never disagree about what "PRO" is. The shared
  Stripe account also carries counter-strike-boost.com's products, so an
  unfiltered "any active subscription" check would hand GameQuery PRO to a CSB
  customer. Everything below filters on these identifiers.
*/
function getApiProIdentifiers() {
  const keys = [
    'STRIPE_API_PRO_PRODUCT_ID',
    'STRIPE_API_PRO_PRODUCT_ID_LIVE',
    'STRIPE_API_PRO_PRODUCT_ID_TEST',
    'STRIPE_API_PRO_PRICE_ID',
    'STRIPE_API_PRO_PRICE_ID_LIVE',
    'STRIPE_API_PRO_PRICE_ID_TEST',
    'STRIPE_API_PRO_PRICE_ID_YEARLY',
    'STRIPE_API_PRO_PRICE_ID_YEARLY_LIVE',
    'STRIPE_API_PRO_PRICE_ID_YEARLY_TEST',
  ];

  const values = new Set();
  keys.forEach((key) => {
    const value = String(process.env[key] || '').trim();
    if (value) {
      values.add(value);
    }
  });

  return Array.from(values);
}

const ACTIVE_STATUSES = ['active', 'trialing', 'past_due'];

/*
  Active means Stripe still considers the subscription live: `active`,
  `trialing` (the 7-day API PRO trial) or `past_due` (a failed payment retry
  window, where taking features away immediately would punish a card that is
  about to succeed). A cancellation that has already ended is not active even
  though the row is still there.
*/
async function hasActiveApiPro(email) {
  const normalized = String(email || '').trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  // Without hosted billing there is no subscription to check and no table to
  // check it in.
  if (config.planMode !== 'hosted') {
    return true;
  }

  const identifiers = getApiProIdentifiers();

  if (identifiers.length === 0) {
    // Without identifiers the only safe answer is "no". Granting PRO to every
    // subscriber on a shared Stripe account would leak CSB's customers in.
    console.warn('[entitlement] no STRIPE_API_PRO_* identifiers configured; treating everyone as free');
    return false;
  }

  const row = await db.one(
    `SELECT 1
     FROM billing_subscriptions
     WHERE lower(user_email) = $1
       AND status = ANY($2::varchar[])
       AND (stripe_price_id = ANY($3::varchar[]) OR stripe_product_id = ANY($3::varchar[]))
       AND (current_period_end IS NULL OR current_period_end > NOW() - INTERVAL '1 day')
     LIMIT 1`,
    [normalized, ACTIVE_STATUSES, identifiers]
  );

  return Boolean(row);
}

async function getLinkedEmail(discordUserId) {
  if (!discordUserId) {
    return null;
  }

  const row = await db.one(
    'SELECT user_email FROM discord_account_links WHERE discord_user_id = $1',
    [String(discordUserId)]
  );

  if (row) {
    return row.user_email;
  }

  /*
    Someone who signed up on the website with "Continue with Discord" is
    already provably the same person, so their account links itself. Anyone
    who signed up with email, GitHub or Google has to run /link.

    `users` is a gamequery.dev platform table, so this shortcut only exists on
    the hosted instance; a self-hosted database has no such table to read.
  */
  if (config.planMode !== 'hosted') {
    return null;
  }

  const oauthRow = await db.one(
    `SELECT email FROM users
     WHERE auth_provider = 'discord' AND auth_provider_id = $1 AND is_suspended = FALSE
     LIMIT 1`,
    [String(discordUserId)]
  );

  return oauthRow ? oauthRow.email : null;
}

async function isUserPro(discordUserId) {
  const email = await getLinkedEmail(discordUserId);

  if (!email) {
    return { pro: false, email: null, linked: false };
  }

  const pro = await hasActiveApiPro(email);
  return { pro, email, linked: true };
}

/*
  Guild plan. Read from discord_guilds.pro_active, which the entitlement worker
  re-checks on a schedule; a cancellation therefore takes effect within one
  worker interval rather than at the next restart.
*/
async function getGuildPlan(guildId) {
  /*
    A self-hosted bot has no billing tables and nobody to bill: the operator
    already paid with an API key and a server. Returning Pro without touching
    the database is both correct and the only thing that can work there.
  */
  if (config.planMode !== 'hosted') {
    return {
      isPro: true,
      key: 'PRO',
      limits: config.plans.PRO,
      proEmail: null,
      proDiscordUserId: null,
      checkedAt: null,
      selfHosted: true,
    };
  }

  const row = await db.one(
    'SELECT pro_active, pro_email, pro_discord_user_id, pro_checked_at FROM discord_guilds WHERE guild_id = $1',
    [String(guildId)]
  );

  const isPro = Boolean(row && row.pro_active);

  return {
    isPro,
    key: isPro ? 'PRO' : 'FREE',
    limits: isPro ? config.plans.PRO : config.plans.FREE,
    proEmail: row ? row.pro_email : null,
    proDiscordUserId: row ? row.pro_discord_user_id : null,
    checkedAt: row && row.pro_checked_at ? new Date(row.pro_checked_at) : null,
  };
}

async function ensureGuild(guild) {
  await db.query(
    `INSERT INTO discord_guilds (guild_id, guild_name, joined_at, left_at)
     VALUES ($1, $2, NOW(), NULL)
     ON CONFLICT (guild_id) DO UPDATE
       SET guild_name = EXCLUDED.guild_name,
           left_at = NULL`,
    [String(guild.id), String(guild.name || '').slice(0, 255)]
  );
}

async function markGuildLeft(guildId) {
  await db.query(
    'UPDATE discord_guilds SET left_at = NOW() WHERE guild_id = $1',
    [String(guildId)]
  );
}

/*
  A subscription powers up to config.proGuildLimit guilds. The cap is counted
  over guilds the bot is still in, so leaving a server frees a slot.
*/
async function countProGuildsForEmail(email, excludeGuildId = null) {
  const row = await db.one(
    `SELECT COUNT(*)::int AS total
     FROM discord_guilds
     WHERE pro_active = TRUE
       AND left_at IS NULL
       AND lower(pro_email) = lower($1)
       AND ($2::varchar IS NULL OR guild_id <> $2)`,
    [String(email), excludeGuildId ? String(excludeGuildId) : null]
  );

  return row ? row.total : 0;
}

async function claimPro(guildId, discordUserId, email) {
  await db.query(
    `UPDATE discord_guilds
     SET pro_active = TRUE,
         pro_email = $2,
         pro_discord_user_id = $3,
         pro_claimed_at = NOW(),
         pro_checked_at = NOW()
     WHERE guild_id = $1`,
    [String(guildId), String(email), String(discordUserId)]
  );
}

async function releasePro(guildId) {
  await db.query(
    `UPDATE discord_guilds
     SET pro_active = FALSE,
         pro_email = NULL,
         pro_discord_user_id = NULL,
         pro_claimed_at = NULL,
         pro_checked_at = NOW()
     WHERE guild_id = $1`,
    [String(guildId)]
  );
}

module.exports = {
  getApiProIdentifiers,
  hasActiveApiPro,
  getLinkedEmail,
  isUserPro,
  getGuildPlan,
  ensureGuild,
  markGuildLeft,
  countProGuildsForEmail,
  claimPro,
  releasePro,
};
