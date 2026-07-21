# Job-launcher broker (D2) — minimal image.
#
# Holds the Docker socket (mounted at runtime): minimal surface → base docker
# CLI + Node, no npm dependencies, only server.js. Runs as root because it must
# access /var/run/docker.sock; it is the only component with this privilege.
FROM docker:27-cli

RUN apk add --no-cache nodejs

WORKDIR /app
COPY package.json server.js ./

# The docker:cli image has ENTRYPOINT ["docker"] → reset it to start Node.
ENTRYPOINT []
# Startup: node server.js (the narrow /run-job API builds the hardened `docker run`s).
CMD ["node", "server.js"]
