/**
 * replay.js — Replay quarantined events against a proposed schema (D23).
 */

import Ajv from 'ajv';

/**
 * Replays quarantined events against a schema to test validity before approval.
 *
 * @param {{
 *   db: object,
 *   sourceId: string,
 *   eventType: string,
 *   driftFingerprint: string,
 *   schema: object,
 *   max?: number
 * }} params
 * @returns {Promise<{
 *   total: number,
 *   passed: number,
 *   failed: number,
 *   truncated: boolean,
 *   failedEventIds: string[]
 * }>}
 */
export function replayEvents({ db, sourceId, eventType, driftFingerprint, schema, max = 1000 }) {
  return new Promise(async (resolve, reject) => {
    try {
      const jsonSchema = schema?.schema || schema;
      const ajv = new Ajv({ allErrors: true, strict: false });
      const validate = ajv.compile(jsonSchema);

      const eventsColl = db.collection('events');
      const filter = {
        sourceId,
        eventType,
        driftFingerprint,
        status: 'quarantined',
      };

      let totalInDb = 0;
      if (typeof eventsColl.countDocuments === 'function') {
        try {
          totalInDb = await eventsColl.countDocuments(filter);
        } catch {
          totalInDb = 0;
        }
      }

      const events = await eventsColl
        .find(filter)
        .sort({ receivedAt: 1 })
        .limit(max)
        .toArray();

      let passed = 0;
      let failed = 0;
      const failedEventIds = [];

      for (const event of events) {
        let payload = event.payload;
        if (typeof payload === 'string') {
          try {
            payload = JSON.parse(payload);
          } catch {
            payload = null;
          }
        }

        const isValid = payload !== null && validate(payload);
        if (isValid) {
          passed++;
        } else {
          failed++;
          if (failedEventIds.length < 10) {
            failedEventIds.push(event._id);
          }
        }
      }

      const total = passed + failed;
      const truncated = totalInDb > max;

      resolve({
        total,
        passed,
        failed,
        truncated,
        failedEventIds,
      });
    } catch (err) {
      reject(err);
    }
  });
}
