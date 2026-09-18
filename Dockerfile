FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends nginx \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/ packages/

RUN npm ci --legacy-peer-deps

COPY . .

RUN npm run build:web

RUN cp -r apps/web/dist/* /var/www/html/

COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80

VOLUME /app/apps/server/.wrangler/state

CMD ["/entrypoint.sh"]
