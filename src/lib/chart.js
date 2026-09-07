'use strict';

const fs = require('fs');
const path = require('path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const config = require('../config');

/*
  The site's tokens, copied rather than imported: a graph posted in Discord sits
  next to the dashboard in a customer's head, and the two should not drift.
  Square geometry, flat near-black ramp, one accent, three status colours.
*/
const T = {
  page: '#08090b',
  panel: '#0e1013',
  raised: '#16191d',
  line: '#1f2328',
  lineStrong: '#2c3138',
  ink: '#f2f4f7',
  inkMuted: '#98a1ae',
  inkFaint: '#6a7381',
  accent: '#3b82f6',
  accentStrong: '#2563eb',
  success: '#22c55e',
  warn: '#f59e0b',
  danger: '#ef4444',
};

// Comparison series colours. The accent leads; the rest are distinct in both
// hue and lightness so the chart still reads if someone screenshots it in
// greyscale.
const SERIES_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ef4444'];

const FONT = 'GQSans';
const FONT_BOLD = 'GQSansBold';
let fontsReady = false;

function registerFonts() {
  if (fontsReady) {
    return true;
  }

  const candidates = [
    [path.join(config.fontDir, 'DejaVuSans.ttf'), FONT],
    [path.join(config.fontDir, 'DejaVuSans-Bold.ttf'), FONT_BOLD],
  ];

  let registered = 0;
  candidates.forEach(([file, family]) => {
    try {
      if (fs.existsSync(file) && GlobalFonts.registerFromPath(file, family)) {
        registered += 1;
      }
    } catch (error) {
      console.error(`[chart] font registration failed for ${file}:`, error.message);
    }
  });

  if (registered === 0) {
    console.error(`[chart] no fonts found under ${config.fontDir}; charts will render without labels`);
  }

  fontsReady = registered > 0;
  return fontsReady;
}

function font(size, bold = false) {
  return `${bold ? '600 ' : ''}${size}px ${bold ? FONT_BOLD : FONT}, sans-serif`;
}

/*
  Rounds the axis maximum up to a readable number that also divides evenly by
  the number of gridlines, so the labels come out as 0/10/20/30 rather than
  0/6/13/19/25.
*/
const NICE_STEPS = [1, 2, 2.5, 3, 4, 5, 6, 8, 10];

function niceCeiling(value, ticks = 5) {
  const target = Math.max(1, value);

  // Round the gap BETWEEN gridlines rather than the axis maximum. Rounding the
  // maximum leaves it hunting for a number that is both nice and divisible by
  // the tick count, which for 24 over 4 ticks jumps all the way to 100.
  const rawStep = target / ticks;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));

  for (const step of NICE_STEPS) {
    const candidate = step * magnitude;

    if (candidate >= rawStep) {
      return candidate * ticks;
    }
  }

  return Math.ceil(rawStep) * ticks;
}

function formatClock(date, rangeKey) {
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');

  if (rangeKey === '24h') {
    return `${hh}:00`;
  }

  if (rangeKey === '7d') {
    return `${dd}/${mm} ${hh}h`;
  }

  return `${dd}/${mm}`;
}

function truncate(ctx, text, maxWidth) {
  const value = String(text || '');

  if (ctx.measureText(value).width <= maxWidth) {
    return value;
  }

  let low = 0;
  let high = value.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(`${value.slice(0, mid)}...`).width <= maxWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return `${value.slice(0, low)}...`;
}

/*
  Splits a series into runs of consecutive readings so a gap (server
  unreachable, bot restarted) is drawn as a break in the line instead of a
  straight edge across the missing hours.
*/
function toSegments(points) {
  const segments = [];
  let current = [];

  points.forEach((point) => {
    if (point.players === null || point.players === undefined) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      return;
    }

    current.push(point);
  });

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

const WIDTH = 1000;
const HEIGHT = 460;
const PAD = { top: 82, right: 28, bottom: 58, left: 62 };

/*
  Renders one or more player-count series.

  series: [{ label, points: [{ at, players }], color? }]
  meta:   { title, subtitle, rangeKey, rangeLabel, footer, capacity }
*/
function renderPlayerChart(series, meta = {}) {
  registerFonts();

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  const plotX = PAD.left;
  const plotY = PAD.top;
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;

  ctx.fillStyle = T.page;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.fillStyle = T.panel;
  ctx.fillRect(plotX, plotY, plotW, plotH);

  // Header
  ctx.fillStyle = T.ink;
  ctx.font = font(20, true);
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(truncate(ctx, meta.title || 'Players', plotW - 200), PAD.left, 34);

  if (meta.subtitle) {
    ctx.fillStyle = T.inkMuted;
    ctx.font = font(13);
    ctx.fillText(truncate(ctx, meta.subtitle, plotW - 200), PAD.left, 55);
  }

  ctx.textAlign = 'right';
  ctx.fillStyle = T.inkFaint;
  ctx.font = font(12);
  ctx.fillText(meta.rangeLabel || '', WIDTH - PAD.right, 34);
  ctx.fillText('gamequery.dev', WIDTH - PAD.right, 55);
  ctx.textAlign = 'left';

  const usable = series
    .map((entry, index) => ({
      label: entry.label,
      color: entry.color || SERIES_COLORS[index % SERIES_COLORS.length],
      points: Array.isArray(entry.points) ? entry.points : [],
    }))
    .filter((entry) => entry.points.length > 0);

  const allValues = [];
  usable.forEach((entry) => {
    entry.points.forEach((point) => {
      if (point.players !== null && point.players !== undefined) {
        allValues.push(Number(point.players));
      }
    });
  });

  if (allValues.length === 0) {
    ctx.fillStyle = T.inkFaint;
    ctx.font = font(15);
    ctx.textAlign = 'center';
    ctx.fillText('No player history recorded for this range yet.', WIDTH / 2, plotY + plotH / 2 - 8);
    ctx.font = font(13);
    ctx.fillText('History starts building the moment a server is tracked.', WIDTH / 2, plotY + plotH / 2 + 16);
    ctx.textAlign = 'left';
    ctx.strokeStyle = T.line;
    ctx.lineWidth = 1;
    ctx.strokeRect(plotX + 0.5, plotY + 0.5, plotW - 1, plotH - 1);
    return canvas.toBuffer('image/png');
  }

  const dataMax = Math.max(...allValues);
  const capacity = Number.isFinite(Number(meta.capacity)) && Number(meta.capacity) > 0
    ? Number(meta.capacity)
    : null;
  const yTicks = 5;
  const yMax = Math.max(niceCeiling(Math.max(dataMax, capacity || 0), yTicks), 5);

  const times = [];
  usable.forEach((entry) => {
    entry.points.forEach((point) => times.push(point.at.getTime()));
  });

  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const tSpan = Math.max(1, tMax - tMin);

  const xAt = (time) => plotX + ((time - tMin) / tSpan) * plotW;
  const yAt = (value) => plotY + plotH - (Math.min(value, yMax) / yMax) * plotH;

  // Horizontal grid + y labels
  ctx.font = font(11);
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= yTicks; i += 1) {
    const value = (yMax / yTicks) * i;
    const y = yAt(value);

    ctx.strokeStyle = i === 0 ? T.lineStrong : T.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX, Math.round(y) + 0.5);
    ctx.lineTo(plotX + plotW, Math.round(y) + 0.5);
    ctx.stroke();

    ctx.fillStyle = T.inkFaint;
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.round(value)), plotX - 10, y);
  }

  // Capacity marker: the one place a second colour earns its place, because
  // "full" is a different fact from "how many".
  if (capacity && capacity <= yMax) {
    const y = yAt(capacity);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = T.warn;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX, Math.round(y) + 0.5);
    ctx.lineTo(plotX + plotW, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = T.warn;
    ctx.font = font(10);
    ctx.textAlign = 'left';
    ctx.fillText(`slots ${capacity}`, plotX + 6, y - 8);
  }

  // Vertical grid + x labels
  const xTicks = Math.min(8, Math.max(3, Math.floor(plotW / 120)));
  ctx.font = font(11);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  for (let i = 0; i <= xTicks; i += 1) {
    const time = tMin + (tSpan / xTicks) * i;
    const x = xAt(time);

    if (i > 0 && i < xTicks + 1) {
      ctx.strokeStyle = T.line;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, plotY);
      ctx.lineTo(Math.round(x) + 0.5, plotY + plotH);
      ctx.stroke();
    }

    ctx.fillStyle = T.inkFaint;
    ctx.fillText(formatClock(new Date(time), meta.rangeKey), x, plotY + plotH + 10);
  }

  // Series
  const singleSeries = usable.length === 1;

  usable.forEach((entry) => {
    const segments = toSegments(entry.points);

    if (singleSeries) {
      // A filled area reads as volume, which is what a player count is. With
      // several series stacked fills would lie, so only fill when there is one.
      segments.forEach((segment) => {
        if (segment.length < 2) {
          return;
        }

        const gradient = ctx.createLinearGradient(0, plotY, 0, plotY + plotH);
        gradient.addColorStop(0, 'rgba(59,130,246,0.28)');
        gradient.addColorStop(1, 'rgba(59,130,246,0.02)');

        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(xAt(segment[0].at.getTime()), plotY + plotH);
        segment.forEach((point) => ctx.lineTo(xAt(point.at.getTime()), yAt(point.players)));
        ctx.lineTo(xAt(segment[segment.length - 1].at.getTime()), plotY + plotH);
        ctx.closePath();
        ctx.fill();
      });
    }

    ctx.strokeStyle = entry.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    segments.forEach((segment) => {
      ctx.beginPath();
      segment.forEach((point, index) => {
        const x = xAt(point.at.getTime());
        const y = yAt(point.players);
        if (index === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });

      if (segment.length === 1) {
        ctx.arc(xAt(segment[0].at.getTime()), yAt(segment[0].players), 2, 0, Math.PI * 2);
        ctx.fillStyle = entry.color;
        ctx.fill();
      } else {
        ctx.stroke();
      }
    });

    // Mark the latest reading so the eye lands on "now".
    const last = entry.points.filter((point) => point.players !== null).pop();
    if (last) {
      const x = xAt(last.at.getTime());
      const y = yAt(last.players);

      ctx.fillStyle = T.page;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = entry.color;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  ctx.strokeStyle = T.lineStrong;
  ctx.lineWidth = 1;
  ctx.strokeRect(plotX + 0.5, plotY + 0.5, plotW - 1, plotH - 1);

  // Legend, only when there is something to tell apart.
  if (usable.length > 1) {
    let x = plotX;
    const y = HEIGHT - 22;
    ctx.font = font(12);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    usable.forEach((entry) => {
      ctx.fillStyle = entry.color;
      ctx.fillRect(x, y - 5, 10, 10);
      ctx.fillStyle = T.inkMuted;
      const label = truncate(ctx, entry.label, 190);
      ctx.fillText(label, x + 16, y);
      x += 16 + ctx.measureText(label).width + 22;
    });
  } else if (meta.footer) {
    ctx.font = font(12);
    ctx.fillStyle = T.inkMuted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncate(ctx, meta.footer, plotW), plotX, HEIGHT - 22);
  }

  return canvas.toBuffer('image/png');
}

/*
  Average players by hour of day: a bar chart, because the question is
  "which hour", a comparison between discrete buckets, not a trend over time.
*/
function renderHourProfile(profile, meta = {}) {
  registerFonts();

  const canvas = createCanvas(WIDTH, 380);
  const ctx = canvas.getContext('2d');
  const height = 380;

  const plotX = PAD.left;
  const plotY = 78;
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = height - plotY - 52;

  ctx.fillStyle = T.page;
  ctx.fillRect(0, 0, WIDTH, height);
  ctx.fillStyle = T.panel;
  ctx.fillRect(plotX, plotY, plotW, plotH);

  ctx.fillStyle = T.ink;
  ctx.font = font(20, true);
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(truncate(ctx, meta.title || 'Players by hour', plotW - 200), PAD.left, 34);

  if (meta.subtitle) {
    ctx.fillStyle = T.inkMuted;
    ctx.font = font(13);
    ctx.fillText(truncate(ctx, meta.subtitle, plotW - 200), PAD.left, 55);
  }

  ctx.textAlign = 'right';
  ctx.fillStyle = T.inkFaint;
  ctx.font = font(12);
  ctx.fillText(meta.rangeLabel || '', WIDTH - PAD.right, 34);
  ctx.fillText('gamequery.dev', WIDTH - PAD.right, 55);
  ctx.textAlign = 'left';

  const byHour = new Map(profile.map((entry) => [entry.hour, entry]));
  const values = profile.map((entry) => entry.avgPlayers);
  const dataMax = values.length > 0 ? Math.max(...values) : 0;

  if (dataMax <= 0) {
    ctx.fillStyle = T.inkFaint;
    ctx.font = font(15);
    ctx.textAlign = 'center';
    ctx.fillText('Not enough history yet to profile the day.', WIDTH / 2, plotY + plotH / 2);
    ctx.textAlign = 'left';
    ctx.strokeStyle = T.line;
    ctx.strokeRect(plotX + 0.5, plotY + 0.5, plotW - 1, plotH - 1);
    return canvas.toBuffer('image/png');
  }

  const yTicks = 4;
  const yMax = niceCeiling(dataMax, yTicks);
  const yAt = (value) => plotY + plotH - (value / yMax) * plotH;

  ctx.font = font(11);
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= yTicks; i += 1) {
    const value = (yMax / yTicks) * i;
    const y = yAt(value);
    ctx.strokeStyle = i === 0 ? T.lineStrong : T.line;
    ctx.beginPath();
    ctx.moveTo(plotX, Math.round(y) + 0.5);
    ctx.lineTo(plotX + plotW, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.fillStyle = T.inkFaint;
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.round(value)), plotX - 10, y);
  }

  const slot = plotW / 24;
  const barW = Math.max(6, slot - 8);
  const peakHour = profile.reduce(
    (best, entry) => (entry.avgPlayers > (best ? best.avgPlayers : -1) ? entry : best),
    null
  );

  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';

  for (let hour = 0; hour < 24; hour += 1) {
    const entry = byHour.get(hour);
    const value = entry ? entry.avgPlayers : 0;
    const x = plotX + slot * hour + (slot - barW) / 2;
    const y = yAt(value);

    // The busiest hour is the answer to the question, so it is the only bar
    // that gets the accent.
    ctx.fillStyle = peakHour && entry === peakHour ? T.accent : T.raised;
    ctx.fillRect(x, y, barW, plotY + plotH - y);

    if (hour % 2 === 0) {
      ctx.fillStyle = T.inkFaint;
      ctx.font = font(10);
      ctx.fillText(String(hour).padStart(2, '0'), x + barW / 2, plotY + plotH + 10);
    }
  }

  ctx.strokeStyle = T.lineStrong;
  ctx.strokeRect(plotX + 0.5, plotY + 0.5, plotW - 1, plotH - 1);

  ctx.font = font(12);
  ctx.fillStyle = T.inkMuted;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const footer = peakHour
    ? `Busiest hour ${String(peakHour.hour).padStart(2, '0')}:00 UTC, averaging ${peakHour.avgPlayers.toFixed(1)} players`
    : (meta.footer || '');
  ctx.fillText(truncate(ctx, footer, plotW), plotX, height - 20);

  return canvas.toBuffer('image/png');
}

/*
  Availability over time, drawn as a strip of bars rather than a line.

  Uptime is not a continuous quantity the way a player count is: what a reader
  wants is "which periods were bad", and a bar per bucket answers that at a
  glance where a line hovering near 100% does not. Colour carries the meaning
  here, which is the one place in this palette where that is the right call:
  green fully up, amber degraded, red down, and a flat grey stub for a bucket
  with no data at all, because "we did not look" must not read as an outage.
*/
function renderUptimeChart(points, meta = {}) {
  registerFonts();

  const height = 320;
  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext('2d');

  const plotX = PAD.left;
  const plotY = 78;
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = height - plotY - 54;

  ctx.fillStyle = T.page;
  ctx.fillRect(0, 0, WIDTH, height);
  ctx.fillStyle = T.panel;
  ctx.fillRect(plotX, plotY, plotW, plotH);

  ctx.fillStyle = T.ink;
  ctx.font = font(20, true);
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(truncate(ctx, meta.title || 'Uptime', plotW - 220), PAD.left, 34);

  if (meta.subtitle) {
    ctx.fillStyle = T.inkMuted;
    ctx.font = font(13);
    ctx.fillText(truncate(ctx, meta.subtitle, plotW - 220), PAD.left, 55);
  }

  ctx.textAlign = 'right';
  ctx.fillStyle = T.inkFaint;
  ctx.font = font(12);
  ctx.fillText(meta.rangeLabel || '', WIDTH - PAD.right, 34);
  ctx.fillText('gamequery.dev', WIDTH - PAD.right, 55);
  ctx.textAlign = 'left';

  const usable = Array.isArray(points) ? points : [];

  if (usable.length === 0) {
    ctx.fillStyle = T.inkFaint;
    ctx.font = font(15);
    ctx.textAlign = 'center';
    ctx.fillText('No availability recorded for this range yet.', WIDTH / 2, plotY + plotH / 2);
    ctx.textAlign = 'left';
    ctx.strokeStyle = T.line;
    ctx.strokeRect(plotX + 0.5, plotY + 0.5, plotW - 1, plotH - 1);
    return canvas.toBuffer('image/png');
  }

  // Gridlines at 0/50/100 only: the interesting reading is "is it at the top",
  // and more lines would crowd a strip this short.
  ctx.font = font(11);
  ctx.textBaseline = 'middle';
  [0, 50, 100].forEach((value) => {
    const y = plotY + plotH - (value / 100) * plotH;
    ctx.strokeStyle = value === 0 ? T.lineStrong : T.line;
    ctx.beginPath();
    ctx.moveTo(plotX, Math.round(y) + 0.5);
    ctx.lineTo(plotX + plotW, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.fillStyle = T.inkFaint;
    ctx.textAlign = 'right';
    ctx.fillText(`${value}%`, plotX - 10, y);
  });
  ctx.textAlign = 'left';

  const slot = plotW / usable.length;
  const barW = Math.max(1, slot - (slot > 6 ? 2 : 0.5));

  usable.forEach((point, index) => {
    const x = plotX + slot * index + (slot - barW) / 2;

    if (point.uptime === null || point.uptime === undefined) {
      // No samples in this bucket. A thin grey stub says "no data" without
      // claiming the server was down.
      ctx.fillStyle = T.raised;
      ctx.fillRect(x, plotY + plotH - 3, barW, 3);
      return;
    }

    const value = Math.max(0, Math.min(100, point.uptime));
    const barH = Math.max(2, (value / 100) * plotH);

    ctx.fillStyle = value >= 99 ? T.success : (value >= 90 ? T.warn : T.danger);
    ctx.fillRect(x, plotY + plotH - barH, barW, barH);
  });

  ctx.strokeStyle = T.lineStrong;
  ctx.lineWidth = 1;
  ctx.strokeRect(plotX + 0.5, plotY + 0.5, plotW - 1, plotH - 1);

  const measured = usable.filter((point) => point.uptime !== null && point.uptime !== undefined);
  const overall = measured.length > 0
    ? measured.reduce((sum, point) => sum + point.uptime, 0) / measured.length
    : null;

  ctx.font = font(11);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const ticks = Math.min(8, Math.max(2, Math.floor(plotW / 130)));
  for (let i = 0; i <= ticks; i += 1) {
    const index = Math.min(usable.length - 1, Math.round((usable.length - 1) * (i / ticks)));
    const x = plotX + slot * index + slot / 2;
    ctx.fillStyle = T.inkFaint;
    ctx.fillText(formatClock(usable[index].at, meta.rangeKey), x, plotY + plotH + 10);
  }

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = font(12);
  ctx.fillStyle = T.inkMuted;
  ctx.fillText(
    truncate(ctx, overall === null
      ? 'Not enough checks yet to state availability.'
      : `${overall.toFixed(2)}% of checks answered${meta.footer ? ` · ${meta.footer}` : ''}`, plotW),
    plotX,
    height - 20
  );

  return canvas.toBuffer('image/png');
}

module.exports = { renderPlayerChart, renderUptimeChart, renderHourProfile, registerFonts, SERIES_COLORS, T };
