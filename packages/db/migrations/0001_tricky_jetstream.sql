DROP INDEX `transfers_outflow_uq`;--> statement-breakpoint
DROP INDEX `transfers_inflow_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `transfers_pair_uq` ON `transfers` (`outflow_transaction_id`,`inflow_transaction_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transfers_outflow_active_uq` ON `transfers` (`outflow_transaction_id`) WHERE "transfers"."status" <> 'rejected';--> statement-breakpoint
CREATE UNIQUE INDEX `transfers_inflow_active_uq` ON `transfers` (`inflow_transaction_id`) WHERE "transfers"."status" <> 'rejected';