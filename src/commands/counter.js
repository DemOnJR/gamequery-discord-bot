'use strict';

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const shared = require('./shared');
const store = require('../lib/store');
const servers = require('../lib/servers');
const templates = require('../lib/templates');
const embeds = require('../lib/embeds');

const KIND_CHOICES = [
  { name: 'Voice channel (shows in the sidebar, nobody can join)', value: 'voice' },
  { name: 'Category header', value: 'category' },
  { name: 'Text channel', value: 'text' },
];

const CHANNEL_TYPE = {
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
  text: ChannelType.GuildText,
};

const data = new SlashCommandBuilder()
  .setName('counter')
  .setDescription('Channels whose name is the live player count')
  .addSubcommand((sub) => sub
    .setName('create')
    .setDescription('Create a channel that shows the player count in its name')
    .addStringOption((option) => option
      .setName('server')
      .setDescription('Tracked server, or leave empty to total every tracked server')
      .setAutocomplete(true))
    .addStringOption((option) => option
      .setName('kind')
      .setDescription('What kind of channel to create')
      .addChoices(...KIND_CHOICES))
    .addStringOption((option) => option
      .setName('template')
      .setDescription('Name template, e.g. "{dot} {players}/{maxplayers} online" (Pro)')
      .setMaxLength(90)))
  .addSubcommand((sub) => sub
    .setName('attach')
    .setDescription('Turn an existing channel into a counter')
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('Channel to rename on every refresh')
      .setRequired(true))
    .addStringOption((option) => option
      .setName('server')
      .setDescription('Tracked server, or leave empty to total every tracked server')
      .setAutocomplete(true))
    .addStringOption((option) => option
      .setName('template')
      .setDescription('Name template (Pro)')
      .setMaxLength(90)))
  .addSubcommand((sub) => sub
    .setName('remove')
    .setDescription('Stop updating a counter channel')
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('Counter channel')
      .setRequired(true))
    .addBooleanOption((option) => option
      .setName('delete_channel')
      .setDescription('Also delete the channel itself')))
  .addSubcommand((sub) => sub
    .setName('list')
    .setDescription('Show every counter channel in this Discord'))
  .addSubcommand((sub) => sub
    .setName('tokens')
    .setDescription('List the placeholders a name template can use'));

async function autocomplete(interaction) {
  await shared.trackedAutocomplete(interaction);
}

async function execute(interaction) {
  if (!(await shared.requireGuild(interaction))) {
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'tokens') {
    await handleTokens(interaction);
    return;
  }

  if (sub === 'list') {
    await handleList(interaction);
    return;
  }

  if (!(await shared.requireManager(interaction))) {
    return;
  }

  if (sub === 'create') {
    await handleCreate(interaction);
  } else if (sub === 'attach') {
    await handleAttach(interaction);
  } else if (sub === 'remove') {
    await handleRemove(interaction);
  }
}

async function resolveTarget(interaction) {
  const value = interaction.options.getString('server');

  if (!value) {
    return { tracked: null, aggregate: true };
  }

  const tracked = await shared.resolveTracked(interaction, value);

  if (!tracked) {
    return { tracked: null, aggregate: false, error: 'No tracked server matched that. Add one with `/track add` first.' };
  }

  return { tracked, aggregate: false };
}

async function resolveTemplate(interaction, plan, aggregate) {
  const raw = interaction.options.getString('template');

  if (!raw) {
    return {
      ok: true,
      template: aggregate ? templates.DEFAULT_TOTAL_TEMPLATE : templates.DEFAULT_SERVER_TEMPLATE,
    };
  }

  if (!plan.limits.customTemplates) {
    return {
      ok: false,
      upsell: 'Custom channel-name templates are a Pro feature. The Free plan uses the built-in name, which already shows the live count.',
    };
  }

  const validation = templates.validateTemplate(raw);

  if (!validation.ok) {
    return { ok: false, reason: validation.reason };
  }

  return { ok: true, template: validation.template };
}

function canManageChannels(interaction) {
  const me = interaction.guild.members.me;
  return Boolean(me && me.permissions.has(PermissionFlagsBits.ManageChannels));
}

async function handleCreate(interaction) {
  await interaction.deferReply({ flags: shared.EPHEMERAL });

  const plan = await shared.getPlan(interaction);

  if (!canManageChannels(interaction)) {
    await interaction.editReply(
      'I need the **Manage Channels** permission to create and rename a counter channel. Grant it and run this again.'
    );
    return;
  }

  const current = await store.countCounters(interaction.guildId);

  if (current >= plan.limits.counterChannels) {
    await shared.denyWithUpsell(
      interaction,
      `This Discord already has ${current} of the ${plan.limits.counterChannels} counter channels allowed on the ${plan.limits.name} plan.`,
      plan
    );
    return;
  }

  const target = await resolveTarget(interaction);

  if (target.error) {
    await interaction.editReply(target.error);
    return;
  }

  const templateResult = await resolveTemplate(interaction, plan, target.aggregate);

  if (!templateResult.ok) {
    if (templateResult.upsell) {
      await shared.denyWithUpsell(interaction, templateResult.upsell, plan);
    } else {
      await interaction.editReply(templateResult.reason);
    }
    return;
  }

  const kind = interaction.options.getString('kind') || 'voice';
  const tracked = await store.listTracked(interaction.guildId);
  const snapshots = await servers.getSnapshots(tracked.map((row) => ({ game: row.game, address: row.address })));

  const name = target.aggregate
    ? templates.renderTotalTemplate(templateResult.template, snapshots, tracked)
    : templates.renderServerTemplate(templateResult.template, snapshots.get(target.tracked.address), target.tracked);

  let channel;

  try {
    channel = await interaction.guild.channels.create({
      name,
      type: CHANNEL_TYPE[kind] || ChannelType.GuildVoice,
      reason: `GameQuery counter created by ${interaction.user.tag}`,
      // A voice counter is a label, not a room: denying Connect stops members
      // joining an empty channel that exists only to display a number.
      permissionOverwrites: kind === 'voice'
        ? [{ id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.Connect] }]
        : undefined,
    });
  } catch (error) {
    await interaction.editReply(`Discord refused to create the channel: ${error.message}`);
    return;
  }

  const counter = await store.addCounter({
    guildId: interaction.guildId,
    channelId: channel.id,
    channelKind: kind,
    trackedServerId: target.tracked ? target.tracked.id : null,
    template: templateResult.template,
  });

  // The name was already rendered for the create call, so record it as the
  // last rendered value; otherwise the first refresh spends a rename writing
  // the identical string.
  if (counter) {
    await store.touchCounter(counter.id, name);
  }

  await interaction.editReply(
    `Created ${channel} showing **${name}**.\n`
    + `It refreshes every **${plan.limits.refreshMinutes} min** on the ${plan.limits.name} plan`
    + `${plan.isPro ? '.' : ', and every 2 min on Pro.'}\n`
    + `Drag it to the top of your channel list so members see it first.`
  );
}

async function handleAttach(interaction) {
  await interaction.deferReply({ flags: shared.EPHEMERAL });

  const plan = await shared.getPlan(interaction);
  const channel = interaction.options.getChannel('channel', true);

  if (!canManageChannels(interaction)) {
    await interaction.editReply('I need the **Manage Channels** permission to rename that channel.');
    return;
  }

  const existing = (await store.listCounters(interaction.guildId))
    .find((row) => row.channel_id === channel.id);
  const current = await store.countCounters(interaction.guildId);

  if (!existing && current >= plan.limits.counterChannels) {
    await shared.denyWithUpsell(
      interaction,
      `This Discord already has ${current} of the ${plan.limits.counterChannels} counter channels allowed on the ${plan.limits.name} plan.`,
      plan
    );
    return;
  }

  const target = await resolveTarget(interaction);

  if (target.error) {
    await interaction.editReply(target.error);
    return;
  }

  const templateResult = await resolveTemplate(interaction, plan, target.aggregate);

  if (!templateResult.ok) {
    if (templateResult.upsell) {
      await shared.denyWithUpsell(interaction, templateResult.upsell, plan);
    } else {
      await interaction.editReply(templateResult.reason);
    }
    return;
  }

  const kind = channel.type === ChannelType.GuildCategory
    ? 'category'
    : (channel.type === ChannelType.GuildText ? 'text' : 'voice');

  await store.addCounter({
    guildId: interaction.guildId,
    channelId: channel.id,
    channelKind: kind,
    trackedServerId: target.tracked ? target.tracked.id : null,
    template: templateResult.template,
  });

  await interaction.editReply(
    `${channel} is now a counter. Its name is overwritten on every refresh, so pick a channel you do not mind renaming.`
  );
}

async function handleRemove(interaction) {
  const channel = interaction.options.getChannel('channel', true);
  const alsoDelete = interaction.options.getBoolean('delete_channel') === true;

  const removed = await store.removeCounter(interaction.guildId, channel.id);

  if (!removed) {
    await interaction.reply({ content: 'That channel is not a counter.', flags: shared.EPHEMERAL });
    return;
  }

  let deleteNote = '';

  if (alsoDelete) {
    try {
      await channel.delete(`GameQuery counter removed by ${interaction.user.tag}`);
      deleteNote = ' The channel was deleted.';
    } catch (error) {
      deleteNote = ` I could not delete the channel: ${error.message}`;
    }
  }

  await interaction.reply({
    content: `Stopped updating that counter.${deleteNote}`,
    flags: shared.EPHEMERAL,
  });
}

async function handleList(interaction) {
  await interaction.deferReply({ flags: shared.EPHEMERAL });

  const plan = await shared.getPlan(interaction);
  const counters = await store.listCounters(interaction.guildId);

  if (counters.length === 0) {
    await interaction.editReply('No counter channels yet. Create one with `/counter create`.');
    return;
  }

  const lines = counters.map((row) => {
    const scope = row.tracked_server_id ? (row.label || row.address) : 'all tracked servers';
    const last = row.last_updated_at
      ? embeds.relativeTime(new Date(row.last_updated_at))
      : 'not yet';
    return `<#${row.channel_id}> · ${scope}\n \`${row.name_template}\` · updated ${last}`;
  });

  const embed = new EmbedBuilder()
    .setColor(embeds.COLORS.neutral)
    .setTitle('Counter channels')
    .setDescription(lines.join('\n\n').slice(0, 4000))
    .setFooter({ text: `${counters.length}/${plan.limits.counterChannels} used - ${plan.limits.name}` });

  await interaction.editReply({ embeds: [embed] });
}

async function handleTokens(interaction) {
  const embed = new EmbedBuilder()
    .setColor(embeds.COLORS.neutral)
    .setTitle('Channel name placeholders')
    .setDescription(templates.tokenHelp())
    .addFields(
      { name: 'Default, one server', value: `\`${templates.DEFAULT_SERVER_TEMPLATE}\`` },
      { name: 'Default, all servers', value: `\`${templates.DEFAULT_TOTAL_TEMPLATE}\`` },
      {
        name: 'Note',
        value: 'Discord rate-limits channel renames to twice per ten minutes, so a counter only renames when the rendered name actually changes.',
      }
    );

  await interaction.reply({ embeds: [embed], flags: shared.EPHEMERAL });
}

module.exports = { data, execute, autocomplete };
