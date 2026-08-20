import { describe, expect, it } from 'vitest';
import {
  COLLAPSED_PREVIEW_CHARS,
  EM_DASH,
  collapsePreview,
  degradedReasonText,
  formatCost,
  formatDuration,
  formatTokens,
} from './format.js';
import { longPreview } from './testdata.js';

describe('collapsePreview', () => {
  it('returns short text untouched and unmarked', () => {
    const result = collapsePreview('hello');
    expect(result).toEqual({ text: 'hello', truncated: false, hiddenChars: 0, marker: '' });
  });

  it('does not truncate at exactly the limit', () => {
    const text = 'x'.repeat(COLLAPSED_PREVIEW_CHARS);
    expect(collapsePreview(text).truncated).toBe(false);
  });

  it('truncates one character past the limit', () => {
    const text = 'x'.repeat(COLLAPSED_PREVIEW_CHARS + 1);
    const result = collapsePreview(text);
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(COLLAPSED_PREVIEW_CHARS);
    expect(result.hiddenChars).toBe(1);
  });

  it('names how many characters it hid, rather than cutting silently', () => {
    const text = longPreview(2000);
    const result = collapsePreview(text);
    expect(result.text).toHaveLength(COLLAPSED_PREVIEW_CHARS);
    expect(result.hiddenChars).toBe(2000 - COLLAPSED_PREVIEW_CHARS);
    expect(result.marker).toContain(String(2000 - COLLAPSED_PREVIEW_CHARS));
  });

  it('handles the host maximum of 8 KB', () => {
    const result = collapsePreview(longPreview(8192));
    expect(result.text).toHaveLength(COLLAPSED_PREVIEW_CHARS);
    expect(result.hiddenChars).toBe(8192 - COLLAPSED_PREVIEW_CHARS);
  });
});

describe('formatCost', () => {
  // `costUsd` is hard 0 and 0 means NOT COMPUTED. `$0.00` would assert the
  // session was free, which no code in this repo can support.
  it('renders 0 as an em-dash', () => {
    expect(formatCost(0)).toBe(EM_DASH);
  });

  it('never emits a currency symbol', () => {
    for (const value of [0, 1, 12.5, -3, Number.NaN]) {
      expect(formatCost(value)).not.toContain('$');
    }
  });

  it('renders a non-zero value with its declared unit and no conversion', () => {
    expect(formatCost(1.5)).toBe('1.50 USD');
  });
});

describe('formatTokens', () => {
  it('groups thousands', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1000)).toBe('1,000');
    expect(formatTokens(17_745)).toBe('17,745');
    expect(formatTokens(1_234_567)).toBe('1,234,567');
  });

  it('refuses non-finite input rather than printing NaN', () => {
    expect(formatTokens(Number.NaN)).toBe(EM_DASH);
  });
});

describe('formatDuration', () => {
  it('keeps sub-second durations in milliseconds', () => {
    expect(formatDuration(75)).toBe('75ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('switches to seconds and minutes', () => {
    expect(formatDuration(1_500)).toBe('1.5s');
    expect(formatDuration(59_900)).toBe('59.9s');
    expect(formatDuration(61_000)).toBe('1m 01s');
  });

  it('renders an unknown duration as an em-dash, not as zero', () => {
    expect(formatDuration(undefined)).toBe(EM_DASH);
  });
});

describe('degradedReasonText', () => {
  it('covers both reasons the host can send, and an absent one', () => {
    expect(degradedReasonText('noHookEvents')).toContain('hook events');
    expect(degradedReasonText('listenerDown')).toContain('listener');
    expect(degradedReasonText(undefined)).toContain('hook tap');
  });
});
