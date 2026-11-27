// Injectable HTTP transport for the shared REST clients.
//
// The web app keeps the browser default (global fetch, same-origin, relative
// paths). A mini-program consumer has no fetch and no origin, so it calls
// configureHttp() once at boot with a Taro.request-backed transport, an
// absolute base URL, and (when its deployment authenticates) a header
// provider that mints the Authorization header.

export interface HttpInit {
  method?: string;
  headers?: Record<string, string>;
  // FormData stays web-shaped; the mini program uploads through its own
  // runtime multipart API instead of these clients.
  body?: string | FormData | undefined;
  signal?: AbortSignal;
}

// The slice of Response these clients actually use, so a mini-program
// transport can satisfy it without constructing a real Response. json()
// stays loosely typed to match the DOM Response these clients were
// originally written against.
export interface HttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  // biome-ignore lint/suspicious/noExplicitAny: mirrors DOM Response.json()
  json(): Promise<any>;
}

export type HttpTransport = (path: string, init?: HttpInit) => Promise<HttpResponse>;

interface HttpConfig {
  baseUrl: string;
  headers: () => Record<string, string>;
  transport: HttpTransport;
}

const config: HttpConfig = {
  baseUrl: "",
  headers: () => ({}),
  transport: (path, init) =>
    fetch(path, { ...init, credentials: "same-origin" }) as unknown as Promise<HttpResponse>,
};

export function configureHttp(opts: {
  baseUrl?: string;
  headers?: () => Record<string, string>;
  transport?: HttpTransport;
}) {
  if (opts.baseUrl !== undefined) config.baseUrl = opts.baseUrl.replace(/\/$/, "");
  if (opts.headers) config.headers = opts.headers;
  if (opts.transport) config.transport = opts.transport;
}

export function http(path: string, init?: HttpInit): Promise<HttpResponse> {
  const headers = { ...config.headers(), ...(init?.headers ?? {}) };
  return config.transport(config.baseUrl + path, init ? { ...init, headers } : { headers });
}

// Same transport, but without the configured auth headers — for the share
// endpoints' public read, where a stale mini-program token must never gate a
// recipient's view (the gateway route is public by design).
export function httpPublic(path: string, init?: HttpInit): Promise<HttpResponse> {
  return config.transport(config.baseUrl + path, init ? { ...init, headers: init.headers ?? {} } : { headers: {} });
}
