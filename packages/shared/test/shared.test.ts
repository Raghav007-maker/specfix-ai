import { describe, it, expect } from 'vitest';
import {
  ticketContentHash,
  flagDedupeKey,
  canonicalizeText,
  LlmFlagSchema,
  AnalysisResultSchema,
  isRealIssue,
  isReviewed,
  type AnalyzableTicket,
} from '../src/index.ts';

const ticket: AnalyzableTicket = {
  externalKey: 'PAY-142',
  title: 'Allow partial refunds',
  descriptionText: 'A support agent should be able to refund part of an order.',
  acceptanceCriteriaText: '- Agent can enter an amount',
};

describe('ticketContentHash', () => {
  it('is stable across CRLF and trailing whitespace differences', () => {
    const withCrlf: AnalyzableTicket = {
      ...ticket,
      descriptionText: 'A support agent should be able to refund part of an order.   \r\n',
    };
    expect(ticketContentHash(withCrlf)).toBe(ticketContentHash(ticket));
  });

  it('changes when analyzable text changes', () => {
    const edited: AnalyzableTicket = { ...ticket, acceptanceCriteriaText: '- Agent enters amount' };
    expect(ticketContentHash(edited)).not.toBe(ticketContentHash(ticket));
  });

  it('ignores externalKey, which is not analyzable content', () => {
    const renamed: AnalyzableTicket = { ...ticket, externalKey: 'PAY-999' };
    expect(ticketContentHash(renamed)).toBe(ticketContentHash(ticket));
  });

  it('does not collide when text moves between fields', () => {
    const moved: AnalyzableTicket = {
      ...ticket,
      descriptionText: `${ticket.descriptionText}\n- Agent can enter an amount`,
      acceptanceCriteriaText: '',
    };
    expect(ticketContentHash(moved)).not.toBe(ticketContentHash(ticket));
  });
});

describe('canonicalizeText', () => {
  it('preserves interior blank lines but trims the ends', () => {
    expect(canonicalizeText('\n\na\n\nb\n\n')).toBe('a\n\nb');
  });
});

describe('flagDedupeKey', () => {
  it('collapses punctuation and casing differences', () => {
    expect(flagDedupeKey('missing_info', 'Refund limit is not defined.')).toBe(
      flagDedupeKey('missing_info', 'refund limit is not defined')
    );
  });

  it('separates identical text under different categories', () => {
    expect(flagDedupeKey('missing_info', 'no limit defined')).not.toBe(
      flagDedupeKey('untestable', 'no limit defined')
    );
  });
});

describe('LlmFlagSchema', () => {
  const valid = {
    category: 'missing_info',
    quoted_span: 'refund part of an order',
    what_unclear: 'No maximum refund amount is specified.',
    why_it_matters: 'An agent could refund more than the order total.',
    question_for_pm: 'What is the maximum an agent may refund without approval?',
    severity: 'high',
  };

  it('accepts a well-formed flag', () => {
    expect(LlmFlagSchema.parse(valid)).toEqual(valid);
  });

  it('rejects an unknown category', () => {
    expect(() => LlmFlagSchema.parse({ ...valid, category: 'vibes' })).toThrow();
  });

  it('rejects extra properties, so silent prompt drift cannot leak fields through', () => {
    expect(() => LlmFlagSchema.parse({ ...valid, confidence: 0.9 })).toThrow();
  });

  it('rejects an empty question_for_pm, which would be useless to a reviewer', () => {
    expect(() => LlmFlagSchema.parse({ ...valid, question_for_pm: '' })).toThrow();
  });

  it('allows an empty quoted_span, for gaps that are about an absence', () => {
    expect(() => LlmFlagSchema.parse({ ...valid, quoted_span: '' })).not.toThrow();
  });
});

describe('AnalysisResultSchema', () => {
  it('accepts zero flags, which is a legitimate verdict on a clear ticket', () => {
    expect(AnalysisResultSchema.parse({ flags: [] })).toEqual({ flags: [] });
  });

  it('rejects a bare array', () => {
    expect(() => AnalysisResultSchema.parse([])).toThrow();
  });
});

describe('review status helpers', () => {
  it('counts accepted and edited as real issues', () => {
    expect(isRealIssue('accepted')).toBe(true);
    expect(isRealIssue('edited')).toBe(true);
    expect(isRealIssue('dismissed')).toBe(false);
    expect(isRealIssue('open')).toBe(false);
    expect(isRealIssue('stale')).toBe(false);
  });

  it('excludes open and stale flags from the precision denominator', () => {
    expect(isReviewed('open')).toBe(false);
    expect(isReviewed('stale')).toBe(false);
    expect(isReviewed('dismissed')).toBe(true);
  });
});
