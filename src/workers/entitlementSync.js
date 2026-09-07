'use strict';

const db = require('../lib/db');
const entitlement = require('../lib/entitlement');
const config = require('../config');

/*
  Re-checks every guild that claims Pro against the billing tables.

  Without this, PRO would be granted at /pro claim and never taken away: a
  customer who cancels would keep 25 tracked servers and 2-minute refreshes
  forever. The website's Stripe webhook keeps billing_subscriptions honest;
  this loop is what turns that into the bot's behaviour.

  It also enforces the per-subscription guild cap after the fact. Claims are
  checked at claim time, but a subscription can be applied to a guild, the bot
  removed, re-added, and claimed again; counting here keeps the total right.
*/
async function tick() {
  const guilds = await db.rows(
    `SELECT guild_id, pro_email, pro_discord_user_id, pro_claimed_at
     FROM discord_guilds
     WHERE pro_active = TRUE AND left_at IS NULL
     ORDER BY pro_claimed_at`
  );

  if (guilds.length === 0) {
    return { checked: 0, revoked: 0 };
  }

  const byEmail = new Map();
  let revoked = 0;

  for (const guild of guilds) {
    const email = String(guild.pro_email || '').toLowerCase();

    if (!email) {
      await entitlement.releasePro(guild.guild_id);
      revoked += 1;
      continue;
    }

    if (!byEmail.has(email)) {
      byEmail.set(email, { active: await entitlement.hasActiveApiPro(email), used: 0 });
    }

    const state = byEmail.get(email);

    if (!state.active) {
      await entitlement.releasePro(guild.guild_id);
      revoked += 1;
      console.log(`[entitlement] released Pro for guild ${guild.guild_id}: no active subscription`);
      continue;
    }

    state.used += 1;

    // Guilds are ordered by claim time, so the oldest claims keep their slots
    // and only the excess is released.
    if (state.used > config.proGuildLimit) {
      await entitlement.releasePro(guild.guild_id);
      revoked += 1;
      console.log(`[entitlement] released Pro for guild ${guild.guild_id}: over the ${config.proGuildLimit}-guild cap`);
      continue;
    }

    await db.query(
      'UPDATE discord_guilds SET pro_checked_at = NOW() WHERE guild_id = $1',
      [guild.guild_id]
    );
  }

  return { checked: guilds.length, revoked };
}

module.exports = { tick };
