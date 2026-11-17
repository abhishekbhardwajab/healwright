# Studio + execution worker in one image (PoC). Uses the official Playwright image so
# Chromium and its system dependencies match the installed playwright version.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV PORT=3000 DATA_DIR=/data NODE_ENV=production
RUN mkdir -p /data && chown -R pwuser:pwuser /data /app
USER pwuser
EXPOSE 3000
CMD ["npx", "tsx", "src/server/index.ts"]
