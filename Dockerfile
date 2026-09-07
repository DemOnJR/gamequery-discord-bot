FROM node:22-alpine

# DejaVu is what the chart renderer draws its labels with. @napi-rs/canvas ships
# prebuilt binaries but no fonts, and a missing font produces a valid PNG with
# nothing written on it rather than an error, so this is a hard dependency of
# the graph feature rather than a nicety.
RUN apk add --no-cache font-dejavu tini

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
COPY data ./data

ENV NODE_ENV=production \
    GAMES_JSON_PATH=/app/data/games.json \
    FONT_DIR=/usr/share/fonts/dejavu \
    HEALTH_PORT=8081

# Fails the build if a slash command Discord would reject, the name renderer,
# the alert transitions, guild isolation or the chart renderer are broken.
RUN node scripts/selfcheck.js

EXPOSE 8081
USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
