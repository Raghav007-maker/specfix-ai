import { describe, expect, it } from 'vitest';
import { safeAvatarUrl } from '../src/index.ts';

const own = 'abc.supabase.co';

describe('safeAvatarUrl', () => {
  it('keeps https photos from our storage, Google and GitHub', () => {
    for (const url of [
      'https://abc.supabase.co/storage/v1/object/public/avatars/u/1.png',
      'https://lh3.googleusercontent.com/a/xyz=s96-c',
      'https://avatars.githubusercontent.com/u/1?v=4',
    ]) {
      expect(safeAvatarUrl(url, own)).toBe(url);
    }
  });

  it('drops anything that could track or attack a viewer', () => {
    for (const url of [
      'http://lh3.googleusercontent.com/a/x',
      'https://evil.example/pixel.gif',
      'https://googleusercontent.com.evil.example/x',
      'https://user:pass@lh3.googleusercontent.com/x',
      'javascript:alert(1)',
      'data:image/svg+xml,<svg onload=alert(1)>',
      'https://other.supabase.co/x.png',
      'not a url',
      '',
      null,
    ]) {
      expect(safeAvatarUrl(url, own)).toBeNull();
    }
    expect(safeAvatarUrl('https://abc.supabase.co/x.png', null)).toBeNull();
  });
});
