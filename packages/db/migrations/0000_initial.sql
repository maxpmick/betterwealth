CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`connection_id` text,
	`institution_id` text,
	`external_id` text,
	`name` text NOT NULL,
	`official_name` text,
	`mask` text,
	`group` text NOT NULL,
	`type` text NOT NULL,
	`subtype` text,
	`currency` text NOT NULL,
	`ownership` text DEFAULT 'household' NOT NULL,
	`owner_user_id` text,
	`include_in_net_worth` integer DEFAULT true NOT NULL,
	`include_in_budget` integer DEFAULT true NOT NULL,
	`is_liability` integer DEFAULT false NOT NULL,
	`is_manual` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`provider_metadata` text,
	`last_reconciled_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`household_id`,`connection_id`) REFERENCES `connections`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`household_id`,`institution_id`) REFERENCES `provider_institutions`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "accounts_group_ck" CHECK("accounts"."group" IN ('cash', 'credit', 'loan', 'investment', 'property', 'vehicle', 'crypto', 'rewards', 'custom')),
	CONSTRAINT "accounts_currency_ck" CHECK(length("accounts"."currency") = 3 AND "accounts"."currency" = upper("accounts"."currency") AND "accounts"."currency" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "accounts_ownership_ck" CHECK("accounts"."ownership" IN ('individual', 'joint', 'household', 'business')),
	CONSTRAINT "accounts_status_ck" CHECK("accounts"."status" IN ('active', 'closed', 'hidden', 'stale'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_household_id_id_uq` ON `accounts` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_connection_external_uq` ON `accounts` (`connection_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `accounts_household_group_status_idx` ON `accounts` (`household_id`,`group`,`status`);--> statement-breakpoint
CREATE INDEX `accounts_household_institution_idx` ON `accounts` (`household_id`,`institution_id`);--> statement-breakpoint
CREATE INDEX `accounts_owner_idx` ON `accounts` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `ai_suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`input_fingerprint` text NOT NULL,
	`suggested_merchant_name` text,
	`suggested_merchant_id` text,
	`suggested_category_id` text,
	`proposed_rule` text,
	`confidence_bps` integer NOT NULL,
	`rationale` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`model` text NOT NULL,
	`reviewed_by_user_id` text,
	`reviewed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`household_id`,`transaction_id`) REFERENCES `transactions`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`suggested_merchant_id`) REFERENCES `merchants`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`household_id`,`suggested_category_id`) REFERENCES `categories`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ai_suggestions_confidence_ck" CHECK("ai_suggestions"."confidence_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "ai_suggestions_status_ck" CHECK("ai_suggestions"."status" IN ('pending', 'accepted', 'rejected', 'expired', 'invalid'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_suggestions_household_id_id_uq` ON `ai_suggestions` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ai_suggestions_transaction_fingerprint_uq` ON `ai_suggestions` (`transaction_id`,`input_fingerprint`);--> statement-breakpoint
CREATE INDEX `ai_suggestions_household_status_created_idx` ON `ai_suggestions` (`household_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `allocation_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`budget_period_id` text,
	`batch_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`from_bucket_type` text NOT NULL,
	`from_bucket_id` text,
	`to_bucket_type` text NOT NULL,
	`to_bucket_id` text,
	`amount` text NOT NULL,
	`currency` text NOT NULL,
	`kind` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text,
	`memo` text,
	`reversal_of_id` text,
	`created_by_user_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reversal_of_id`) REFERENCES `allocation_entries`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`household_id`,`budget_period_id`) REFERENCES `budget_periods`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "allocation_entries_bucket_types_ck" CHECK("allocation_entries"."from_bucket_type" IN ('external', 'unassigned', 'envelope', 'goal', 'debt', 'investing', 'released') AND "allocation_entries"."to_bucket_type" IN ('external', 'unassigned', 'envelope', 'goal', 'debt', 'investing', 'released')),
	CONSTRAINT "allocation_entries_distinct_buckets_ck" CHECK("allocation_entries"."from_bucket_type" <> "allocation_entries"."to_bucket_type" OR coalesce("allocation_entries"."from_bucket_id", '') <> coalesce("allocation_entries"."to_bucket_id", '')),
	CONSTRAINT "allocation_entries_amount_positive_ck" CHECK(CAST("allocation_entries"."amount" AS INTEGER) > 0),
	CONSTRAINT "allocation_entries_currency_ck" CHECK(length("allocation_entries"."currency") = 3 AND "allocation_entries"."currency" = upper("allocation_entries"."currency") AND "allocation_entries"."currency" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "allocation_entries_kind_ck" CHECK("allocation_entries"."kind" IN ('fund', 'reserve', 'transfer', 'release', 'contribution', 'adjustment')),
	CONSTRAINT "allocation_entries_amount_minor_units_ck" CHECK((
    "allocation_entries"."amount" = '0'
    OR (
      "allocation_entries"."amount" GLOB '[1-9]*'
      AND "allocation_entries"."amount" NOT GLOB '*[^0-9]*'
      AND (length("allocation_entries"."amount") < 19 OR (length("allocation_entries"."amount") = 19 AND "allocation_entries"."amount" <= '9223372036854775807'))
    )
    OR (
      "allocation_entries"."amount" GLOB '-[1-9]*'
      AND substr("allocation_entries"."amount", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("allocation_entries"."amount", 2)) < 19
        OR (length(substr("allocation_entries"."amount", 2)) = 19 AND substr("allocation_entries"."amount", 2) <= '9223372036854775808')
      )
    )
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `allocation_entries_household_id_id_uq` ON `allocation_entries` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `allocation_entries_batch_sequence_uq` ON `allocation_entries` (`batch_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `allocation_entries_reversal_uq` ON `allocation_entries` (`reversal_of_id`);--> statement-breakpoint
CREATE INDEX `allocation_entries_household_period_created_idx` ON `allocation_entries` (`household_id`,`budget_period_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `allocation_entries_household_from_bucket_idx` ON `allocation_entries` (`household_id`,`from_bucket_type`,`from_bucket_id`);--> statement-breakpoint
CREATE INDEX `allocation_entries_household_to_bucket_idx` ON `allocation_entries` (`household_id`,`to_bucket_type`,`to_bucket_id`);--> statement-breakpoint
CREATE TABLE `asset_valuations` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`amount` text NOT NULL,
	`currency` text NOT NULL,
	`valued_on` text NOT NULL,
	`source` text NOT NULL,
	`confidence_bps` integer DEFAULT 10000 NOT NULL,
	`provider_reference` text,
	`metadata` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`asset_id`) REFERENCES `assets`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "asset_valuations_amount_nonnegative_ck" CHECK(CAST("asset_valuations"."amount" AS INTEGER) >= 0),
	CONSTRAINT "asset_valuations_currency_ck" CHECK(length("asset_valuations"."currency") = 3 AND "asset_valuations"."currency" = upper("asset_valuations"."currency") AND "asset_valuations"."currency" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "asset_valuations_source_ck" CHECK("asset_valuations"."source" IN ('manual', 'provider', 'appraisal', 'import')),
	CONSTRAINT "asset_valuations_confidence_ck" CHECK("asset_valuations"."confidence_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "asset_valuations_amount_minor_units_ck" CHECK((
    "asset_valuations"."amount" = '0'
    OR (
      "asset_valuations"."amount" GLOB '[1-9]*'
      AND "asset_valuations"."amount" NOT GLOB '*[^0-9]*'
      AND (length("asset_valuations"."amount") < 19 OR (length("asset_valuations"."amount") = 19 AND "asset_valuations"."amount" <= '9223372036854775807'))
    )
    OR (
      "asset_valuations"."amount" GLOB '-[1-9]*'
      AND substr("asset_valuations"."amount", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("asset_valuations"."amount", 2)) < 19
        OR (length(substr("asset_valuations"."amount", 2)) = 19 AND substr("asset_valuations"."amount", 2) <= '9223372036854775808')
      )
    )
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_valuations_household_id_id_uq` ON `asset_valuations` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `asset_valuations_asset_date_source_uq` ON `asset_valuations` (`asset_id`,`valued_on`,`source`);--> statement-breakpoint
CREATE INDEX `asset_valuations_household_asset_date_idx` ON `asset_valuations` (`household_id`,`asset_id`,`valued_on`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`liquidity_class` text DEFAULT 'illiquid' NOT NULL,
	`currency` text NOT NULL,
	`linked_liability_account_id` text,
	`owner_user_id` text,
	`metadata` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`household_id`,`linked_liability_account_id`) REFERENCES `accounts`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "assets_type_ck" CHECK("assets"."type" IN ('property', 'vehicle', 'collectible', 'business', 'custom')),
	CONSTRAINT "assets_liquidity_class_ck" CHECK("assets"."liquidity_class" IN ('illiquid', 'restricted', 'liquid')),
	CONSTRAINT "assets_currency_ck" CHECK(length("assets"."currency") = 3 AND "assets"."currency" = upper("assets"."currency") AND "assets"."currency" NOT GLOB '*[^A-Z]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_household_id_id_uq` ON `assets` (`household_id`,`id`);--> statement-breakpoint
CREATE INDEX `assets_household_type_active_idx` ON `assets` (`household_id`,`type`,`is_active`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`transaction_id` text,
	`uploaded_by_user_id` text,
	`object_path` text NOT NULL,
	`original_filename` text NOT NULL,
	`content_hash` text NOT NULL,
	`media_type` text NOT NULL,
	`byte_length` integer NOT NULL,
	`is_encrypted` integer DEFAULT true NOT NULL,
	`encryption_key_version` integer,
	`metadata` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`household_id`,`transaction_id`) REFERENCES `transactions`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "attachments_byte_length_ck" CHECK("attachments"."byte_length" >= 0),
	CONSTRAINT "attachments_encryption_key_ck" CHECK("attachments"."is_encrypted" = 0 OR ("attachments"."encryption_key_version" IS NOT NULL AND "attachments"."encryption_key_version" > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_household_id_id_uq` ON `attachments` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_household_content_hash_uq` ON `attachments` (`household_id`,`content_hash`);--> statement-breakpoint
CREATE INDEX `attachments_household_transaction_idx` ON `attachments` (`household_id`,`transaction_id`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`actor_user_id` text,
	`actor_type` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`request_id` text,
	`ip_address` text,
	`metadata` text NOT NULL,
	`occurred_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "audit_events_actor_type_ck" CHECK("audit_events"."actor_type" IN ('user', 'system', 'job', 'token'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_household_id_id_uq` ON `audit_events` (`household_id`,`id`);--> statement-breakpoint
CREATE INDEX `audit_events_household_time_idx` ON `audit_events` (`household_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `audit_events_household_entity_idx` ON `audit_events` (`household_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_events_actor_time_idx` ON `audit_events` (`actor_user_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `balance_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`account_id` text NOT NULL,
	`ledger_balance` text NOT NULL,
	`current_balance` text NOT NULL,
	`available_balance` text,
	`currency` text NOT NULL,
	`as_of` text NOT NULL,
	`source` text NOT NULL,
	`sync_run_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`account_id`) REFERENCES `accounts`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`sync_run_id`) REFERENCES `sync_runs`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "balance_snapshots_currency_ck" CHECK(length("balance_snapshots"."currency") = 3 AND "balance_snapshots"."currency" = upper("balance_snapshots"."currency") AND "balance_snapshots"."currency" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "balance_snapshots_source_ck" CHECK("balance_snapshots"."source" IN ('provider', 'manual', 'reconciliation', 'import')),
	CONSTRAINT "balance_snapshots_ledger_minor_units_ck" CHECK((
    "balance_snapshots"."ledger_balance" = '0'
    OR (
      "balance_snapshots"."ledger_balance" GLOB '[1-9]*'
      AND "balance_snapshots"."ledger_balance" NOT GLOB '*[^0-9]*'
      AND (length("balance_snapshots"."ledger_balance") < 19 OR (length("balance_snapshots"."ledger_balance") = 19 AND "balance_snapshots"."ledger_balance" <= '9223372036854775807'))
    )
    OR (
      "balance_snapshots"."ledger_balance" GLOB '-[1-9]*'
      AND substr("balance_snapshots"."ledger_balance", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("balance_snapshots"."ledger_balance", 2)) < 19
        OR (length(substr("balance_snapshots"."ledger_balance", 2)) = 19 AND substr("balance_snapshots"."ledger_balance", 2) <= '9223372036854775808')
      )
    )
  )),
	CONSTRAINT "balance_snapshots_current_minor_units_ck" CHECK((
    "balance_snapshots"."current_balance" = '0'
    OR (
      "balance_snapshots"."current_balance" GLOB '[1-9]*'
      AND "balance_snapshots"."current_balance" NOT GLOB '*[^0-9]*'
      AND (length("balance_snapshots"."current_balance") < 19 OR (length("balance_snapshots"."current_balance") = 19 AND "balance_snapshots"."current_balance" <= '9223372036854775807'))
    )
    OR (
      "balance_snapshots"."current_balance" GLOB '-[1-9]*'
      AND substr("balance_snapshots"."current_balance", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("balance_snapshots"."current_balance", 2)) < 19
        OR (length(substr("balance_snapshots"."current_balance", 2)) = 19 AND substr("balance_snapshots"."current_balance", 2) <= '9223372036854775808')
      )
    )
  )),
	CONSTRAINT "balance_snapshots_available_minor_units_ck" CHECK((
    "balance_snapshots"."available_balance" = '0'
    OR (
      "balance_snapshots"."available_balance" GLOB '[1-9]*'
      AND "balance_snapshots"."available_balance" NOT GLOB '*[^0-9]*'
      AND (length("balance_snapshots"."available_balance") < 19 OR (length("balance_snapshots"."available_balance") = 19 AND "balance_snapshots"."available_balance" <= '9223372036854775807'))
    )
    OR (
      "balance_snapshots"."available_balance" GLOB '-[1-9]*'
      AND substr("balance_snapshots"."available_balance", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("balance_snapshots"."available_balance", 2)) < 19
        OR (length(substr("balance_snapshots"."available_balance", 2)) = 19 AND substr("balance_snapshots"."available_balance", 2) <= '9223372036854775808')
      )
    )
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balance_snapshots_household_id_id_uq` ON `balance_snapshots` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `balance_snapshots_account_asof_source_uq` ON `balance_snapshots` (`account_id`,`as_of`,`source`);--> statement-breakpoint
CREATE INDEX `balance_snapshots_household_account_asof_idx` ON `balance_snapshots` (`household_id`,`account_id`,`as_of`);--> statement-breakpoint
CREATE TABLE `bills` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`recurring_series_id` text,
	`envelope_id` text,
	`autopay_account_id` text,
	`due_rule` text NOT NULL,
	`amount_min` text NOT NULL,
	`amount_max` text NOT NULL,
	`currency` text NOT NULL,
	`recurrence_confidence_bps` integer DEFAULT 0 NOT NULL,
	`next_due_date` text,
	`is_required` integer DEFAULT true NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`recurring_series_id`) REFERENCES `recurring_series`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`household_id`,`envelope_id`) REFERENCES `envelopes`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`household_id`,`autopay_account_id`) REFERENCES `accounts`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "bills_amount_order_ck" CHECK(CAST("bills"."amount_min" AS INTEGER) <= CAST("bills"."amount_max" AS INTEGER)),
	CONSTRAINT "bills_currency_ck" CHECK(length("bills"."currency") = 3 AND "bills"."currency" = upper("bills"."currency") AND "bills"."currency" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "bills_confidence_ck" CHECK("bills"."recurrence_confidence_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "bills_min_minor_units_ck" CHECK((
    "bills"."amount_min" = '0'
    OR (
      "bills"."amount_min" GLOB '[1-9]*'
      AND "bills"."amount_min" NOT GLOB '*[^0-9]*'
      AND (length("bills"."amount_min") < 19 OR (length("bills"."amount_min") = 19 AND "bills"."amount_min" <= '9223372036854775807'))
    )
    OR (
      "bills"."amount_min" GLOB '-[1-9]*'
      AND substr("bills"."amount_min", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("bills"."amount_min", 2)) < 19
        OR (length(substr("bills"."amount_min", 2)) = 19 AND substr("bills"."amount_min", 2) <= '9223372036854775808')
      )
    )
  )),
	CONSTRAINT "bills_max_minor_units_ck" CHECK((
    "bills"."amount_max" = '0'
    OR (
      "bills"."amount_max" GLOB '[1-9]*'
      AND "bills"."amount_max" NOT GLOB '*[^0-9]*'
      AND (length("bills"."amount_max") < 19 OR (length("bills"."amount_max") = 19 AND "bills"."amount_max" <= '9223372036854775807'))
    )
    OR (
      "bills"."amount_max" GLOB '-[1-9]*'
      AND substr("bills"."amount_max", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("bills"."amount_max", 2)) < 19
        OR (length(substr("bills"."amount_max", 2)) = 19 AND substr("bills"."amount_max", 2) <= '9223372036854775808')
      )
    )
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bills_household_id_id_uq` ON `bills` (`household_id`,`id`);--> statement-breakpoint
CREATE INDEX `bills_household_next_active_idx` ON `bills` (`household_id`,`next_due_date`,`is_active`);--> statement-breakpoint
CREATE TABLE `budget_periods` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`pay_cycle_id` text,
	`kind` text NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text NOT NULL,
	`currency` text NOT NULL,
	`expected_income` text DEFAULT '0' NOT NULL,
	`actual_income` text DEFAULT '0' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`closed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`pay_cycle_id`) REFERENCES `pay_cycles`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "budget_periods_kind_ck" CHECK("budget_periods"."kind" IN ('month', 'pay_cycle', 'custom')),
	CONSTRAINT "budget_periods_dates_ck" CHECK("budget_periods"."starts_on" <= "budget_periods"."ends_on"),
	CONSTRAINT "budget_periods_currency_ck" CHECK(length("budget_periods"."currency") = 3 AND "budget_periods"."currency" = upper("budget_periods"."currency") AND "budget_periods"."currency" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "budget_periods_status_ck" CHECK("budget_periods"."status" IN ('draft', 'open', 'closed', 'archived')),
	CONSTRAINT "budget_periods_expected_minor_units_ck" CHECK((
    "budget_periods"."expected_income" = '0'
    OR (
      "budget_periods"."expected_income" GLOB '[1-9]*'
      AND "budget_periods"."expected_income" NOT GLOB '*[^0-9]*'
      AND (length("budget_periods"."expected_income") < 19 OR (length("budget_periods"."expected_income") = 19 AND "budget_periods"."expected_income" <= '9223372036854775807'))
    )
    OR (
      "budget_periods"."expected_income" GLOB '-[1-9]*'
      AND substr("budget_periods"."expected_income", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("budget_periods"."expected_income", 2)) < 19
        OR (length(substr("budget_periods"."expected_income", 2)) = 19 AND substr("budget_periods"."expected_income", 2) <= '9223372036854775808')
      )
    )
  )),
	CONSTRAINT "budget_periods_actual_minor_units_ck" CHECK((
    "budget_periods"."actual_income" = '0'
    OR (
      "budget_periods"."actual_income" GLOB '[1-9]*'
      AND "budget_periods"."actual_income" NOT GLOB '*[^0-9]*'
      AND (length("budget_periods"."actual_income") < 19 OR (length("budget_periods"."actual_income") = 19 AND "budget_periods"."actual_income" <= '9223372036854775807'))
    )
    OR (
      "budget_periods"."actual_income" GLOB '-[1-9]*'
      AND substr("budget_periods"."actual_income", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("budget_periods"."actual_income", 2)) < 19
        OR (length(substr("budget_periods"."actual_income", 2)) = 19 AND substr("budget_periods"."actual_income", 2) <= '9223372036854775808')
      )
    )
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budget_periods_household_id_id_uq` ON `budget_periods` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `budget_periods_household_kind_dates_uq` ON `budget_periods` (`household_id`,`kind`,`starts_on`,`ends_on`);--> statement-breakpoint
CREATE INDEX `budget_periods_household_status_dates_idx` ON `budget_periods` (`household_id`,`status`,`starts_on`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`kind` text NOT NULL,
	`color` text,
	`icon` text,
	`is_active` integer DEFAULT true NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "categories_kind_ck" CHECK("categories"."kind" IN ('income', 'expense', 'transfer', 'debt', 'investment')),
	CONSTRAINT "categories_not_self_parent_ck" CHECK("categories"."parent_id" IS NULL OR "categories"."parent_id" <> "categories"."id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_household_id_id_uq` ON `categories` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `categories_household_slug_uq` ON `categories` (`household_id`,`slug`);--> statement-breakpoint
CREATE INDEX `categories_household_parent_sort_idx` ON `categories` (`household_id`,`parent_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`provider` text NOT NULL,
	`display_name` text NOT NULL,
	`credentials_ciphertext` blob NOT NULL,
	`credentials_nonce` blob NOT NULL,
	`credentials_auth_tag` blob NOT NULL,
	`credentials_key_version` text NOT NULL,
	`credentials_aad` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`capabilities` text NOT NULL,
	`sync_cursor` text,
	`last_attempt_at` text,
	`last_success_at` text,
	`last_error_code` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "connections_key_version_ck" CHECK(length("connections"."credentials_key_version") > 0),
	CONSTRAINT "connections_status_ck" CHECK("connections"."status" IN ('active', 'degraded', 'reauth_required', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connections_household_id_id_uq` ON `connections` (`household_id`,`id`);--> statement-breakpoint
CREATE INDEX `connections_household_provider_status_idx` ON `connections` (`household_id`,`provider`,`status`);--> statement-breakpoint
CREATE INDEX `connections_owner_idx` ON `connections` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `envelope_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`budget_period_id` text NOT NULL,
	`envelope_id` text NOT NULL,
	`planned` text DEFAULT '0' NOT NULL,
	`funded` text DEFAULT '0' NOT NULL,
	`activity` text DEFAULT '0' NOT NULL,
	`transferred_in` text DEFAULT '0' NOT NULL,
	`transferred_out` text DEFAULT '0' NOT NULL,
	`available_snapshot` text DEFAULT '0' NOT NULL,
	`currency` text NOT NULL,
	`calculated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`budget_period_id`) REFERENCES `budget_periods`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`envelope_id`) REFERENCES `envelopes`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "envelope_allocations_currency_ck" CHECK(length("envelope_allocations"."currency") = 3 AND "envelope_allocations"."currency" = upper("envelope_allocations"."currency") AND "envelope_allocations"."currency" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "envelope_allocations_planned_minor_units_ck" CHECK((
    "envelope_allocations"."planned" = '0'
    OR (
      "envelope_allocations"."planned" GLOB '[1-9]*'
      AND "envelope_allocations"."planned" NOT GLOB '*[^0-9]*'
      AND (length("envelope_allocations"."planned") < 19 OR (length("envelope_allocations"."planned") = 19 AND "envelope_allocations"."planned" <= '9223372036854775807'))
    )
    OR (
      "envelope_allocations"."planned" GLOB '-[1-9]*'
      AND substr("envelope_allocations"."planned", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("envelope_allocations"."planned", 2)) < 19
        OR (length(substr("envelope_allocations"."planned", 2)) = 19 AND substr("envelope_allocations"."planned", 2) <= '9223372036854775808')
      )
    )
  )),
	CONSTRAINT "envelope_allocations_funded_minor_units_ck" CHECK((
    "envelope_allocations"."funded" = '0'
    OR (
      "envelope_allocations"."funded" GLOB '[1-9]*'
      AND "envelope_allocations"."funded" NOT GLOB '*[^0-9]*'
      AND (length("envelope_allocations"."funded") < 19 OR (length("envelope_allocations"."funded") = 19 AND "envelope_allocations"."funded" <= '9223372036854775807'))
    )
    OR (
      "envelope_allocations"."funded" GLOB '-[1-9]*'
      AND substr("envelope_allocations"."funded", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("envelope_allocations"."funded", 2)) < 19
        OR (length(substr("envelope_allocations"."funded", 2)) = 19 AND substr("envelope_allocations"."funded", 2) <= '9223372036854775808')
      )
    )
  )),
	CONSTRAINT "envelope_allocations_activity_minor_units_ck" CHECK((
    "envelope_allocations"."activity" = '0'
    OR (
      "envelope_allocations"."activity" GLOB '[1-9]*'
      AND "envelope_allocations"."activity" NOT GLOB '*[^0-9]*'
      AND (length("envelope_allocations"."activity") < 19 OR (length("envelope_allocations"."activity") = 19 AND "envelope_allocations"."activity" <= '9223372036854775807'))
    )
    OR (
      "envelope_allocations"."activity" GLOB '-[1-9]*'
      AND substr("envelope_allocations"."activity", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("envelope_allocations"."activity", 2)) < 19
        OR (length(substr("envelope_allocations"."activity", 2)) = 19 AND substr("envelope_allocations"."activity", 2) <= '9223372036854775808')
      )
    )
  )),
	CONSTRAINT "envelope_allocations_transferred_in_minor_units_ck" CHECK((
    "envelope_allocations"."transferred_in" = '0'
    OR (
      "envelope_allocations"."transferred_in" GLOB '[1-9]*'
      AND "envelope_allocations"."transferred_in" NOT GLOB '*[^0-9]*'
      AND (length("envelope_allocations"."transferred_in") < 19 OR (length("envelope_allocations"."transferred_in") = 19 AND "envelope_allocations"."transferred_in" <= '9223372036854775807'))
    )
    OR (
      "envelope_allocations"."transferred_in" GLOB '-[1-9]*'
      AND substr("envelope_allocations"."transferred_in", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("envelope_allocations"."transferred_in", 2)) < 19
        OR (length(substr("envelope_allocations"."transferred_in", 2)) = 19 AND substr("envelope_allocations"."transferred_in", 2) <= '9223372036854775808')
      )
    )
  )),
	CONSTRAINT "envelope_allocations_transferred_out_minor_units_ck" CHECK((
    "envelope_allocations"."transferred_out" = '0'
    OR (
      "envelope_allocations"."transferred_out" GLOB '[1-9]*'
      AND "envelope_allocations"."transferred_out" NOT GLOB '*[^0-9]*'
      AND (length("envelope_allocations"."transferred_out") < 19 OR (length("envelope_allocations"."transferred_out") = 19 AND "envelope_allocations"."transferred_out" <= '9223372036854775807'))
    )
    OR (
      "envelope_allocations"."transferred_out" GLOB '-[1-9]*'
      AND substr("envelope_allocations"."transferred_out", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("envelope_allocations"."transferred_out", 2)) < 19
        OR (length(substr("envelope_allocations"."transferred_out", 2)) = 19 AND substr("envelope_allocations"."transferred_out", 2) <= '9223372036854775808')
      )
    )
  )),
	CONSTRAINT "envelope_allocations_available_minor_units_ck" CHECK((
    "envelope_allocations"."available_snapshot" = '0'
    OR (
      "envelope_allocations"."available_snapshot" GLOB '[1-9]*'
      AND "envelope_allocations"."available_snapshot" NOT GLOB '*[^0-9]*'
      AND (length("envelope_allocations"."available_snapshot") < 19 OR (length("envelope_allocations"."available_snapshot") = 19 AND "envelope_allocations"."available_snapshot" <= '9223372036854775807'))
    )
    OR (
      "envelope_allocations"."available_snapshot" GLOB '-[1-9]*'
      AND substr("envelope_allocations"."available_snapshot", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("envelope_allocations"."available_snapshot", 2)) < 19
        OR (length(substr("envelope_allocations"."available_snapshot", 2)) = 19 AND substr("envelope_allocations"."available_snapshot", 2) <= '9223372036854775808')
      )
    )
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `envelope_allocations_household_id_id_uq` ON `envelope_allocations` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `envelope_allocations_period_envelope_uq` ON `envelope_allocations` (`budget_period_id`,`envelope_id`);--> statement-breakpoint
CREATE INDEX `envelope_allocations_household_period_idx` ON `envelope_allocations` (`household_id`,`budget_period_id`);--> statement-breakpoint
CREATE TABLE `envelope_category_links` (
	`household_id` text NOT NULL,
	`envelope_id` text NOT NULL,
	`category_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`household_id`, `envelope_id`, `category_id`),
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`envelope_id`) REFERENCES `envelopes`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`category_id`) REFERENCES `categories`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `envelope_category_links_category_idx` ON `envelope_category_links` (`household_id`,`category_id`);--> statement-breakpoint
CREATE TABLE `envelope_rule_links` (
	`household_id` text NOT NULL,
	`envelope_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`household_id`, `envelope_id`, `rule_id`),
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`envelope_id`) REFERENCES `envelopes`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`rule_id`) REFERENCES `rules`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `envelope_rule_links_rule_idx` ON `envelope_rule_links` (`household_id`,`rule_id`);--> statement-breakpoint
CREATE TABLE `envelopes` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`parent_id` text,
	`category_id` text,
	`name` text NOT NULL,
	`cadence` text NOT NULL,
	`cadence_config` text,
	`rollover_policy` text DEFAULT 'positive' NOT NULL,
	`rollover_cap` text,
	`priority` integer DEFAULT 100 NOT NULL,
	`minimum_amount` text DEFAULT '0' NOT NULL,
	`target_amount` text DEFAULT '0' NOT NULL,
	`currency` text NOT NULL,
	`is_required` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `envelopes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`household_id`,`category_id`) REFERENCES `categories`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "envelopes_not_self_parent_ck" CHECK("envelopes"."parent_id" IS NULL OR "envelopes"."parent_id" <> "envelopes"."id"),
	CONSTRAINT "envelopes_rollover_policy_ck" CHECK("envelopes"."rollover_policy" IN ('none', 'positive', 'all', 'cap')),
	CONSTRAINT "envelopes_rollover_cap_ck" CHECK("envelopes"."rollover_policy" <> 'cap' OR "envelopes"."rollover_cap" IS NOT NULL),
	CONSTRAINT "envelopes_currency_ck" CHECK(length("envelopes"."currency") = 3 AND "envelopes"."currency" = upper("envelopes"."currency") AND "envelopes"."currency" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "envelopes_rollover_cap_minor_units_ck" CHECK((
    "envelopes"."rollover_cap" = '0'
    OR (
      "envelopes"."rollover_cap" GLOB '[1-9]*'
      AND "envelopes"."rollover_cap" NOT GLOB '*[^0-9]*'
      AND (length("envelopes"."rollover_cap") < 19 OR (length("envelopes"."rollover_cap") = 19 AND "envelopes"."rollover_cap" <= '9223372036854775807'))
    )
    OR (
      "envelopes"."rollover_cap" GLOB '-[1-9]*'
      AND substr("envelopes"."rollover_cap", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("envelopes"."rollover_cap", 2)) < 19
        OR (length(substr("envelopes"."rollover_cap", 2)) = 19 AND substr("envelopes"."rollover_cap", 2) <= '9223372036854775808')
      )
    )
  )),
	CONSTRAINT "envelopes_minimum_minor_units_ck" CHECK((
    "envelopes"."minimum_amount" = '0'
    OR (
      "envelopes"."minimum_amount" GLOB '[1-9]*'
      AND "envelopes"."minimum_amount" NOT GLOB '*[^0-9]*'
      AND (length("envelopes"."minimum_amount") < 19 OR (length("envelopes"."minimum_amount") = 19 AND "envelopes"."minimum_amount" <= '9223372036854775807'))
    )
    OR (
      "envelopes"."minimum_amount" GLOB '-[1-9]*'
      AND substr("envelopes"."minimum_amount", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("envelopes"."minimum_amount", 2)) < 19
        OR (length(substr("envelopes"."minimum_amount", 2)) = 19 AND substr("envelopes"."minimum_amount", 2) <= '9223372036854775808')
      )
    )
  )),
	CONSTRAINT "envelopes_target_minor_units_ck" CHECK((
    "envelopes"."target_amount" = '0'
    OR (
      "envelopes"."target_amount" GLOB '[1-9]*'
      AND "envelopes"."target_amount" NOT GLOB '*[^0-9]*'
      AND (length("envelopes"."target_amount") < 19 OR (length("envelopes"."target_amount") = 19 AND "envelopes"."target_amount" <= '9223372036854775807'))
    )
    OR (
      "envelopes"."target_amount" GLOB '-[1-9]*'
      AND substr("envelopes"."target_amount", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("envelopes"."target_amount", 2)) < 19
        OR (length(substr("envelopes"."target_amount", 2)) = 19 AND substr("envelopes"."target_amount", 2) <= '9223372036854775808')
      )
    )
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `envelopes_household_id_id_uq` ON `envelopes` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `envelopes_household_parent_name_uq` ON `envelopes` (`household_id`,`parent_id`,`name`);--> statement-breakpoint
CREATE INDEX `envelopes_household_priority_idx` ON `envelopes` (`household_id`,`is_active`,`priority`);--> statement-breakpoint
CREATE TABLE `exchange_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`base_currency` text NOT NULL,
	`quote_currency` text NOT NULL,
	`rate` text NOT NULL,
	`effective_at` text NOT NULL,
	`source` text NOT NULL,
	`provider_reference` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "exchange_rates_base_currency_ck" CHECK(length("exchange_rates"."base_currency") = 3 AND "exchange_rates"."base_currency" = upper("exchange_rates"."base_currency") AND "exchange_rates"."base_currency" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "exchange_rates_quote_currency_ck" CHECK(length("exchange_rates"."quote_currency") = 3 AND "exchange_rates"."quote_currency" = upper("exchange_rates"."quote_currency") AND "exchange_rates"."quote_currency" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "exchange_rates_distinct_pair_ck" CHECK("exchange_rates"."base_currency" <> "exchange_rates"."quote_currency"),
	CONSTRAINT "exchange_rates_rate_ck" CHECK(
    length("exchange_rates"."rate") > 0
    AND "exchange_rates"."rate" NOT GLOB '*[^0-9.]*'
    AND length("exchange_rates"."rate") - length(replace("exchange_rates"."rate", '.', '')) <= 1
    AND CAST("exchange_rates"."rate" AS REAL) > 0
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exchange_rates_household_id_id_uq` ON `exchange_rates` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `exchange_rates_pair_effective_source_uq` ON `exchange_rates` (`household_id`,`base_currency`,`quote_currency`,`effective_at`,`source`);--> statement-breakpoint
CREATE INDEX `exchange_rates_household_pair_effective_idx` ON `exchange_rates` (`household_id`,`base_currency`,`quote_currency`,`effective_at`);--> statement-breakpoint
CREATE TABLE `forecast_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`scenario_id` text NOT NULL,
	`job_id` text,
	`input_version_hash` text NOT NULL,
	`engine_version` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`run_count` integer DEFAULT 0 NOT NULL,
	`outputs` text,
	`percentile_series` text,
	`readiness` text,
	`error_code` text,
	`started_at` text,
	`finished_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`scenario_id`) REFERENCES `forecast_scenarios`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`job_id`) REFERENCES `jobs`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "forecast_runs_state_ck" CHECK("forecast_runs"."state" IN ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "forecast_runs_run_count_ck" CHECK("forecast_runs"."run_count" >= 0 AND "forecast_runs"."run_count" <= 100000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forecast_runs_household_id_id_uq` ON `forecast_runs` (`household_id`,`id`);--> statement-breakpoint
CREATE INDEX `forecast_runs_household_scenario_created_idx` ON `forecast_runs` (`household_id`,`scenario_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `forecast_runs_input_version_idx` ON `forecast_runs` (`scenario_id`,`input_version_hash`,`engine_version`);--> statement-breakpoint
CREATE TABLE `forecast_scenarios` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`preset` text NOT NULL,
	`assumptions` text NOT NULL,
	`seed` text NOT NULL,
	`horizon_months` integer NOT NULL,
	`reporting_currency` text NOT NULL,
	`is_base` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_by_user_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "forecast_scenarios_preset_ck" CHECK("forecast_scenarios"."preset" IN ('conservative', 'baseline', 'ambitious', 'custom')),
	CONSTRAINT "forecast_scenarios_horizon_ck" CHECK("forecast_scenarios"."horizon_months" BETWEEN 1 AND 1200),
	CONSTRAINT "forecast_scenarios_currency_ck" CHECK(length("forecast_scenarios"."reporting_currency") = 3 AND "forecast_scenarios"."reporting_currency" = upper("forecast_scenarios"."reporting_currency") AND "forecast_scenarios"."reporting_currency" NOT GLOB '*[^A-Z]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forecast_scenarios_household_id_id_uq` ON `forecast_scenarios` (`household_id`,`id`);--> statement-breakpoint
CREATE INDEX `forecast_scenarios_household_active_idx` ON `forecast_scenarios` (`household_id`,`is_active`,`is_base`);--> statement-breakpoint
CREATE UNIQUE INDEX `forecast_scenarios_one_base_uq` ON `forecast_scenarios` (`household_id`) WHERE "forecast_scenarios"."is_base" = 1;--> statement-breakpoint
CREATE TABLE `goal_contributions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`transaction_id` text,
	`allocation_entry_id` text,
	`amount` text NOT NULL,
	`currency` text NOT NULL,
	`contributed_on` text NOT NULL,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`goal_id`) REFERENCES `goals`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`transaction_id`) REFERENCES `transactions`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`household_id`,`allocation_entry_id`) REFERENCES `allocation_entries`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "goal_contributions_provenance_ck" CHECK(("goal_contributions"."transaction_id" IS NOT NULL AND "goal_contributions"."allocation_entry_id" IS NULL) OR ("goal_contributions"."transaction_id" IS NULL AND "goal_contributions"."allocation_entry_id" IS NOT NULL)),
	CONSTRAINT "goal_contributions_amount_positive_ck" CHECK(CAST("goal_contributions"."amount" AS INTEGER) > 0),
	CONSTRAINT "goal_contributions_currency_ck" CHECK(length("goal_contributions"."currency") = 3 AND "goal_contributions"."currency" = upper("goal_contributions"."currency") AND "goal_contributions"."currency" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "goal_contributions_amount_minor_units_ck" CHECK((
    "goal_contributions"."amount" = '0'
    OR (
      "goal_contributions"."amount" GLOB '[1-9]*'
      AND "goal_contributions"."amount" NOT GLOB '*[^0-9]*'
      AND (length("goal_contributions"."amount") < 19 OR (length("goal_contributions"."amount") = 19 AND "goal_contributions"."amount" <= '9223372036854775807'))
    )
    OR (
      "goal_contributions"."amount" GLOB '-[1-9]*'
      AND substr("goal_contributions"."amount", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("goal_contributions"."amount", 2)) < 19
        OR (length(substr("goal_contributions"."amount", 2)) = 19 AND substr("goal_contributions"."amount", 2) <= '9223372036854775808')
      )
    )
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `goal_contributions_household_id_id_uq` ON `goal_contributions` (`household_id`,`id`);--> statement-breakpoint
CREATE INDEX `goal_contributions_household_goal_date_idx` ON `goal_contributions` (`household_id`,`goal_id`,`contributed_on`);--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`target_amount` text NOT NULL,
	`funded_amount` text DEFAULT '0' NOT NULL,
	`currency` text NOT NULL,
	`target_date` text,
	`priority` integer DEFAULT 100 NOT NULL,
	`funding_account_id` text,
	`linked_debt_account_id` text,
	`contribution_policy` text NOT NULL,
	`buffer_policy` text,
	`liquidity_constraint` text DEFAULT 'liquid' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`completed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`funding_account_id`) REFERENCES `accounts`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`household_id`,`linked_debt_account_id`) REFERENCES `accounts`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "goals_type_ck" CHECK("goals"."type" IN ('emergency_fund', 'purchase', 'debt_payoff', 'investment_milestone', 'custom')),
	CONSTRAINT "goals_target_positive_ck" CHECK(CAST("goals"."target_amount" AS INTEGER) > 0),
	CONSTRAINT "goals_currency_ck" CHECK(length("goals"."currency") = 3 AND "goals"."currency" = upper("goals"."currency") AND "goals"."currency" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "goals_liquidity_ck" CHECK("goals"."liquidity_constraint" IN ('cash', 'liquid', 'investable', 'any')),
	CONSTRAINT "goals_status_ck" CHECK("goals"."status" IN ('active', 'paused', 'completed', 'cancelled')),
	CONSTRAINT "goals_target_minor_units_ck" CHECK((
    "goals"."target_amount" = '0'
    OR (
      "goals"."target_amount" GLOB '[1-9]*'
      AND "goals"."target_amount" NOT GLOB '*[^0-9]*'
      AND (length("goals"."target_amount") < 19 OR (length("goals"."target_amount") = 19 AND "goals"."target_amount" <= '9223372036854775807'))
    )
    OR (
      "goals"."target_amount" GLOB '-[1-9]*'
      AND substr("goals"."target_amount", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("goals"."target_amount", 2)) < 19
        OR (length(substr("goals"."target_amount", 2)) = 19 AND substr("goals"."target_amount", 2) <= '9223372036854775808')
      )
    )
  )),
	CONSTRAINT "goals_funded_minor_units_ck" CHECK((
    "goals"."funded_amount" = '0'
    OR (
      "goals"."funded_amount" GLOB '[1-9]*'
      AND "goals"."funded_amount" NOT GLOB '*[^0-9]*'
      AND (length("goals"."funded_amount") < 19 OR (length("goals"."funded_amount") = 19 AND "goals"."funded_amount" <= '9223372036854775807'))
    )
    OR (
      "goals"."funded_amount" GLOB '-[1-9]*'
      AND substr("goals"."funded_amount", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("goals"."funded_amount", 2)) < 19
        OR (length(substr("goals"."funded_amount", 2)) = 19 AND substr("goals"."funded_amount", 2) <= '9223372036854775808')
      )
    )
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `goals_household_id_id_uq` ON `goals` (`household_id`,`id`);--> statement-breakpoint
CREATE INDEX `goals_household_status_priority_idx` ON `goals` (`household_id`,`status`,`priority`);--> statement-breakpoint
CREATE TABLE `holding_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`holding_id` text NOT NULL,
	`quantity` text NOT NULL,
	`price` text NOT NULL,
	`market_value` text NOT NULL,
	`cost_basis` text,
	`currency` text NOT NULL,
	`as_of` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`holding_id`) REFERENCES `holdings`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "holding_snapshots_quantity_ck" CHECK(
    length("holding_snapshots"."quantity") > 0
    AND "holding_snapshots"."quantity" NOT GLOB '*[^0-9.]*'
    AND length("holding_snapshots"."quantity") - length(replace("holding_snapshots"."quantity", '.', '')) <= 1
    AND CAST("holding_snapshots"."quantity" AS REAL) > 0
  ),
	CONSTRAINT "holding_snapshots_price_nonnegative_ck" CHECK(CAST("holding_snapshots"."price" AS INTEGER) >= 0),
	CONSTRAINT "holding_snapshots_value_nonnegative_ck" CHECK(CAST("holding_snapshots"."market_value" AS INTEGER) >= 0),
	CONSTRAINT "holding_snapshots_currency_ck" CHECK(length("holding_snapshots"."currency") = 3 AND "holding_snapshots"."currency" = upper("holding_snapshots"."currency") AND "holding_snapshots"."currency" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "holding_snapshots_source_ck" CHECK("holding_snapshots"."source" IN ('provider', 'manual', 'import')),
	CONSTRAINT "holding_snapshots_price_minor_units_ck" CHECK((
    "holding_snapshots"."price" = '0'
    OR (
      "holding_snapshots"."price" GLOB '[1-9]*'
      AND "holding_snapshots"."price" NOT GLOB '*[^0-9]*'
      AND (length("holding_snapshots"."price") < 19 OR (length("holding_snapshots"."price") = 19 AND "holding_snapshots"."price" <= '9223372036854775807'))
    )
    OR (
      "holding_snapshots"."price" GLOB '-[1-9]*'
      AND substr("holding_snapshots"."price", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("holding_snapshots"."price", 2)) < 19
        OR (length(substr("holding_snapshots"."price", 2)) = 19 AND substr("holding_snapshots"."price", 2) <= '9223372036854775808')
      )
    )
  )),
	CONSTRAINT "holding_snapshots_market_value_minor_units_ck" CHECK((
    "holding_snapshots"."market_value" = '0'
    OR (
      "holding_snapshots"."market_value" GLOB '[1-9]*'
      AND "holding_snapshots"."market_value" NOT GLOB '*[^0-9]*'
      AND (length("holding_snapshots"."market_value") < 19 OR (length("holding_snapshots"."market_value") = 19 AND "holding_snapshots"."market_value" <= '9223372036854775807'))
    )
    OR (
      "holding_snapshots"."market_value" GLOB '-[1-9]*'
      AND substr("holding_snapshots"."market_value", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("holding_snapshots"."market_value", 2)) < 19
        OR (length(substr("holding_snapshots"."market_value", 2)) = 19 AND substr("holding_snapshots"."market_value", 2) <= '9223372036854775808')
      )
    )
  )),
	CONSTRAINT "holding_snapshots_cost_basis_minor_units_ck" CHECK((
    "holding_snapshots"."cost_basis" = '0'
    OR (
      "holding_snapshots"."cost_basis" GLOB '[1-9]*'
      AND "holding_snapshots"."cost_basis" NOT GLOB '*[^0-9]*'
      AND (length("holding_snapshots"."cost_basis") < 19 OR (length("holding_snapshots"."cost_basis") = 19 AND "holding_snapshots"."cost_basis" <= '9223372036854775807'))
    )
    OR (
      "holding_snapshots"."cost_basis" GLOB '-[1-9]*'
      AND substr("holding_snapshots"."cost_basis", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("holding_snapshots"."cost_basis", 2)) < 19
        OR (length(substr("holding_snapshots"."cost_basis", 2)) = 19 AND substr("holding_snapshots"."cost_basis", 2) <= '9223372036854775808')
      )
    )
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `holding_snapshots_household_id_id_uq` ON `holding_snapshots` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `holding_snapshots_holding_asof_source_uq` ON `holding_snapshots` (`holding_id`,`as_of`,`source`);--> statement-breakpoint
CREATE INDEX `holding_snapshots_household_holding_asof_idx` ON `holding_snapshots` (`household_id`,`holding_id`,`as_of`);--> statement-breakpoint
CREATE TABLE `holdings` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`account_id` text NOT NULL,
	`external_id` text,
	`security_id` text NOT NULL,
	`symbol` text,
	`name` text NOT NULL,
	`security_type` text NOT NULL,
	`currency` text NOT NULL,
	`provider_metadata` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`account_id`) REFERENCES `accounts`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "holdings_currency_ck" CHECK(length("holdings"."currency") = 3 AND "holdings"."currency" = upper("holdings"."currency") AND "holdings"."currency" NOT GLOB '*[^A-Z]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `holdings_household_id_id_uq` ON `holdings` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `holdings_account_security_uq` ON `holdings` (`account_id`,`security_id`);--> statement-breakpoint
CREATE INDEX `holdings_household_account_active_idx` ON `holdings` (`household_id`,`account_id`,`is_active`);--> statement-breakpoint
CREATE TABLE `household_members` (
	`household_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`joined_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`household_id`, `user_id`),
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "household_members_role_ck" CHECK("household_members"."role" IN ('owner', 'admin', 'member', 'viewer')),
	CONSTRAINT "household_members_status_ck" CHECK("household_members"."status" IN ('active', 'invited', 'suspended'))
);
--> statement-breakpoint
CREATE INDEX `household_members_user_status_idx` ON `household_members` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `household_members_household_role_idx` ON `household_members` (`household_id`,`role`);--> statement-breakpoint
CREATE TABLE `households` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_currency` text DEFAULT 'USD' NOT NULL,
	`locale` text DEFAULT 'en-US' NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`registration_policy` text DEFAULT 'open' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "households_base_currency_ck" CHECK(length("households"."base_currency") = 3 AND "households"."base_currency" = upper("households"."base_currency") AND "households"."base_currency" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "households_registration_policy_ck" CHECK("households"."registration_policy" IN ('open', 'invite_only')),
	CONSTRAINT "households_status_ck" CHECK("households"."status" IN ('active', 'suspended', 'pending_deletion'))
);
--> statement-breakpoint
CREATE TABLE `import_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`job_id` text,
	`format` text NOT NULL,
	`file_hash` text NOT NULL,
	`original_filename` text,
	`mapping` text,
	`state` text DEFAULT 'preview' NOT NULL,
	`total_records` integer DEFAULT 0 NOT NULL,
	`imported_records` integer DEFAULT 0 NOT NULL,
	`duplicate_records` integer DEFAULT 0 NOT NULL,
	`rejected_records` integer DEFAULT 0 NOT NULL,
	`errors` text,
	`committed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`household_id`,`job_id`) REFERENCES `jobs`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "import_runs_format_ck" CHECK("import_runs"."format" IN ('csv', 'qfx', 'ofx', 'fixture', 'manual')),
	CONSTRAINT "import_runs_state_ck" CHECK("import_runs"."state" IN ('preview', 'queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "import_runs_counts_ck" CHECK("import_runs"."total_records" >= 0 AND "import_runs"."imported_records" >= 0 AND "import_runs"."duplicate_records" >= 0 AND "import_runs"."rejected_records" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_runs_household_id_id_uq` ON `import_runs` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `import_runs_household_file_hash_uq` ON `import_runs` (`household_id`,`file_hash`);--> statement-breakpoint
CREATE INDEX `import_runs_household_created_idx` ON `import_runs` (`household_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `income_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`merchant_id` text,
	`account_id` text,
	`recurring_series_id` text,
	`cadence` text NOT NULL,
	`cadence_config` text,
	`typical_amount` text NOT NULL,
	`currency` text NOT NULL,
	`next_expected_date` text,
	`variability_bps` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`detection_rule` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`merchant_id`) REFERENCES `merchants`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`household_id`,`account_id`) REFERENCES `accounts`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`household_id`,`recurring_series_id`) REFERENCES `recurring_series`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "income_sources_currency_ck" CHECK(length("income_sources"."currency") = 3 AND "income_sources"."currency" = upper("income_sources"."currency") AND "income_sources"."currency" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "income_sources_variability_ck" CHECK("income_sources"."variability_bps" BETWEEN 0 AND 100000),
	CONSTRAINT "income_sources_typical_minor_units_ck" CHECK((
    "income_sources"."typical_amount" = '0'
    OR (
      "income_sources"."typical_amount" GLOB '[1-9]*'
      AND "income_sources"."typical_amount" NOT GLOB '*[^0-9]*'
      AND (length("income_sources"."typical_amount") < 19 OR (length("income_sources"."typical_amount") = 19 AND "income_sources"."typical_amount" <= '9223372036854775807'))
    )
    OR (
      "income_sources"."typical_amount" GLOB '-[1-9]*'
      AND substr("income_sources"."typical_amount", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("income_sources"."typical_amount", 2)) < 19
        OR (length(substr("income_sources"."typical_amount", 2)) = 19 AND substr("income_sources"."typical_amount", 2) <= '9223372036854775808')
      )
    )
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `income_sources_household_id_id_uq` ON `income_sources` (`household_id`,`id`);--> statement-breakpoint
CREATE INDEX `income_sources_household_next_idx` ON `income_sources` (`household_id`,`next_expected_date`,`is_active`);--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`invited_by_user_id` text NOT NULL,
	`email` text NOT NULL,
	`normalized_email` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` text NOT NULL,
	`accepted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "invitations_normalized_email_ck" CHECK("invitations"."normalized_email" = lower(trim("invitations"."normalized_email"))),
	CONSTRAINT "invitations_role_ck" CHECK("invitations"."role" IN ('admin', 'member', 'viewer')),
	CONSTRAINT "invitations_status_ck" CHECK("invitations"."status" IN ('pending', 'accepted', 'revoked', 'expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_token_hash_uq` ON `invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invitations_household_email_status_idx` ON `invitations` (`household_id`,`normalized_email`,`status`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`scheduled_at` text NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`lease_epoch` integer DEFAULT 0 NOT NULL,
	`heartbeat_at` text,
	`idempotency_key` text,
	`last_error_code` text,
	`last_error_message` text,
	`completed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "jobs_state_ck" CHECK("jobs"."state" IN ('queued', 'leased', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "jobs_attempts_ck" CHECK("jobs"."attempts" >= 0 AND "jobs"."max_attempts" > 0 AND "jobs"."attempts" <= "jobs"."max_attempts"),
	CONSTRAINT "jobs_lease_epoch_ck" CHECK("jobs"."lease_epoch" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_household_id_id_uq` ON `jobs` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_household_idempotency_uq` ON `jobs` (`household_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`state`,`scheduled_at`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `jobs_household_type_state_idx` ON `jobs` (`household_id`,`type`,`state`);--> statement-breakpoint
CREATE TABLE `merchant_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`merchant_id` text NOT NULL,
	`alias` text NOT NULL,
	`normalized_alias` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`merchant_id`) REFERENCES `merchants`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "merchant_aliases_source_ck" CHECK("merchant_aliases"."source" IN ('user', 'provider', 'rule', 'ai'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchant_aliases_household_alias_uq` ON `merchant_aliases` (`household_id`,`normalized_alias`);--> statement-breakpoint
CREATE INDEX `merchant_aliases_household_merchant_idx` ON `merchant_aliases` (`household_id`,`merchant_id`);--> statement-breakpoint
CREATE TABLE `merchants` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`default_category_id` text,
	`website` text,
	`logo_url` text,
	`metadata` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchants_household_id_id_uq` ON `merchants` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `merchants_household_normalized_name_uq` ON `merchants` (`household_id`,`normalized_name`);--> statement-breakpoint
CREATE INDEX `merchants_household_name_idx` ON `merchants` (`household_id`,`name`);--> statement-breakpoint
CREATE TABLE `pay_cycles` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`income_source_id` text NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text NOT NULL,
	`expected_income` text NOT NULL,
	`actual_income` text DEFAULT '0' NOT NULL,
	`currency` text NOT NULL,
	`status` text DEFAULT 'projected' NOT NULL,
	`closed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`income_source_id`) REFERENCES `income_sources`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "pay_cycles_dates_ck" CHECK("pay_cycles"."starts_on" <= "pay_cycles"."ends_on"),
	CONSTRAINT "pay_cycles_currency_ck" CHECK(length("pay_cycles"."currency") = 3 AND "pay_cycles"."currency" = upper("pay_cycles"."currency") AND "pay_cycles"."currency" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "pay_cycles_status_ck" CHECK("pay_cycles"."status" IN ('projected', 'open', 'closed', 'skipped')),
	CONSTRAINT "pay_cycles_expected_minor_units_ck" CHECK((
    "pay_cycles"."expected_income" = '0'
    OR (
      "pay_cycles"."expected_income" GLOB '[1-9]*'
      AND "pay_cycles"."expected_income" NOT GLOB '*[^0-9]*'
      AND (length("pay_cycles"."expected_income") < 19 OR (length("pay_cycles"."expected_income") = 19 AND "pay_cycles"."expected_income" <= '9223372036854775807'))
    )
    OR (
      "pay_cycles"."expected_income" GLOB '-[1-9]*'
      AND substr("pay_cycles"."expected_income", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("pay_cycles"."expected_income", 2)) < 19
        OR (length(substr("pay_cycles"."expected_income", 2)) = 19 AND substr("pay_cycles"."expected_income", 2) <= '9223372036854775808')
      )
    )
  )),
	CONSTRAINT "pay_cycles_actual_minor_units_ck" CHECK((
    "pay_cycles"."actual_income" = '0'
    OR (
      "pay_cycles"."actual_income" GLOB '[1-9]*'
      AND "pay_cycles"."actual_income" NOT GLOB '*[^0-9]*'
      AND (length("pay_cycles"."actual_income") < 19 OR (length("pay_cycles"."actual_income") = 19 AND "pay_cycles"."actual_income" <= '9223372036854775807'))
    )
    OR (
      "pay_cycles"."actual_income" GLOB '-[1-9]*'
      AND substr("pay_cycles"."actual_income", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("pay_cycles"."actual_income", 2)) < 19
        OR (length(substr("pay_cycles"."actual_income", 2)) = 19 AND substr("pay_cycles"."actual_income", 2) <= '9223372036854775808')
      )
    )
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pay_cycles_household_id_id_uq` ON `pay_cycles` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pay_cycles_source_start_uq` ON `pay_cycles` (`income_source_id`,`starts_on`);--> statement-breakpoint
CREATE INDEX `pay_cycles_household_dates_idx` ON `pay_cycles` (`household_id`,`starts_on`,`ends_on`);--> statement-breakpoint
CREATE TABLE `personal_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`expires_at` text,
	`last_used_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `personal_access_tokens_token_hash_uq` ON `personal_access_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `personal_access_tokens_user_idx` ON `personal_access_tokens` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `provider_institutions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`url` text,
	`logo_url` text,
	`metadata` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`connection_id`) REFERENCES `connections`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_institutions_household_id_id_uq` ON `provider_institutions` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_institutions_connection_external_uq` ON `provider_institutions` (`connection_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `provider_institutions_household_name_idx` ON `provider_institutions` (`household_id`,`name`);--> statement-breakpoint
CREATE TABLE `raw_import_records` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`import_run_id` text NOT NULL,
	`row_number` integer NOT NULL,
	`external_id` text,
	`payload` text,
	`payload_ciphertext` blob,
	`payload_nonce` blob,
	`payload_auth_tag` blob,
	`payload_key_version` text,
	`payload_aad` text,
	`record_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_code` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`import_run_id`) REFERENCES `import_runs`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "raw_import_records_row_number_ck" CHECK("raw_import_records"."row_number" > 0),
	CONSTRAINT "raw_import_records_status_ck" CHECK("raw_import_records"."status" IN ('pending', 'accepted', 'duplicate', 'rejected')),
	CONSTRAINT "raw_import_records_payload_mode_ck" CHECK(("raw_import_records"."payload" IS NOT NULL AND "raw_import_records"."payload_ciphertext" IS NULL) OR ("raw_import_records"."payload" IS NULL AND "raw_import_records"."payload_ciphertext" IS NOT NULL AND "raw_import_records"."payload_nonce" IS NOT NULL AND "raw_import_records"."payload_auth_tag" IS NOT NULL AND length("raw_import_records"."payload_key_version") > 0 AND "raw_import_records"."payload_aad" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `raw_import_records_run_row_uq` ON `raw_import_records` (`import_run_id`,`row_number`);--> statement-breakpoint
CREATE INDEX `raw_import_records_household_hash_idx` ON `raw_import_records` (`household_id`,`record_hash`);--> statement-breakpoint
CREATE TABLE `recurring_series` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`merchant_id` text,
	`account_id` text,
	`category_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`cadence` text NOT NULL,
	`cadence_config` text,
	`amount_min` text NOT NULL,
	`amount_max` text NOT NULL,
	`currency` text NOT NULL,
	`next_expected_date` text,
	`last_observed_date` text,
	`confidence_bps` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`merchant_id`) REFERENCES `merchants`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`household_id`,`account_id`) REFERENCES `accounts`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`household_id`,`category_id`) REFERENCES `categories`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "recurring_series_kind_ck" CHECK("recurring_series"."kind" IN ('income', 'bill', 'subscription', 'transfer', 'spending')),
	CONSTRAINT "recurring_series_status_ck" CHECK("recurring_series"."status" IN ('active', 'paused', 'ended', 'needs_review')),
	CONSTRAINT "recurring_series_confidence_ck" CHECK("recurring_series"."confidence_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "recurring_series_currency_ck" CHECK(length("recurring_series"."currency") = 3 AND "recurring_series"."currency" = upper("recurring_series"."currency") AND "recurring_series"."currency" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "recurring_series_amount_order_ck" CHECK(CAST("recurring_series"."amount_min" AS INTEGER) <= CAST("recurring_series"."amount_max" AS INTEGER)),
	CONSTRAINT "recurring_series_min_minor_units_ck" CHECK((
    "recurring_series"."amount_min" = '0'
    OR (
      "recurring_series"."amount_min" GLOB '[1-9]*'
      AND "recurring_series"."amount_min" NOT GLOB '*[^0-9]*'
      AND (length("recurring_series"."amount_min") < 19 OR (length("recurring_series"."amount_min") = 19 AND "recurring_series"."amount_min" <= '9223372036854775807'))
    )
    OR (
      "recurring_series"."amount_min" GLOB '-[1-9]*'
      AND substr("recurring_series"."amount_min", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("recurring_series"."amount_min", 2)) < 19
        OR (length(substr("recurring_series"."amount_min", 2)) = 19 AND substr("recurring_series"."amount_min", 2) <= '9223372036854775808')
      )
    )
  )),
	CONSTRAINT "recurring_series_max_minor_units_ck" CHECK((
    "recurring_series"."amount_max" = '0'
    OR (
      "recurring_series"."amount_max" GLOB '[1-9]*'
      AND "recurring_series"."amount_max" NOT GLOB '*[^0-9]*'
      AND (length("recurring_series"."amount_max") < 19 OR (length("recurring_series"."amount_max") = 19 AND "recurring_series"."amount_max" <= '9223372036854775807'))
    )
    OR (
      "recurring_series"."amount_max" GLOB '-[1-9]*'
      AND substr("recurring_series"."amount_max", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("recurring_series"."amount_max", 2)) < 19
        OR (length(substr("recurring_series"."amount_max", 2)) = 19 AND substr("recurring_series"."amount_max", 2) <= '9223372036854775808')
      )
    )
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_series_household_id_id_uq` ON `recurring_series` (`household_id`,`id`);--> statement-breakpoint
CREATE INDEX `recurring_series_household_next_status_idx` ON `recurring_series` (`household_id`,`next_expected_date`,`status`);--> statement-breakpoint
CREATE INDEX `recurring_series_household_merchant_idx` ON `recurring_series` (`household_id`,`merchant_id`);--> statement-breakpoint
CREATE TABLE `refund_links` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`refund_transaction_id` text NOT NULL,
	`purchase_transaction_id` text NOT NULL,
	`amount` text NOT NULL,
	`confidence_bps` integer NOT NULL,
	`status` text DEFAULT 'suggested' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`refund_transaction_id`) REFERENCES `transactions`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`purchase_transaction_id`) REFERENCES `transactions`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "refund_links_distinct_transactions_ck" CHECK("refund_links"."refund_transaction_id" <> "refund_links"."purchase_transaction_id"),
	CONSTRAINT "refund_links_amount_positive_ck" CHECK(CAST("refund_links"."amount" AS INTEGER) > 0),
	CONSTRAINT "refund_links_confidence_ck" CHECK("refund_links"."confidence_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "refund_links_status_ck" CHECK("refund_links"."status" IN ('suggested', 'confirmed', 'rejected')),
	CONSTRAINT "refund_links_amount_minor_units_ck" CHECK((
    "refund_links"."amount" = '0'
    OR (
      "refund_links"."amount" GLOB '[1-9]*'
      AND "refund_links"."amount" NOT GLOB '*[^0-9]*'
      AND (length("refund_links"."amount") < 19 OR (length("refund_links"."amount") = 19 AND "refund_links"."amount" <= '9223372036854775807'))
    )
    OR (
      "refund_links"."amount" GLOB '-[1-9]*'
      AND substr("refund_links"."amount", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("refund_links"."amount", 2)) < 19
        OR (length(substr("refund_links"."amount", 2)) = 19 AND substr("refund_links"."amount", 2) <= '9223372036854775808')
      )
    )
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refund_links_household_id_id_uq` ON `refund_links` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refund_links_pair_uq` ON `refund_links` (`refund_transaction_id`,`purchase_transaction_id`);--> statement-breakpoint
CREATE INDEX `refund_links_household_status_idx` ON `refund_links` (`household_id`,`status`);--> statement-breakpoint
CREATE TABLE `rule_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`winning_rule_id` text,
	`competing_rule_ids` text NOT NULL,
	`before_snapshot` text NOT NULL,
	`after_snapshot` text NOT NULL,
	`explanation` text NOT NULL,
	`reversible_batch_id` text,
	`reverted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`transaction_id`) REFERENCES `transactions`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`winning_rule_id`) REFERENCES `rules`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rule_runs_household_id_id_uq` ON `rule_runs` (`household_id`,`id`);--> statement-breakpoint
CREATE INDEX `rule_runs_household_transaction_created_idx` ON `rule_runs` (`household_id`,`transaction_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `rule_runs_household_rule_created_idx` ON `rule_runs` (`household_id`,`winning_rule_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `rule_runs_reversible_batch_idx` ON `rule_runs` (`household_id`,`reversible_batch_id`);--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`origin` text DEFAULT 'user' NOT NULL,
	`conditions` text NOT NULL,
	`actions` text NOT NULL,
	`specificity_score` integer DEFAULT 0 NOT NULL,
	`match_count` integer DEFAULT 0 NOT NULL,
	`last_matched_at` text,
	`created_by_user_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "rules_origin_ck" CHECK("rules"."origin" IN ('user', 'system', 'ai')),
	CONSTRAINT "rules_match_count_ck" CHECK("rules"."match_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rules_household_id_id_uq` ON `rules` (`household_id`,`id`);--> statement-breakpoint
CREATE INDEX `rules_household_evaluation_idx` ON `rules` (`household_id`,`is_enabled`,`priority`,`specificity_score`,`updated_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`csrf_token_hash` text NOT NULL,
	`rotated_from_id` text,
	`ip_address` text,
	`user_agent` text,
	`idle_expires_at` text NOT NULL,
	`absolute_expires_at` text NOT NULL,
	`last_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rotated_from_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "sessions_expiry_order_ck" CHECK("sessions"."idle_expires_at" <= "sessions"."absolute_expires_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_uq` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_expiry_idx` ON `sessions` (`user_id`,`absolute_expires_at`);--> statement-breakpoint
CREATE INDEX `sessions_rotated_from_idx` ON `sessions` (`rotated_from_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`user_id` text,
	`scope_key` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`is_secret` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "settings_scope_user_ck" CHECK(("settings"."user_id" IS NULL AND "settings"."scope_key" = 'household') OR ("settings"."user_id" IS NOT NULL AND "settings"."scope_key" = "settings"."user_id"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settings_household_id_id_uq` ON `settings` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `settings_household_scope_key_uq` ON `settings` (`household_id`,`scope_key`,`key`);--> statement-breakpoint
CREATE INDEX `settings_user_idx` ON `settings` (`user_id`,`key`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`job_id` text,
	`trigger` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`checkpoint_before` text,
	`checkpoint_after` text,
	`accounts_seen` integer DEFAULT 0 NOT NULL,
	`balances_created` integer DEFAULT 0 NOT NULL,
	`transactions_created` integer DEFAULT 0 NOT NULL,
	`transactions_updated` integer DEFAULT 0 NOT NULL,
	`transactions_removed` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_message` text,
	`started_at` text,
	`finished_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`connection_id`) REFERENCES `connections`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`job_id`) REFERENCES `jobs`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_runs_trigger_ck" CHECK("sync_runs"."trigger" IN ('manual', 'scheduled', 'initial', 'retry')),
	CONSTRAINT "sync_runs_state_ck" CHECK("sync_runs"."state" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_runs_household_id_id_uq` ON `sync_runs` (`household_id`,`id`);--> statement-breakpoint
CREATE INDEX `sync_runs_household_connection_created_idx` ON `sync_runs` (`household_id`,`connection_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sync_runs_state_created_idx` ON `sync_runs` (`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`color` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_household_id_id_uq` ON `tags` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tags_household_normalized_name_uq` ON `tags` (`household_id`,`normalized_name`);--> statement-breakpoint
CREATE TABLE `transaction_splits` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`amount` text NOT NULL,
	`category_id` text,
	`envelope_id` text,
	`memo` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`transaction_id`) REFERENCES `transactions`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`category_id`) REFERENCES `categories`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`household_id`,`envelope_id`) REFERENCES `envelopes`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "transaction_splits_sequence_ck" CHECK("transaction_splits"."sequence" >= 0),
	CONSTRAINT "transaction_splits_amount_nonzero_ck" CHECK(CAST("transaction_splits"."amount" AS INTEGER) <> 0),
	CONSTRAINT "transaction_splits_amount_minor_units_ck" CHECK((
    "transaction_splits"."amount" = '0'
    OR (
      "transaction_splits"."amount" GLOB '[1-9]*'
      AND "transaction_splits"."amount" NOT GLOB '*[^0-9]*'
      AND (length("transaction_splits"."amount") < 19 OR (length("transaction_splits"."amount") = 19 AND "transaction_splits"."amount" <= '9223372036854775807'))
    )
    OR (
      "transaction_splits"."amount" GLOB '-[1-9]*'
      AND substr("transaction_splits"."amount", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("transaction_splits"."amount", 2)) < 19
        OR (length(substr("transaction_splits"."amount", 2)) = 19 AND substr("transaction_splits"."amount", 2) <= '9223372036854775808')
      )
    )
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transaction_splits_household_id_id_uq` ON `transaction_splits` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transaction_splits_transaction_sequence_uq` ON `transaction_splits` (`transaction_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `transaction_splits_household_category_idx` ON `transaction_splits` (`household_id`,`category_id`);--> statement-breakpoint
CREATE TABLE `transaction_tags` (
	`household_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`household_id`, `transaction_id`, `tag_id`),
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`transaction_id`) REFERENCES `transactions`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`tag_id`) REFERENCES `tags`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `transaction_tags_tag_idx` ON `transaction_tags` (`household_id`,`tag_id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`account_id` text NOT NULL,
	`connection_id` text,
	`import_run_id` text,
	`external_id` text,
	`pending_external_id` text,
	`amount` text NOT NULL,
	`currency` text NOT NULL,
	`authorized_at` text,
	`posted_at` text,
	`transacted_on` text NOT NULL,
	`raw_description` text NOT NULL,
	`normalized_description` text NOT NULL,
	`merchant_id` text,
	`category_id` text,
	`category_origin` text DEFAULT 'none' NOT NULL,
	`envelope_id` text,
	`recurring_series_id` text,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`review_state` text DEFAULT 'none' NOT NULL,
	`is_excluded` integer DEFAULT false NOT NULL,
	`is_transfer` integer DEFAULT false NOT NULL,
	`is_income` integer DEFAULT false NOT NULL,
	`is_reimbursement` integer DEFAULT false NOT NULL,
	`note` text,
	`provider_category` text,
	`provider_metadata` text,
	`fingerprint` text,
	`first_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`last_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`removed_upstream_at` text,
	`user_override_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`account_id`) REFERENCES `accounts`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`connection_id`) REFERENCES `connections`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`household_id`,`import_run_id`) REFERENCES `import_runs`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`household_id`,`merchant_id`) REFERENCES `merchants`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`household_id`,`category_id`) REFERENCES `categories`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`household_id`,`envelope_id`) REFERENCES `envelopes`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`household_id`,`recurring_series_id`) REFERENCES `recurring_series`(`household_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "transactions_amount_nonzero_ck" CHECK(CAST("transactions"."amount" AS INTEGER) <> 0),
	CONSTRAINT "transactions_currency_ck" CHECK(length("transactions"."currency") = 3 AND "transactions"."currency" = upper("transactions"."currency") AND "transactions"."currency" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "transactions_category_origin_ck" CHECK("transactions"."category_origin" IN ('user', 'rule', 'provider', 'merchant_history', 'ai', 'none')),
	CONSTRAINT "transactions_status_ck" CHECK("transactions"."status" IN ('pending', 'posted', 'removed', 'void')),
	CONSTRAINT "transactions_source_ck" CHECK("transactions"."source" IN ('provider', 'import', 'manual', 'fixture')),
	CONSTRAINT "transactions_review_state_ck" CHECK("transactions"."review_state" IN ('none', 'needs_review', 'reviewed')),
	CONSTRAINT "transactions_amount_minor_units_ck" CHECK((
    "transactions"."amount" = '0'
    OR (
      "transactions"."amount" GLOB '[1-9]*'
      AND "transactions"."amount" NOT GLOB '*[^0-9]*'
      AND (length("transactions"."amount") < 19 OR (length("transactions"."amount") = 19 AND "transactions"."amount" <= '9223372036854775807'))
    )
    OR (
      "transactions"."amount" GLOB '-[1-9]*'
      AND substr("transactions"."amount", 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr("transactions"."amount", 2)) < 19
        OR (length(substr("transactions"."amount", 2)) = 19 AND substr("transactions"."amount", 2) <= '9223372036854775808')
      )
    )
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_household_id_id_uq` ON `transactions` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_connection_account_external_uq` ON `transactions` (`connection_id`,`account_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `transactions_household_date_id_idx` ON `transactions` (`household_id`,`transacted_on`,`id`);--> statement-breakpoint
CREATE INDEX `transactions_household_account_date_idx` ON `transactions` (`household_id`,`account_id`,`transacted_on`);--> statement-breakpoint
CREATE INDEX `transactions_household_review_date_idx` ON `transactions` (`household_id`,`review_state`,`transacted_on`);--> statement-breakpoint
CREATE INDEX `transactions_household_category_date_idx` ON `transactions` (`household_id`,`category_id`,`transacted_on`);--> statement-breakpoint
CREATE INDEX `transactions_household_merchant_date_idx` ON `transactions` (`household_id`,`merchant_id`,`transacted_on`);--> statement-breakpoint
CREATE INDEX `transactions_household_recurring_date_idx` ON `transactions` (`household_id`,`recurring_series_id`,`transacted_on`);--> statement-breakpoint
CREATE INDEX `transactions_household_fingerprint_idx` ON `transactions` (`household_id`,`account_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `transactions_pending_external_idx` ON `transactions` (`connection_id`,`account_id`,`pending_external_id`);--> statement-breakpoint
CREATE TABLE `transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`outflow_transaction_id` text NOT NULL,
	`inflow_transaction_id` text NOT NULL,
	`confidence_bps` integer NOT NULL,
	`status` text DEFAULT 'suggested' NOT NULL,
	`matched_by` text NOT NULL,
	`confirmed_by_user_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`confirmed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`household_id`,`outflow_transaction_id`) REFERENCES `transactions`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`,`inflow_transaction_id`) REFERENCES `transactions`(`household_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "transfers_distinct_sides_ck" CHECK("transfers"."outflow_transaction_id" <> "transfers"."inflow_transaction_id"),
	CONSTRAINT "transfers_confidence_ck" CHECK("transfers"."confidence_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "transfers_status_ck" CHECK("transfers"."status" IN ('suggested', 'confirmed', 'rejected', 'unmatched')),
	CONSTRAINT "transfers_matched_by_ck" CHECK("transfers"."matched_by" IN ('provider', 'fingerprint', 'user'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transfers_household_id_id_uq` ON `transfers` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transfers_outflow_uq` ON `transfers` (`outflow_transaction_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transfers_inflow_uq` ON `transfers` (`inflow_transaction_id`);--> statement-breakpoint
CREATE INDEX `transfers_household_status_idx` ON `transfers` (`household_id`,`status`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`normalized_email` text NOT NULL,
	`password_hash` text NOT NULL,
	`display_name` text NOT NULL,
	`birth_date` text,
	`target_age` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`email_verified_at` text,
	`last_login_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "users_normalized_email_ck" CHECK("users"."normalized_email" = lower(trim("users"."normalized_email"))),
	CONSTRAINT "users_target_age_ck" CHECK("users"."target_age" IS NULL OR "users"."target_age" BETWEEN 18 AND 120),
	CONSTRAINT "users_status_ck" CHECK("users"."status" IN ('active', 'disabled', 'pending_deletion'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_normalized_email_uq` ON `users` (`normalized_email`);