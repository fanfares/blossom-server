/**
 * Parse a strict dotted-decimal IPv4 address for mirror-network classification.
 *
 * @param value URL hostname or DNS answer being normalized into four octets.
 */
function parseIPv4(value: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return null;
  const octets = value.split(".").map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return null;
  return octets;
}

/**
 * Parse an IPv6 address for mirror-network classification, including embedded IPv4.
 *
 * @param value Bracketed or unbracketed URL hostname or DNS answer.
 */
function parseIPv6(value: string): number[] | null {
  let normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  const zoneIndex = normalized.indexOf("%");
  if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex);

  const ipv4Tail = normalized.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (ipv4Tail) {
    const octets = parseIPv4(ipv4Tail);
    if (!octets) return null;
    const replacement = `${(octets[0] << 8 | octets[1]).toString(16)}:${
      (octets[2] << 8 | octets[3]).toString(16)
    }`;
    normalized = normalized.slice(0, -ipv4Tail.length) + replacement;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = [...head, ...tail];
  if (
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group)) ||
    groups.length > 8 ||
    (halves.length === 1 && groups.length !== 8)
  ) {
    return null;
  }

  const omitted = halves.length === 2 ? 8 - groups.length : 0;
  if (halves.length === 2 && omitted < 1) return null;
  return [
    ...head.map((group) => parseInt(group, 16)),
    ...Array(omitted).fill(0),
    ...tail.map((group) => parseInt(group, 16)),
  ];
}

/**
 * Identify IPv4 ranges that must never be reachable through the mirror fetcher.
 *
 * @param octets Four octets returned by parseIPv4 for the current target.
 */
function isBlockedIPv4(octets: number[]): boolean {
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224;
}

/**
 * Identify non-public IPv6 ranges and IPv4-mapped private addresses.
 *
 * @param groups Eight 16-bit groups returned by parseIPv6 for the current target.
 */
function isBlockedIPv6(groups: number[]): boolean {
  const [a, b, c, d, e, f, g, h] = groups;
  const isUnspecified = groups.every((group) => group === 0);
  const isLoopback = groups.slice(0, 7).every((group) => group === 0) &&
    h === 1;
  const isMappedIPv4 = groups.slice(0, 5).every((group) => group === 0) &&
    f === 0xffff;
  const isNat64IPv4 = a === 0x0064 && b === 0xff9b && c === 0 && d === 0 &&
    e === 0 && f === 0;

  if (isMappedIPv4 || isNat64IPv4) {
    return isBlockedIPv4([g >> 8, g & 0xff, h >> 8, h & 0xff]);
  }

  return isUnspecified || isLoopback ||
    (a & 0xfe00) === 0xfc00 || // fc00::/7 unique-local
    (a & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (a & 0xffc0) === 0xfec0 || // fec0::/10 deprecated site-local
    (a & 0xff00) === 0xff00 || // ff00::/8 multicast
    (a === 0x2001 && b === 0x0db8) || // documentation range
    (a & 0xe000) !== 0x2000; // fail closed outside global unicast 2000::/3
}

/**
 * Return whether a hostname or resolved address is unsafe for public mirroring.
 *
 * @param hostname URL hostname or DNS answer checked before an outbound fetch.
 */
export function isBlockedNetworkHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(
    /\.$/,
    "",
  );
  if (
    normalized === "localhost" || normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") || normalized.endsWith(".internal") ||
    normalized === "home.arpa" || normalized.endsWith(".home.arpa")
  ) {
    return true;
  }

  const ipv4 = parseIPv4(normalized);
  if (ipv4) return isBlockedIPv4(ipv4);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) return true;

  if (normalized.includes(":")) {
    const ipv6 = parseIPv6(normalized);
    return !ipv6 || isBlockedIPv6(ipv6);
  }
  return false;
}

/**
 * Return whether a hostname is a syntactically valid IPv4 or IPv6 literal.
 *
 * @param hostname URL hostname or DNS answer being distinguished from a DNS name.
 */
export function isIpAddressHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  return Boolean(parseIPv4(normalized) || parseIPv6(normalized));
}
