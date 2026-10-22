/**
 * simulator/src/sign.js
 * D41: Re-exports from @hookmend/common so existing imports continue to work.
 */

// Re-export from common — both the legacy boolean-drift form and the new preset form
export { signGenericHmac } from '@hookmend/common';

import { buildPaymentEvent as _buildPaymentEvent } from '@hookmend/common';

/**
 * Legacy wrapper: accepts { drift: boolean } for backward compat with existing tests.
 * Maps boolean drift → 'all' preset or 'none'.
 */
export function buildPaymentEvent({ drift = false } = {}) {
  if (typeof drift === 'boolean') {
    return _buildPaymentEvent({ drift: drift ? 'all' : 'none' });
  }
  return _buildPaymentEvent({ drift });
}
