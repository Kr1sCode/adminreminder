CREATE TABLE `check_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service_id` integer NOT NULL,
	`checked_at` integer NOT NULL,
	`expiry_date` integer,
	`success` integer NOT NULL,
	`error_message` text,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `services` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text DEFAULT 'https_cert' NOT NULL,
	`name` text NOT NULL,
	`identifier` text NOT NULL,
	`port` integer DEFAULT 443 NOT NULL,
	`owner` text,
	`notes` text,
	`custom_data` text DEFAULT '{}',
	`renewal_url` text,
	`expiry_date` integer,
	`last_checked_at` integer,
	`last_check_status` text,
	`last_check_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_services_identifier` ON `services` (`identifier`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);