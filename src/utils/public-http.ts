/**
 * SSRF-safe HTTP fetching for server-side Blossom mirror requests.
 *
 * Every requested hostname is checked as a literal and through DNS-over-HTTPS,
 * and redirects are followed manually so each destination is revalidated.
 */

import {
  isBlockedNetworkHostname,
  isIpAddressHostname,
} from "./network-address.ts";
import {
  type HostnameResolver,
  type HttpFetcher,
  resolveHostnameWithDoh,
} from "./dns-over-https.ts";

export { isBlockedNetworkHostname } from "./network-address.ts";
export { resolveHostnameWithDoh } from "./dns-over-https.ts";
export type { HostnameResolver, HttpFetcher } from "./dns-over-https.ts";

const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface PublicHttpFetchOptions {
  /** Maximum time to wait for headers from each origin or redirect hop. */
  connectTimeoutMs: number;
  /** Fetch implementation supplied by tests; production uses the Deno global. */
  fetcher?: HttpFetcher;
  /** DNS resolver supplied by tests; production uses Cloudflare DNS-over-HTTPS. */
  resolver?: HostnameResolver;
  /** Maximum number of redirects followed after validating every destination. */
  maxRedirects?: number;
}

/** Error raised when an outbound mirror URL fails public-network validation. */
export class PublicHttpUrlError extends Error {
  override name = "PublicHttpUrlError";
}

/**
 * Reject a mirror URL unless its scheme, credentials, hostname, and DNS answers are public.
 *
 * @param url Initial mirror URL or redirect destination about to be fetched.
 * @param resolver Resolver used to enumerate every address for non-literal hostnames.
 */
export async function assertPublicHttpUrl(
  url: URL,
  resolver: HostnameResolver = resolveHostnameWithDoh,
): Promise<void> {
  assertPublicHttpUrlSyntax(url);

  const normalized = url.hostname.replace(/^\[|\]$/g, "");
  if (isIpAddressHostname(normalized)) return;

  const answers = await resolver(normalized);
  if (answers.length === 0) {
    throw new PublicHttpUrlError(
      `Unable to validate mirror hostname: ${normalized}`,
    );
  }
  for (const answer of answers) {
    if (!isIpAddressHostname(answer) || isBlockedNetworkHostname(answer)) {
      throw new PublicHttpUrlError(
        `Mirror hostname resolves to a non-public address: ${normalized}`,
      );
    }
  }
}

/**
 * Reject an invalid scheme, embedded credentials, or a blocked literal host without performing DNS.
 *
 * Invoked by PUT /mirror before checking worker capacity; full DNS validation
 * occurs immediately before each outbound origin or redirect fetch.
 *
 * @param url Initial mirror URL parsed from the request body.
 */
export function assertPublicHttpUrlSyntax(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PublicHttpUrlError(
      `Unsupported URL scheme: ${url.protocol}. Only http and https are allowed`,
    );
  }
  if (url.username || url.password) {
    throw new PublicHttpUrlError("Mirror URLs must not contain credentials");
  }
  if (isBlockedNetworkHostname(url.hostname)) {
    throw new PublicHttpUrlError(
      `Mirror URL points to a non-public address: ${url.hostname}`,
    );
  }
}

/**
 * Fetch one already-validated URL while limiting how long headers may take.
 *
 * @param url Public URL for the current mirror fetch hop.
 * @param connectTimeoutMs Header timeout configured for mirror requests.
 * @param fetcher Fetch implementation used for the outbound origin request.
 */
async function fetchWithHeaderTimeout(
  url: URL,
  connectTimeoutMs: number,
  fetcher: HttpFetcher,
): Promise<Response> {
  if (connectTimeoutMs <= 0) {
    return await fetcher(url, { redirect: "manual" });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), connectTimeoutMs);
  try {
    return await fetcher(url, {
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `Origin server did not respond within ${connectTimeoutMs}ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a public HTTP URL and manually validate every redirect destination.
 *
 * Invoked only by PUT /mirror after authentication and capacity checks. The
 * returned final response body remains available for the upload worker.
 *
 * @param initialUrl Creator-supplied remote blob URL parsed by the mirror route.
 * @param options Timeout, redirect, resolver, and fetch dependencies for this request.
 */
export async function fetchPublicHttpUrl(
  initialUrl: URL,
  options: PublicHttpFetchOptions,
): Promise<Response> {
  const fetcher = options.fetcher ?? fetch;
  const resolver = options.resolver ?? resolveHostnameWithDoh;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let currentUrl = initialUrl;

  for (let redirects = 0;; redirects += 1) {
    await assertPublicHttpUrl(currentUrl, resolver);
    const response = await fetchWithHeaderTimeout(
      currentUrl,
      options.connectTimeoutMs,
      fetcher,
    );
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || !location) return response;

    await response.body?.cancel().catch(() => {});
    if (redirects >= maxRedirects) {
      throw new Error(`Mirror origin exceeded ${maxRedirects} redirects`);
    }
    currentUrl = new URL(location, currentUrl);
  }
}
