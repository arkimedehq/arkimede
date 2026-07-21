/**
 * proxy-env.ts — passthrough of the egress-proxy variables (C1) to the skill subprocesses.
 *
 * When the executor runs on the internal network without a gateway + egress-proxy
 * (docker-compose.egress.yml overlay), `HTTP_PROXY`/`HTTPS_PROXY` are set on the
 * executor. This helper propagates them to the subprocess (uppercase AND lowercase,
 * because pip/requests use `http_proxy`, npm/others `HTTP_PROXY`) and sets
 * `NO_PROXY` to exclude the internal services (backend API, localhost).
 *
 * No-op if the proxy is not configured (local development without the overlay).
 */
export function proxyEnv(): NodeJS.ProcessEnv {
  const http  = process.env.HTTP_PROXY  ?? process.env.http_proxy;
  const https = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? http;
  if (!http && !https) return {};

  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy
    ?? 'localhost,127.0.0.1,backend,skill-executor';

  const env: NodeJS.ProcessEnv = {};
  if (http)  { env.HTTP_PROXY  = http;  env.http_proxy  = http; }
  if (https) { env.HTTPS_PROXY = https; env.https_proxy = https; }
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;
  return env;
}

/**
 * Extra env for a NODE subprocess under egress: Node does NOT honor HTTP_PROXY natively
 * (unlike Python's urllib), so we preload global-agent (installed in the target image)
 * via NODE_OPTIONS, which patches http/https to route through the egress proxy.
 * `bootstrapPath` = absolute path to global-agent/bootstrap in that image. No-op ({}) when
 * no proxy is configured. Combine with proxyEnv() (raw HTTP_PROXY for libs that honor it).
 */
export function nodeProxyEnv(bootstrapPath: string): NodeJS.ProcessEnv {
  const http  = process.env.HTTP_PROXY  ?? process.env.http_proxy;
  const https = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? http;
  if (!http && !https) return {};
  const proxy = (http ?? https)!;
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy
    ?? 'localhost,127.0.0.1,backend,skill-executor';
  return {
    GLOBAL_AGENT_HTTP_PROXY:  proxy,
    GLOBAL_AGENT_HTTPS_PROXY: https ?? proxy,
    GLOBAL_AGENT_NO_PROXY:    noProxy,
    NODE_OPTIONS: `-r ${bootstrapPath}`,
  };
}
