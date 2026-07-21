# Egress-proxy: Squid + watcher for the hot reload of the skill allowlist.
#
# Functionally identical to the stock `ubuntu/squid` image as a proxy, but with an
# entrypoint that, besides starting Squid, watches the domains include file
# (written by the backend on the shared volume) and runs `squid -k reconfigure`
# (SIGHUP) on every change. No access to the Docker socket: the invariant "only the
# broker touches the socket" stays intact.
FROM ubuntu/squid:latest

COPY entrypoint.sh /usr/local/bin/egress-entrypoint.sh
RUN chmod +x /usr/local/bin/egress-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/egress-entrypoint.sh"]
