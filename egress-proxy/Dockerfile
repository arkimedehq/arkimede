# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright © 2026 Andrea Genovese

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

# Bake the project's Squid config into the image so a PULLED image is self-contained
# (the pull-based `arkimede-deploy` bundle has no source tree to bind-mount). The
# source-based compose still bind-mounts ./egress-proxy/squid.conf over this path with
# identical content, so this is additive and changes nothing for the build flow.
COPY squid.conf /etc/squid/squid.conf

ENTRYPOINT ["/usr/local/bin/egress-entrypoint.sh"]
