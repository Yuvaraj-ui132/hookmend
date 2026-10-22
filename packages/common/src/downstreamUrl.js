/**
 * packages/common/src/downstreamUrl.js
 * D39: Shared downstream URL validator.
 *
 * Returns null if valid, or an error string if invalid.
 *
 * Rules:
 * - Must parse as http or https
 * - ALWAYS reject 169.254.0.0/16 (link-local / IMDS)
 * - ALWAYS reject host "metadata.google.internal"
 * - Reject loopback (127.x, ::1, localhost) always in production, unless ALLOW_PRIVATE_DOWNSTREAM
 * - Reject private ranges (10/8, 172.16/12, 192.168/16) in production unless ALLOW_PRIVATE_DOWNSTREAM
 *
 * Known limitation (D39): DNS rebinding is NOT handled.
 *
 * @param {string} url
 * @param {{ NODE_ENV?: string, ALLOW_PRIVATE_DOWNSTREAM?: boolean }} config
 * @returns {string|null} null if valid, error message if invalid
 */
export function validateDownstreamUrl(url, config = {}) {
  if (!url || typeof url !== 'string') {
    return 'downstreamUrl is required and must be a string';
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return `downstreamUrl is not a valid URL: "${url}"`;
  }

  // Must be http or https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `downstreamUrl must use http or https scheme, got "${parsed.protocol}"`;
  }

  const host = parsed.hostname.toLowerCase();

  // Always reject metadata.google.internal
  if (host === 'metadata.google.internal') {
    return 'downstreamUrl host "metadata.google.internal" is always forbidden';
  }

  // Parse IP for further checks
  const ip = host;

  // Always reject 169.254.0.0/16 (link-local)
  if (isLinkLocal(ip)) {
    return `downstreamUrl host is in the link-local range (169.254.0.0/16): "${host}"`;
  }

  const isProduction = config.NODE_ENV === 'production';
  const allowPrivate = config.ALLOW_PRIVATE_DOWNSTREAM === true;

  if (isProduction && !allowPrivate) {
    // Reject loopback
    if (isLoopback(host)) {
      return `downstreamUrl host "${host}" is a loopback address (forbidden in production)`;
    }

    // Reject private ranges
    if (isPrivateIp(ip)) {
      return `downstreamUrl host "${host}" is in a private IP range (forbidden in production without ALLOW_PRIVATE_DOWNSTREAM)`;
    }
  }

  return null;
}

/** 169.254.0.0/16 */
function isLinkLocal(host) {
  const parts = ipv4Parts(host);
  if (!parts) return false;
  return parts[0] === 169 && parts[1] === 254;
}

/** loopback: 127.0.0.0/8, ::1, or "localhost" */
function isLoopback(host) {
  if (host === 'localhost' || host === '::1') return true;
  const parts = ipv4Parts(host);
  if (!parts) return false;
  return parts[0] === 127;
}

/**
 * Private IPv4 ranges:
 *   10.0.0.0/8
 *   172.16.0.0/12  (172.16.x.x – 172.31.x.x)
 *   192.168.0.0/16
 */
function isPrivateIp(host) {
  const parts = ipv4Parts(host);
  if (!parts) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * Parse dotted-decimal IPv4 string → [a, b, c, d] or null if not IPv4.
 */
function ipv4Parts(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => isNaN(n) || n < 0 || n > 255)) return null;
  return nums;
}
