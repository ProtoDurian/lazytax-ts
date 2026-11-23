// Request schemas (LazyTax CharityValidator / CauseValidator) and response mappers.
import { z } from '@lazytax/kernel';
import type { CharityRecord } from '../../domain/model';

const validUrl = (s: string) => {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
};

const name = z
  .string()
  .min(1, 'Name has to be between 1 to 256 characters')
  .max(256, 'Name has to be between 1 to 256 characters');
const url = z.string().max(512).refine(validUrl, 'Url is invalid').nullish();
const country = z
  .string()
  .length(2, 'Each country must be an ISO alpha-2 code')
  .refine(s => s.trim() !== '', 'Each country must be an ISO alpha-2 code');

const charityFields = {
  name,
  slug: z.string().max(128).nullish(),
  mission: z.string().max(8192).nullish(),
  countries: z.array(country).nullish(),
  primaryRegistrationNumber: z.string().max(128).nullish(),
  primaryRegistrationCountry: z.string().length(2).nullish(),
  websiteUrl: url,
  logoUrl: url,
};

export const CreateCharityReq = z.object(charityFields);
export const UpdateCharityReq = z.object(charityFields);
export type CharityReq = z.output<typeof CreateCharityReq>;

// Query strings: numbers arrive as text.
const limit = z.coerce
  .number()
  .int()
  .min(0, 'Limit has to be between 0 to 100')
  .max(100, 'Limit has to be between 0 to 100');
const skip = z.coerce.number().int().min(0, 'Skip has to be larger than or equal to 0');

export const CharitySearchReq = z.object({
  name: z.string().optional(),
  slug: z.string().optional(),
  country: z.string().length(2).optional(),
  primaryRegistrationNumber: z.string().optional(),
  primaryRegistrationCountry: z.string().length(2).optional(),
  causeKey: z.string().optional(),
  limit: limit.optional(),
  skip: skip.optional(),
});

export const SetCharityCausesReq = z.object({ keys: z.array(z.string().min(1).max(128)) });

export const CreateCauseReq = z.object({ key: z.string().min(1).max(128), name });
export const UpdateCauseReq = z.object({ name });
export const CauseSearchReq = z.object({
  key: z.string().max(128).optional(),
  name: z.string().max(256).optional(),
  limit: limit.optional(),
  skip: skip.optional(),
});

export const toRecord = (r: CharityReq): CharityRecord => ({
  name: r.name,
  slug: r.slug ?? null,
  mission: r.mission ?? null,
  countries: r.countries ?? [],
  primaryRegistrationNumber: r.primaryRegistrationNumber ?? null,
  primaryRegistrationCountry: r.primaryRegistrationCountry ?? null,
  websiteUrl: r.websiteUrl ?? null,
  logoUrl: r.logoUrl ?? null,
});

export const withPrincipal = <T>(principal: T) => ({ principal });

// GET by id answers { principal } (LazyTax CharityRes / CauseRes); the list and the writes answer the principal itself.
