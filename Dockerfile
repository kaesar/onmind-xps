FROM oven/bun:1.4 AS base
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production
COPY src ./src
ENV XPS_ENV=production PORT=8789 XPS_JSON_PATH=/data/xsetup.json
EXPOSE 8789
VOLUME ["/data"]
CMD ["bun", "src/dev.js"]
