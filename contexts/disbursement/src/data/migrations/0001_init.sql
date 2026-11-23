-- One row per payout attempt to a single (charity, currency). The id doubles as the reference
-- stored at Pledge (donation metadata), so a crash-and-retry reconciles the same donation
-- instead of minting a second one. No user_id: a payout sums many users' penalties.
CREATE TABLE disbursement.disbursements (
  id uuid PRIMARY KEY,
  charity_id uuid NOT NULL,
  currency varchar(8) NOT NULL,
  amount_cents bigint NOT NULL,
  -- 0 pending, 1 completed, 2 failed
  status smallint NOT NULL,
  pledge_organization_id varchar(256) NOT NULL,
  provider_donation_id varchar(256),
  attempts integer NOT NULL DEFAULT 0,
  last_error varchar(2048),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX disbursements_status_updated ON disbursement.disbursements (status, updated_at);
CREATE INDEX disbursements_charity ON disbursement.disbursements (charity_id);
