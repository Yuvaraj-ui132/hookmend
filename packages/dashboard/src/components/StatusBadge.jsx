/**
 * src/components/StatusBadge.jsx — Status badge with text label (not color-only)
 */

import React from 'react';

export default function StatusBadge({ status }) {
  const label = status ? status.replace(/_/g, ' ') : 'unknown';
  return (
    <span className={`badge badge-${status || 'unknown'}`} aria-label={`Status: ${label}`}>
      {label}
    </span>
  );
}
