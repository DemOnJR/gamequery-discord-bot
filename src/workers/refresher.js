'use strict';

const store = require('../lib/store');
const servers = require('../lib/servers');
const templates = require('../lib/templates');
const embeds = require('../lib/embeds');
const entitlement = require('../lib/entitlement');
const live = require('../commands/live');
const config = require('../config');

/*
  Renames counter channels and rewrites live messages.

  Two Discord limits shape this loop:

    - A channel rename is limited to twice per ten minutes PER CHANNEL, and the
      limit is not returned as a normal 429 you can retry: the request simply
      hangs in a queue. So a rename is only spent when the rendered name is
      actually different from the last one written.
    - Editing a message has no such limit, but a message that has been deleted
      returns 10008 forever. Rows are dropped after a few consecutive failures
      rather than retried until the end of time.
*/

const DROP_AFTER_FAILURES = 5;

function dueForRefresh(lastUpdatedAt, refreshMinutes) {
  if (!lastUpdatedAt) {
    return true;
  }

  const ageMs = Date.now() - new Date(lastUpdatedAt).getTime();
  return ageMs >= refreshMinutes * 60 * 1000;
}

async function refreshGuild(client, guildRow) {
  const guildId = guildRow.guild_id;
  const plan = await entitlement.getGuildPlan(guildId);

  const guild = client.guilds.cache.get(guildId)
    || await client.guilds.fetch(guildId).catch(() => null);

  if (!guild) {
    // The bot is no longer in this guild; stop doing work for it.
    await entitlement.markGuildLeft(guildId);
    return;
  }

  const tracked = await store.listTracked(guildId);
  const snapshots = await servers.getSnapshots(tracked.map((row) => ({ game: row.game, address: row.address })));

  await refreshCounters(guild, plan, tracked, snapshots);
  await refreshMessages(guild, plan, tracked, snapshots);
}

async function refreshCounters(guild, plan, tracked, snapshots) {
  const counters = await store.listCounters(guild.id);
  const trackedById = new Map(tracked.map((row) => [Number(row.id), row]));

  /*
    Over-limit rows are skipped rather than deleted when a guild drops to Free.
    Deleting would destroy configuration the moment a card expires; skipping
    means resubscribing brings everything back exactly as it was.
  */
  const allowed = counters.slice(0, plan.limits.counterChannels);

  for (const row of allowed) {
    if (!dueForRefresh(row.last_updated_at, plan.limits.refreshMinutes)) {
      continue;
    }

    const target = row.tracked_server_id ? trackedById.get(Number(row.tracked_server_id)) : null;

    if (row.tracked_server_id && !target) {
      await store.dropCounter(row.id);
      continue;
    }

    const name = row.tracked_server_id
      ? templates.renderServerTemplate(row.name_template, snapshots.get(target.address), target)
      : templates.renderTotalTemplate(row.name_template, snapshots, tracked);

    if (name === row.last_rendered_name) {
      // Nothing changed, so no rename is spent. Still stamp the row so the
      // next tick does not recompute it immediately.
      await store.touchCounter(row.id, name);
      continue;
    }

    const channel = guild.channels.cache.get(row.channel_id)
      || await guild.channels.fetch(row.channel_id).catch(() => null);

    if (!channel) {
      const streak = await store.failCounter(row.id);
      if (streak >= DROP_AFTER_FAILURES) {
        await store.dropCounter(row.id);
        console.log(`[refresher] dropped counter ${row.id}: channel ${row.channel_id} gone`);
      }
      continue;
    }

    try {
      await channel.setName(name, 'GameQuery live player count');
      await store.touchCounter(row.id, name);

      if (config.debug) {
        console.log(`[refresher] renamed ${row.channel_id} to "${name}"`);
      }
    } catch (error) {
      const streak = await store.failCounter(row.id);
      console.error(`[refresher] rename failed for ${row.channel_id} (${streak}): ${error.message}`);

      if (streak >= DROP_AFTER_FAILURES) {
        await store.dropCounter(row.id);
      }
    }
  }
}

async function refreshMessages(guild, plan, tracked, snapshots) {
  const messages = await store.listStatusMessages(guild.id);
  const trackedById = new Map(tracked.map((row) => [Number(row.id), row]));
  const allowed = messages.slice(0, plan.limits.statusMessages);

  for (const row of allowed) {
    if (!dueForRefresh(row.last_updated_at, plan.limits.refreshMinutes)) {
      continue;
    }

    const channel = guild.channels.cache.get(row.channel_id)
      || await guild.channels.fetch(row.channel_id).catch(() => null);

    if (!channel || typeof channel.messages?.fetch !== 'function') {
      const streak = await store.failStatusMessage(row.id);
      if (streak >= DROP_AFTER_FAILURES) {
        await store.dropStatusMessage(row.id);
      }
      continue;
    }

    const message = await channel.messages.fetch(row.message_id).catch(() => null);

    if (!message) {
      const streak = await store.failStatusMessage(row.id);
      if (streak >= DROP_AFTER_FAILURES) {
        await store.dropStatusMessage(row.id);
        console.log(`[refresher] dropped live message ${row.id}: message gone`);
      }
      continue;
    }

    let payload;

    /*
      Building the payload can throw (a graph render, a missing tracked row),
      and until this try existed a single bad message aborted every remaining
      counter and message for that guild on that tick.
    */
    try {
    if (row.mode === 'list' || !row.tracked_server_id) {
      payload = { embeds: [embeds.serverListEmbed(tracked, snapshots, { title: `${guild.name} servers` })] };
    } else {
      const target = trackedById.get(Number(row.tracked_server_id));

      if (!target) {
        await store.dropStatusMessage(row.id);
        continue;
      }

      const snapshot = snapshots.get(target.address);

      if (row.mode === 'graph') {
        if (!target.server_id) {
          await store.dropStatusMessage(row.id);
          continue;
        }

        /*
          A graph range the guild no longer has (Pro lapsed on a 30d message)
          falls back to the widest range the current plan does allow, rather
          than either failing forever or silently keeping a Pro feature.
        */
        const requested = row.graph_range || '24h';
        const allowed = plan.limits.graphRanges.includes(requested)
          ? requested
          : plan.limits.graphRanges[plan.limits.graphRanges.length - 1];

        payload = await live.buildGraphMessage(target, snapshot, allowed, plan);
      } else {
        const embed = embeds.serverEmbed(snapshot, { game: target.game });
        embed.setFooter({ text: `Updates every ${plan.limits.refreshMinutes} min - gamequery.dev` });
        payload = { embeds: [embed] };
      }
    }

      await message.edit(payload);
      await store.touchStatusMessage(row.id);
    } catch (error) {
      const streak = await store.failStatusMessage(row.id);
      console.error(`[refresher] live message ${row.message_id} failed (${streak}): ${error.message}`);

      if (streak >= DROP_AFTER_FAILURES) {
        await store.dropStatusMessage(row.id);
      }
    }
  }
}

async function tick(client) {
  const guilds = await store.guildsWithWork();

  for (const guildRow of guilds) {
    try {
      await refreshGuild(client, guildRow);
    } catch (error) {
      console.error(`[refresher] guild ${guildRow.guild_id} failed: ${error.message}`);
    }
  }

  return { guilds: guilds.length };
}

module.exports = { tick, dueForRefresh };
