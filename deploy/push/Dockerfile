# The network's push relay (push/, docs/MOBILE.md "Waking a closed app"): a small
# Node service with no dependencies beyond Node itself.
FROM node:24-slim
WORKDIR /app/push
COPY push/package.json push/package-lock.json ./
RUN npm ci
COPY push/ ./
# Its database's folder, its own account's alone (push/src/store.ts): made
# here, owned by the unprivileged node user the relay runs as. A new volume
# takes its owner and mode from this.
ENV DB_PATH=/var/lib/handshake-push/push.db
RUN mkdir -p /var/lib/handshake-push && chown node:node /var/lib/handshake-push && chmod 700 /var/lib/handshake-push
VOLUME /var/lib/handshake-push
USER node
EXPOSE 8892
CMD ["npm", "start"]
