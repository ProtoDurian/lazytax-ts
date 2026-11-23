import { z } from '@lazytax/kernel';
import { definePlugin, invalidBinding } from '../domain/plugin';

export const STRAVA_KEY = 'strava';

// Strava's SportType values (developers.strava.com/docs/reference, read 2026-11-11).
const SPORT_TYPES = [
  'AlpineSki',
  'BackcountrySki',
  'Badminton',
  'Basketball',
  'Canoeing',
  'Cricket',
  'Crossfit',
  'Dance',
  'EBikeRide',
  'Elliptical',
  'EMountainBikeRide',
  'Golf',
  'GravelRide',
  'Handcycle',
  'HighIntensityIntervalTraining',
  'Hike',
  'IceSkate',
  'InlineSkate',
  'Kayaking',
  'Kitesurf',
  'MountainBikeRide',
  'NordicSki',
  'Padel',
  'PhysicalTherapy',
  'Pickleball',
  'Pilates',
  'Racquetball',
  'Ride',
  'RockClimbing',
  'RollerSki',
  'Rowing',
  'Run',
  'Sail',
  'Skateboard',
  'Snowboard',
  'Snowshoe',
  'Soccer',
  'Squash',
  'StairStepper',
  'StandUpPaddling',
  'Surfing',
  'Swim',
  'TableTennis',
  'Tennis',
  'TrailRun',
  'Velomobile',
  'VirtualRide',
  'VirtualRow',
  'VirtualRun',
  'Volleyball',
  'Walk',
  'WeightTraining',
  'Wheelchair',
  'Windsurf',
  'Workout',
  'Yoga',
] as const;

export interface ConnectionLookup {
  isConnected(userId: string): Promise<boolean>;
}

const Settings = z.strictObject({ sportTypes: z.array(z.string()).default([]) });
const Activity = z.object({ sportType: z.string().default(''), manual: z.boolean().default(false) });

// Completes a habit on a recorded Strava activity of a bound sport type, any length. Activities
// typed in by hand never count. Evidence carries the activity id only, no Strava data.
export const stravaPlugin = (connections: ConnectionLookup) =>
  definePlugin({
    manifest: {
      key: STRAVA_KEY,
      name: 'Strava',
      version: 1,
      platforms: ['ios', 'android'],
      minTier: 'pro',
      settingsSchema: JSON.stringify({
        type: 'object',
        properties: { sportTypes: { type: 'array', minItems: 1, items: { type: 'string', enum: SPORT_TYPES } } },
        required: ['sportTypes'],
        additionalProperties: false,
      }),
    },
    settings: Settings,
    payload: Activity,
    validate: (settings): Record<string, string[]> => {
      if (settings.sportTypes.length === 0) return { sportTypes: ['Pick at least one sport type'] };
      const unknown = settings.sportTypes.filter(t => !(SPORT_TYPES as readonly string[]).includes(t));
      return unknown.length > 0 ? { sportTypes: [`Unknown Strava sport type: ${unknown.join(', ')}`] } : {};
    },
    onBind: async binding => {
      if (!(await connections.isConnected(binding.userId)))
        throw invalidBinding({ pluginKey: ['Connect Strava before choosing it as proof'] });
    },
    evaluate: (settings, activity) =>
      !activity.manual && settings.sportTypes.includes(activity.sportType) ? { verdict: 'passed' } : null,
  });
