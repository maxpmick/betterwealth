CREATE TRIGGER `transfers_active_transaction_insert_guard`
BEFORE INSERT ON `transfers`
WHEN NEW.`status` <> 'rejected'
  AND EXISTS (
    SELECT 1
    FROM `transfers` AS existing
    WHERE existing.`id` <> NEW.`id`
      AND existing.`status` <> 'rejected'
      AND (
        existing.`outflow_transaction_id` IN (
          NEW.`outflow_transaction_id`,
          NEW.`inflow_transaction_id`
        )
        OR existing.`inflow_transaction_id` IN (
          NEW.`outflow_transaction_id`,
          NEW.`inflow_transaction_id`
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'transaction already belongs to an active transfer');
END;--> statement-breakpoint
CREATE TRIGGER `transfers_active_transaction_update_guard`
BEFORE UPDATE OF `outflow_transaction_id`, `inflow_transaction_id`, `status` ON `transfers`
WHEN NEW.`status` <> 'rejected'
  AND EXISTS (
    SELECT 1
    FROM `transfers` AS existing
    WHERE existing.`id` <> OLD.`id`
      AND existing.`status` <> 'rejected'
      AND (
        existing.`outflow_transaction_id` IN (
          NEW.`outflow_transaction_id`,
          NEW.`inflow_transaction_id`
        )
        OR existing.`inflow_transaction_id` IN (
          NEW.`outflow_transaction_id`,
          NEW.`inflow_transaction_id`
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'transaction already belongs to an active transfer');
END;
