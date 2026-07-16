CREATE TABLE `ad_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`object_guid` text NOT NULL,
	`sam_account_name` text NOT NULL,
	`distinguished_name` text NOT NULL,
	`ou_path` text NOT NULL,
	`display_name` text,
	`user_principal_name` text,
	`kind` text DEFAULT 'user' NOT NULL,
	`kind_reason` text,
	`enabled` integer DEFAULT true NOT NULL,
	`user_account_control` integer DEFAULT 0 NOT NULL,
	`password_never_expires` integer DEFAULT false NOT NULL,
	`password_expires_at` integer,
	`account_expires_at` integer,
	`last_logon_at` integer,
	`spn_count` integer DEFAULT 0 NOT NULL,
	`last_synced_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ad_accounts_object_guid_unique` ON `ad_accounts` (`object_guid`);--> statement-breakpoint
CREATE INDEX `idx_ad_accounts_sam` ON `ad_accounts` (`sam_account_name`);--> statement-breakpoint
CREATE INDEX `idx_ad_accounts_ou` ON `ad_accounts` (`ou_path`);--> statement-breakpoint
CREATE INDEX `idx_ad_accounts_kind` ON `ad_accounts` (`kind`);--> statement-breakpoint
-- `settings` and `services.last_notified_at` already exist: they were applied
-- out-of-band by scripts/migrate-db.js before drizzle tracked them, so the
-- generated CREATE/ALTER for those two were removed here to keep this file
-- runnable against the live database.
ALTER TABLE `users` ADD `auth_source` text DEFAULT 'local' NOT NULL;