import type { BetterWealthDatabase } from "@betterwealth/db";
import { Hono } from "hono";
import { requireAuth } from "../../auth/middleware";
import type { AppConfig } from "../../config";
import { idempotency } from "../../lib/idempotency";
import type { AppEnv } from "../../types";
import { createAssetRoutes } from "./assets";
import { createBillRoutes } from "./bills";
import { createEnvelopeRoutes } from "./envelopes";
import { createForecastRoutes } from "./forecasts";
import { createGoalRoutes } from "./goals";
import { createImportRoutes } from "./imports";
import { createIncomeSourceRoutes } from "./income-sources";
import { createRuleRoutes } from "./rules";

export function createPlanningRoutes(
  db: BetterWealthDatabase,
  config: AppConfig,
  now: () => Date = () => new Date(),
) {
  const routes = new Hono<AppEnv>();
  routes.use("*", requireAuth(db, config));
  routes.use("*", idempotency(db));
  routes.route("/", createEnvelopeRoutes(db, config));
  routes.route("/", createBillRoutes(db, config));
  routes.route("/", createGoalRoutes(db, config, now));
  routes.route("/", createRuleRoutes(db, config));
  routes.route("/", createForecastRoutes(db, config, now));
  routes.route("/", createAssetRoutes(db, config));
  routes.route("/", createIncomeSourceRoutes(db, config));
  routes.route("/", createImportRoutes(db, config));
  return routes;
}
