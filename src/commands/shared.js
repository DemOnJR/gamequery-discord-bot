'use strict';

const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const entitlement = require('../lib/entitlement');
const store = require('../lib/store');
const games = require('../lib/games');
const embeds = require('../lib/embeds');
const config = require('../config');

const EPHEMERAL = MessageFlags.Ephemeral;

function isManager(interaction) {
  return Boolean(
    interaction.memberPermissions
    && interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)
  );
}

async function requireManager(interaction) {
  if (isManager(interaction)) {
    return true;
  }

  await interaction.reply({
    content: 'That command needs the **Manage Server** permission.',
    flags: EPHEMERAL,
  });

  return false;
}

async function requireGuild(interaction) {
  if (interaction.inGuild()) {
    return true;
  }

  await interaction.reply({
    content: 'Run this in a server, not in a DM.',
    flags: EPHEMERAL,
  });

  return false;
}

async function getPlan(interaction) {
  await entitlement.ensureGuild(interaction.guild);
  return entitlement.getGuildPlan(interaction.guildId);
}

async function denyWithUpsell(interaction, reason, plan) {
  const payload = { embeds: [embeds.upsellEmbed(reason, plan)] };

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
  } else {
    await interaction.reply({ ...payload, flags: EPHEMERAL });
  }
}

/*
  Autocomplete over the game catalogue. Discord gives 3 seconds and accepts at
  most 25 choices, so this stays a pure in-memory search.
*/
async function gameAutocomplete(interaction) {
  const focused = interaction.options.getFocused();
  const matches = games.search(focused, 25);

  await interaction.respond(
    matches.map((game) => ({
      name: `${game.name} (${game.id})`.slice(0, 100),
      value: game.id,
    }))
  );
}

/*
  Autocomplete over the servers this guild already tracks, so nobody has to
  retype an ip:port they already gave the bot once.
*/
async function trackedAutocomplete(interaction) {
  if (!interaction.inGuild()) {
    await interaction.respond([]);
    return;
  }

  const focused = String(interaction.options.getFocused() || '').toLowerCase();
  const tracked = await store.listTracked(interaction.guildId);

  const matches = tracked
    .filter((row) => {
      if (!focused) {
        return true;
      }
      return row.address.includes(focused)
        || String(row.label || '').toLowerCase().includes(focused)
        || row.game.toLowerCase().includes(focused);
    })
    .slice(0, 25);

  await interaction.respond(
    matches.map((row) => ({
      name: `${row.label || row.address} - ${games.gameName(row.game)}`.slice(0, 100),
      value: String(row.id),
    }))
  );
}

async function resolveTracked(interaction, value) {
  const tracked = await store.getTracked(interaction.guildId, value);
  return tracked;
}

function planFooter(plan) {
  return plan.isPro
    ? 'Pro'
    : `Free plan - ${config.proUpgradeUrl || `${config.siteUrl}/dashboard/billing`}`;
}

module.exports = {
  EPHEMERAL,
  isManager,
  requireManager,
  requireGuild,
  getPlan,
  denyWithUpsell,
  gameAutocomplete,
  trackedAutocomplete,
  resolveTracked,
  planFooter,
};
