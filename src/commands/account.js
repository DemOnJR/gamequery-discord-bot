'use strict';

const crypto = require('crypto');
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const shared = require('./shared');
const db = require('../lib/db');
const entitlement = require('../lib/entitlement');
const embeds = require('../lib/embeds');
const config = require('../config');

// Ambiguous glyphs removed: this code gets read off a phone screen and typed
// into a browser, so 0/O and 1/I would cost support time for no benefit.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode() {
  const bytes = crypto.randomBytes(8);
  let code = '';

  for (let i = 0; i < 8; i += 1) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }

  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

const linkData = new SlashCommandBuilder()
  .setName('link')
  .setDescription('Connect your gamequery.dev account so this Discord can use your Pro plan');

const proData = new SlashCommandBuilder()
  .setName('pro')
  .setDescription('Check or apply your Pro plan in this Discord')
  .addSubcommand((sub) => sub
    .setName('status')
    .setDescription('Show which plan this Discord is on'))
  .addSubcommand((sub) => sub
    .setName('claim')
    .setDescription('Apply your Pro subscription to this Discord'))
  .addSubcommand((sub) => sub
    .setName('release')
    .setDescription('Take your Pro subscription off this Discord so you can use it elsewhere'));

function selfHostedNotice() {
  return new EmbedBuilder()
    .setColor(embeds.COLORS.online)
    .setTitle('This bot is self-hosted')
    .setDescription(
      'Every feature is already unlocked. Linking an account is only needed on the bot hosted at '
      + `${config.siteUrl}, where it applies an API PRO subscription to a Discord server.`
    )
    .addFields({
      name: 'What this copy still needs',
      value: 'A gamequery.dev API key, which is what supplies the server data. '
        + `Manage it at ${config.siteUrl}/dashboard/keys.`,
    });
}

async function executeLink(interaction) {
  await interaction.deferReply({ flags: shared.EPHEMERAL });

  if (config.planMode !== 'hosted') {
    await interaction.editReply({ embeds: [selfHostedNotice()] });
    return;
  }

  const existing = await entitlement.getLinkedEmail(interaction.user.id);

  if (existing) {
    const pro = await entitlement.hasActiveApiPro(existing);
    const embed = new EmbedBuilder()
      .setColor(pro ? embeds.COLORS.online : embeds.COLORS.neutral)
      .setTitle('Account already linked')
      .setDescription(`This Discord account is linked to **${maskEmail(existing)}**.`)
      .addFields({
        name: 'Subscription',
        value: pro
          ? 'API PRO is active. Run `/pro claim` in any server you manage to switch it to Pro.'
          : `No active API PRO subscription on that account. Start the 7-day free trial at ${config.proUpgradeUrl || `${config.siteUrl}/dashboard/billing`}.`,
      });

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const code = makeCode();
  const ttl = config.retention.linkCodeMinutes;

  await db.query(
    `INSERT INTO discord_link_codes (code, discord_user_id, discord_username, guild_id, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5 || ' minutes')::interval)`,
    [
      code,
      String(interaction.user.id),
      String(interaction.user.username || '').slice(0, 64),
      interaction.guildId ? String(interaction.guildId) : null,
      String(ttl),
    ]
  );

  const linkUrl = `${config.siteUrl}/discord/link?code=${encodeURIComponent(code)}`;

  const embed = new EmbedBuilder()
    .setColor(embeds.COLORS.neutral)
    .setTitle('Link your gamequery.dev account')
    .setDescription(
      `Open **${linkUrl}** while signed in, and confirm.\n\n`
      + `Your code is **${code}**. It expires in ${ttl} minutes and can be used once.`
    )
    .addFields({
      name: 'Why',
      value: 'Linking is how the bot knows your Pro subscription is yours. It reads nothing from your Discord account beyond your user id.',
    })
    .setFooter({ text: 'Only you can see this message.' });

  await interaction.editReply({ embeds: [embed] });
}

function maskEmail(email) {
  const value = String(email || '');
  const at = value.indexOf('@');

  if (at <= 1) {
    return value;
  }

  return `${value.slice(0, 2)}${'*'.repeat(Math.max(1, at - 2))}${value.slice(at)}`;
}

async function executePro(interaction) {
  if (!(await shared.requireGuild(interaction))) {
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'status') {
    await handleProStatus(interaction);
    return;
  }

  if (!(await shared.requireManager(interaction))) {
    return;
  }

  if (sub === 'claim') {
    await handleProClaim(interaction);
  } else if (sub === 'release') {
    await handleProRelease(interaction);
  }
}

async function handleProStatus(interaction) {
  await interaction.deferReply({ flags: shared.EPHEMERAL });

  if (config.planMode !== 'hosted') {
    await interaction.editReply({ embeds: [selfHostedNotice()] });
    return;
  }

  const plan = await shared.getPlan(interaction);
  const free = config.plans.FREE;
  const pro = config.plans.PRO;

  const embed = new EmbedBuilder()
    .setColor(plan.isPro ? embeds.COLORS.online : embeds.COLORS.flat)
    .setTitle(plan.isPro ? 'This Discord is on Pro' : 'This Discord is on Free')
    .addFields(
      {
        name: 'Tracked servers',
        value: plan.isPro ? `${pro.trackedServers}` : `${free.trackedServers} (Pro: ${pro.trackedServers})`,
        inline: true,
      },
      {
        name: 'Refresh',
        value: plan.isPro ? `${pro.refreshMinutes} min` : `${free.refreshMinutes} min (Pro: ${pro.refreshMinutes})`,
        inline: true,
      },
      {
        name: 'Counter channels',
        value: plan.isPro ? `${pro.counterChannels}` : `${free.counterChannels} (Pro: ${pro.counterChannels})`,
        inline: true,
      },
      {
        name: 'Graph ranges',
        value: plan.limits.graphRanges.join(', ') + (plan.isPro ? '' : ` (Pro: ${pro.graphRanges.join(', ')})`),
        inline: true,
      },
      {
        name: 'Alerts',
        value: plan.isPro ? `${pro.alerts}` : `off (Pro: ${pro.alerts})`,
        inline: true,
      },
      {
        name: 'Player lists & CSV',
        value: plan.isPro ? 'included' : 'Pro only',
        inline: true,
      }
    );

  if (plan.isPro && plan.proEmail) {
    embed.setDescription(`Pro applied by <@${plan.proDiscordUserId}> using **${maskEmail(plan.proEmail)}**.`);
  } else {
    embed.setDescription(
      `Start the **7-day free trial** at ${config.proUpgradeUrl || `${config.siteUrl}/dashboard/billing`}, `
      + 'run `/link` once, then `/pro claim` here.'
    );
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleProClaim(interaction) {
  await interaction.deferReply({ flags: shared.EPHEMERAL });

  if (config.planMode !== 'hosted') {
    await interaction.editReply({ embeds: [selfHostedNotice()] });
    return;
  }

  await entitlement.ensureGuild(interaction.guild);

  const status = await entitlement.isUserPro(interaction.user.id);

  if (!status.linked) {
    await interaction.editReply(
      'Link your gamequery.dev account first with `/link`, then run this again.'
    );
    return;
  }

  if (!status.pro) {
    await interaction.editReply(
      `**${maskEmail(status.email)}** has no active API PRO subscription. `
      + `Start the 7-day free trial at ${config.proUpgradeUrl || `${config.siteUrl}/dashboard/billing`} and run this again.`
    );
    return;
  }

  const used = await entitlement.countProGuildsForEmail(status.email, interaction.guildId);

  if (used >= config.proGuildLimit) {
    await interaction.editReply(
      `Your subscription is already applied to ${used} Discord servers, which is the limit of ${config.proGuildLimit}. `
      + 'Run `/pro release` in one of them to free a slot.'
    );
    return;
  }

  await entitlement.claimPro(interaction.guildId, interaction.user.id, status.email);

  await interaction.editReply(
    `**${interaction.guild.name}** is now on Pro. Counters and live messages refresh every `
    + `${config.plans.PRO.refreshMinutes} minutes, and every Pro command is unlocked here. `
    + `Using ${used + 1} of your ${config.proGuildLimit} Discord slots.`
  );
}

async function handleProRelease(interaction) {
  await interaction.deferReply({ flags: shared.EPHEMERAL });

  if (config.planMode !== 'hosted') {
    await interaction.editReply({ embeds: [selfHostedNotice()] });
    return;
  }

  const plan = await shared.getPlan(interaction);

  if (!plan.isPro) {
    await interaction.editReply('This Discord is not on Pro.');
    return;
  }

  const isClaimer = plan.proDiscordUserId === interaction.user.id;
  const status = await entitlement.isUserPro(interaction.user.id);
  const sameAccount = status.email && plan.proEmail
    && status.email.toLowerCase() === String(plan.proEmail).toLowerCase();

  if (!isClaimer && !sameAccount) {
    await interaction.editReply(
      'Only the person whose subscription is applied here can release it. '
      + 'Ask them to run `/pro release`, or contact support if they have left.'
    );
    return;
  }

  await entitlement.releasePro(interaction.guildId);

  await interaction.editReply(
    'Pro released. This Discord is back on Free, and your subscription slot is available for another server. '
    + 'Nothing was deleted; anything over the Free limits simply stops refreshing.'
  );
}

module.exports = {
  link: { data: linkData, execute: executeLink },
  pro: { data: proData, execute: executePro },
};
