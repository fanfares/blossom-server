const DNS_OVER_HTTPS_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DNS_TIMEOUT_MS = 5_000;

export type HostnameResolver = (hostname: string) => Promise<string[]>;
export type HttpFetcher = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

interface DnsJsonAnswer {
  data?: string;
  type?: number;
}

interface DnsJsonResponse {
  Answer?: DnsJsonAnswer[];
}

/**
 * Resolve one A or AAAA record set with Cloudflare DNS-over-HTTPS.
 *
 * @param hostname Public hostname from a requested mirror URL.
 * @param recordType DNS record family selected for this lookup.
 * @param fetcher Fetch implementation supplied by the resolver or its tests.
 */
async function resolveDnsRecordType(
  hostname: string,
  recordType: "A" | "AAAA",
  fetcher: HttpFetcher,
): Promise<string[]> {
  const typeNumber = recordType === "A" ? 1 : 28;
  const url = `${DNS_OVER_HTTPS_ENDPOINT}?name=${
    encodeURIComponent(hostname)
  }&type=${recordType}`;
  const response = await fetcher(url, {
    headers: { Accept: "application/dns-json" },
    redirect: "error",
    signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`DNS resolution failed for ${hostname} (${recordType})`);
  }
  const payload = await response.json() as DnsJsonResponse;
  return (payload.Answer ?? [])
    .filter((answer) => answer.type === typeNumber)
    .map((answer) => answer.data?.trim() ?? "")
    .filter(Boolean);
}

/**
 * Resolve all public-address candidates for a mirror hostname through DoH.
 *
 * @param hostname Non-literal hostname from the requested mirror URL.
 * @param fetcher Fetch implementation used only for the two DoH queries.
 */
export async function resolveHostnameWithDoh(
  hostname: string,
  fetcher: HttpFetcher = fetch,
): Promise<string[]> {
  const [ipv4, ipv6] = await Promise.all([
    resolveDnsRecordType(hostname, "A", fetcher),
    resolveDnsRecordType(hostname, "AAAA", fetcher),
  ]);
  return [...ipv4, ...ipv6];
}
