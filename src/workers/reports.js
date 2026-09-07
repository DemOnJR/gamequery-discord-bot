'use strict';

const store = require('../lib/store');
const reports = require('../lib/reports');

/*
  Sends the scheduled summaries that are due.

  The "is it due" decision lives in SQL (store.dueReports) rather than here, so
  the same comparison against last_sent_at both selects the report and prevents
  a second copy: a restart mid-hour, an overlapping tick or two workers cannot
  produce a duplicate digest.
*/
async function tick(client) {
  const due = await store.dueReports();

  if (due.length === 0) {
    return { sent: 0 };
  }

  let sent = 0;

  for (const row of due) {
    const guild = client.guilds.cache.get(row.guild_id)
      || await client.guilds.fetch(row.guild_id).catch(() => null);

    if (!guild) {
      continue;
    }

    const channel = guild.channels.cache.get(row.channel_id)
      || await guild.channels.fetch(row.channel_id).catch(() => null);

    if (!channel || typeof channel.send !== 'function') {
      // The channel is gone or unreadable. Stamping it as sent stops the bot
      // retrying the same impossible send every minute for the rest of the hour.
      await store.markReportSent(row.id);
      console.log(`[reports] report ${row.id}: channel ${row.channel_id} unusable, skipped`);
      continue;
    }

    try {
      const built = await reports.build(guild, row.cadence);

      if (!built) {
        await store.markReportSent(row.id);
        continue;
      }

      await channel.send({
        content: row.mention_role_id ? `<@&${row.mention_role_id}>` : undefined,
        embeds: [built.embed],
        files: built.files,
        allowedMentions: row.mention_role_id ? { roles: [row.mention_role_id] } : { parse: [] },
      });

      await store.markReportSent(row.id);
      sent += 1;
    } catch (error) {
      console.error(`[reports] report ${row.id} failed: ${error.message}`);
      // Deliberately NOT stamped: a transient failure should retry inside the
      // same hour rather than silently skipping the day.
    }
  }

  return { sent };
}

module.exports = { tick };
