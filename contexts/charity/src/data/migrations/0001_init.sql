-- The charity catalogue is global data: no row belongs to a user, so there is no user_id here.
CREATE TABLE charity.charities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(256) NOT NULL,
  slug varchar(128),
  mission varchar(8192),
  countries text[] NOT NULL DEFAULT '{}',
  primary_registration_number varchar(128),
  primary_registration_country varchar(2),
  website_url varchar(512),
  logo_url varchar(512)
);
CREATE INDEX charities_name ON charity.charities (name);
CREATE INDEX charities_registration ON charity.charities (primary_registration_country, primary_registration_number);
CREATE INDEX charities_countries ON charity.charities USING gin (countries);

CREATE TABLE charity.causes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key varchar(128) NOT NULL,
  name varchar(256) NOT NULL,
  CONSTRAINT causes_key_unique UNIQUE (key)
);

CREATE TABLE charity.charity_causes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charity_id uuid NOT NULL REFERENCES charity.charities (id) ON DELETE CASCADE,
  cause_id uuid NOT NULL REFERENCES charity.causes (id) ON DELETE CASCADE,
  CONSTRAINT charity_causes_unique UNIQUE (charity_id, cause_id)
);
CREATE INDEX charity_causes_cause ON charity.charity_causes (cause_id);

CREATE TABLE charity.external_ids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charity_id uuid NOT NULL REFERENCES charity.charities (id) ON DELETE CASCADE,
  source varchar(64) NOT NULL,
  external_key varchar(256) NOT NULL,
  url varchar(2048),
  payload text,
  last_synced_at timestamptz,
  CONSTRAINT external_ids_unique UNIQUE (source, external_key)
);
CREATE INDEX external_ids_charity ON charity.external_ids (charity_id);
