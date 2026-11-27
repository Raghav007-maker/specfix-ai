import { describe, expect, it } from 'vitest';
import { isSignedOff } from '../src/index.ts';

const ev = (event: string, v: string, t: string, backfilled = false) => ({
  event,
  ticket_version_id: v,
  occurred_at: t,
  backfilled,
});

describe('isSignedOff', () => {
  it('counts a sign-off made after the analysis of the same version', () => {
    const e = [
      ev('analysis_complete', 'v1', '2026-01-01T10:00Z'),
      ev('marked_ready', 'v1', '2026-01-01T11:00Z'),
    ];
    expect(isSignedOff(e, 'v1')).toBe(true);
  });

  it('refuses a sign-off made before the analysis, or with none', () => {
    const early = [
      ev('marked_ready', 'v1', '2026-01-01T09:00Z'),
      ev('analysis_complete', 'v1', '2026-01-01T10:00Z'),
    ];
    expect(isSignedOff(early, 'v1')).toBe(false);
    expect(isSignedOff([ev('marked_ready', 'v1', '2026-01-01T09:00Z')], 'v1')).toBe(false);
  });

  it('ignores other versions and unrelated events, and takes backfilled history as it is', () => {
    const e = [
      ev('analysis_complete', 'v1', '2026-01-01T10:00Z'),
      ev('marked_ready', 'v2', '2026-01-01T11:00Z'),
    ];
    expect(isSignedOff(e, 'v1')).toBe(false);
    expect(isSignedOff(e, 'v2')).toBe(false);
    expect(isSignedOff([ev('marked_ready', 'v3', '2020-01-01T00:00Z', true)], 'v3')).toBe(true);
  });
});
