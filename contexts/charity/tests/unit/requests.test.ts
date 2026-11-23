import { describe, expect, it } from 'bun:test';
import {
  CauseSearchReq,
  CharitySearchReq,
  CreateCauseReq,
  CreateCharityReq,
  SetCharityCausesReq,
  toRecord,
} from '../../src/api/v1/schemas';
import { toSearch } from '../../src/domain/charity-service';

const valid = { name: 'Room to Read' };

describe('CreateCharityReq', () => {
  it('should accept a name alone and fill the rest with nulls', () => {
    const rec = toRecord(CreateCharityReq.parse(valid));
    expect(rec).toEqual({
      name: 'Room to Read',
      slug: null,
      mission: null,
      countries: [],
      primaryRegistrationNumber: null,
      primaryRegistrationCountry: null,
      websiteUrl: null,
      logoUrl: null,
    });
  });

  it.each([
    ['an empty name', { name: '' }],
    ['a name over 256 characters', { name: 'x'.repeat(257) }],
    ['a slug over 128 characters', { ...valid, slug: 'x'.repeat(129) }],
    ['a mission over 8192 characters', { ...valid, mission: 'x'.repeat(8193) }],
    ['a country that is not 2 letters', { ...valid, countries: ['USA'] }],
    ['a blank country', { ...valid, countries: ['  '] }],
    ['a registration country that is not 2 letters', { ...valid, primaryRegistrationCountry: 'U' }],
    ['a website that is not a url', { ...valid, websiteUrl: 'not a url' }],
    ['a logo that is not a url', { ...valid, logoUrl: 'nope' }],
  ])('should refuse %s', (_label, body) => {
    expect(CreateCharityReq.safeParse(body).success).toBe(false);
  });
});

describe('search requests', () => {
  it('should read limit and skip from query text', () => {
    expect(CharitySearchReq.parse({ limit: '50', skip: '5' })).toMatchObject({ limit: 50, skip: 5 });
  });

  it.each([{ limit: '101' }, { limit: '-1' }, { skip: '-1' }, { country: 'USA' }])(
    'should refuse %p in a charity search',
    q => {
      expect(CharitySearchReq.safeParse(q).success).toBe(false);
    },
  );

  it('should default limit to 20 and skip to 0, and cap limit at 100', () => {
    expect(toSearch({})).toMatchObject({ limit: 20, skip: 0 });
    expect(toSearch({ limit: 500, skip: -3 })).toMatchObject({ limit: 100, skip: 0 });
  });
});

describe('cause requests', () => {
  it('should need a key and a name', () => {
    expect(CreateCauseReq.safeParse({ key: '', name: 'x' }).success).toBe(false);
    expect(CreateCauseReq.safeParse({ key: 'k'.repeat(129), name: 'x' }).success).toBe(false);
    expect(CreateCauseReq.safeParse({ key: 'k', name: '' }).success).toBe(false);
    expect(CreateCauseReq.safeParse({ key: 'k', name: 'x' }).success).toBe(true);
  });

  it('should refuse a missing key list when setting causes', () => {
    expect(SetCharityCausesReq.safeParse({}).success).toBe(false);
    expect(SetCharityCausesReq.safeParse({ keys: ['1', ''] }).success).toBe(false);
    expect(SetCharityCausesReq.safeParse({ keys: [] }).success).toBe(true);
  });
});

describe('cause search request', () => {
  it.each([{ limit: '101' }, { skip: '-1' }])('should refuse %p', q => {
    expect(CauseSearchReq.safeParse(q).success).toBe(false);
  });
});
