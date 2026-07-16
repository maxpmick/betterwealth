import { type SQL, sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  blob,
  type CheckBuilder,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { minorUnit } from "./money.ts";

export type JsonObject = Record<string, unknown>;

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
const zeroMinor = sql`'0'`;

function timestamps() {
  return {
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  };
}

function json<T = JsonObject>(name: string) {
  return text(name, { mode: "json" }).$type<T>();
}

function validMinorUnits(column: AnySQLiteColumn): SQL {
  return sql`(
    ${column} = '0'
    OR (
      ${column} GLOB '[1-9]*'
      AND ${column} NOT GLOB '*[^0-9]*'
      AND (length(${column}) < 19 OR (length(${column}) = 19 AND ${column} <= '9223372036854775807'))
    )
    OR (
      ${column} GLOB '-[1-9]*'
      AND substr(${column}, 2) NOT GLOB '*[^0-9]*'
      AND (
        length(substr(${column}, 2)) < 19
        OR (length(substr(${column}, 2)) = 19 AND substr(${column}, 2) <= '9223372036854775808')
      )
    )
  )`;
}

function moneyChecks(prefix: string, columns: Record<string, AnySQLiteColumn>): CheckBuilder[] {
  return Object.entries(columns).map(([name, column]) =>
    check(`${prefix}_${name}_minor_units_ck`, validMinorUnits(column)),
  );
}

function currencyCheck(column: AnySQLiteColumn): SQL {
  return sql`length(${column}) = 3 AND ${column} = upper(${column}) AND ${column} NOT GLOB '*[^A-Z]*'`;
}

function positiveDecimalCheck(column: AnySQLiteColumn): SQL {
  return sql`
    length(${column}) > 0
    AND ${column} NOT GLOB '*[^0-9.]*'
    AND length(${column}) - length(replace(${column}, '.', '')) <= 1
    AND CAST(${column} AS REAL) > 0
  `;
}

// Identity and tenancy -------------------------------------------------------

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    normalizedEmail: text("normalized_email").notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    birthDate: text("birth_date"),
    targetAge: integer("target_age"),
    status: text("status", { enum: ["active", "disabled", "pending_deletion"] })
      .notNull()
      .default("active"),
    emailVerifiedAt: text("email_verified_at"),
    lastLoginAt: text("last_login_at"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("users_normalized_email_uq").on(t.normalizedEmail),
    check(
      "users_normalized_email_ck",
      sql`${t.normalizedEmail} = lower(trim(${t.normalizedEmail}))`,
    ),
    check("users_target_age_ck", sql`${t.targetAge} IS NULL OR ${t.targetAge} BETWEEN 18 AND 120`),
    check("users_status_ck", sql`${t.status} IN ('active', 'disabled', 'pending_deletion')`),
  ],
);

export const households = sqliteTable(
  "households",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    baseCurrency: text("base_currency").notNull().default("USD"),
    locale: text("locale").notNull().default("en-US"),
    timezone: text("timezone").notNull().default("UTC"),
    registrationPolicy: text("registration_policy", { enum: ["open", "invite_only"] })
      .notNull()
      .default("open"),
    status: text("status", { enum: ["active", "suspended", "pending_deletion"] })
      .notNull()
      .default("active"),
    ...timestamps(),
  },
  (t) => [
    check("households_base_currency_ck", currencyCheck(t.baseCurrency)),
    check(
      "households_registration_policy_ck",
      sql`${t.registrationPolicy} IN ('open', 'invite_only')`,
    ),
    check("households_status_ck", sql`${t.status} IN ('active', 'suspended', 'pending_deletion')`),
  ],
);

export const householdMembers = sqliteTable(
  "household_members",
  {
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member", "viewer"] }).notNull(),
    status: text("status", { enum: ["active", "invited", "suspended"] })
      .notNull()
      .default("active"),
    joinedAt: text("joined_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.householdId, t.userId] }),
    index("household_members_user_status_idx").on(t.userId, t.status),
    index("household_members_household_role_idx").on(t.householdId, t.role),
    check("household_members_role_ck", sql`${t.role} IN ('owner', 'admin', 'member', 'viewer')`),
    check("household_members_status_ck", sql`${t.status} IN ('active', 'invited', 'suspended')`),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    csrfTokenHash: text("csrf_token_hash").notNull(),
    rotatedFromId: text("rotated_from_id").references((): AnySQLiteColumn => sessions.id, {
      onDelete: "set null",
    }),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    idleExpiresAt: text("idle_expires_at").notNull(),
    absoluteExpiresAt: text("absolute_expires_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull().default(now),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_uq").on(t.tokenHash),
    index("sessions_user_expiry_idx").on(t.userId, t.absoluteExpiresAt),
    index("sessions_rotated_from_idx").on(t.rotatedFromId),
    check("sessions_expiry_order_ck", sql`${t.idleExpiresAt} <= ${t.absoluteExpiresAt}`),
  ],
);

export const personalAccessTokens = sqliteTable(
  "personal_access_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    scopes: json<string[]>("scopes").notNull(),
    expiresAt: text("expires_at"),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("personal_access_tokens_token_hash_uq").on(t.tokenHash),
    index("personal_access_tokens_user_idx").on(t.userId, t.revokedAt),
  ],
);

export const invitations = sqliteTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    invitedByUserId: text("invited_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    email: text("email").notNull(),
    normalizedEmail: text("normalized_email").notNull(),
    role: text("role", { enum: ["admin", "member", "viewer"] }).notNull(),
    tokenHash: text("token_hash").notNull(),
    status: text("status", { enum: ["pending", "accepted", "revoked", "expired"] })
      .notNull()
      .default("pending"),
    expiresAt: text("expires_at").notNull(),
    acceptedAt: text("accepted_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("invitations_token_hash_uq").on(t.tokenHash),
    index("invitations_household_email_status_idx").on(t.householdId, t.normalizedEmail, t.status),
    check(
      "invitations_normalized_email_ck",
      sql`${t.normalizedEmail} = lower(trim(${t.normalizedEmail}))`,
    ),
    check("invitations_role_ck", sql`${t.role} IN ('admin', 'member', 'viewer')`),
    check(
      "invitations_status_ck",
      sql`${t.status} IN ('pending', 'accepted', 'revoked', 'expired')`,
    ),
  ],
);

// Connections, imports, and background work --------------------------------

export const connections = sqliteTable(
  "connections",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    credentialsCiphertext: blob("credentials_ciphertext", { mode: "buffer" }).notNull(),
    credentialsNonce: blob("credentials_nonce", { mode: "buffer" }).notNull(),
    credentialsAuthTag: blob("credentials_auth_tag", { mode: "buffer" }).notNull(),
    credentialsKeyVersion: text("credentials_key_version").notNull(),
    credentialsAad: text("credentials_aad").notNull(),
    status: text("status", { enum: ["active", "degraded", "reauth_required", "disabled"] })
      .notNull()
      .default("active"),
    capabilities: json<string[]>("capabilities").notNull(),
    syncCursor: text("sync_cursor"),
    lastAttemptAt: text("last_attempt_at"),
    lastSuccessAt: text("last_success_at"),
    lastErrorCode: text("last_error_code"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("connections_household_id_id_uq").on(t.householdId, t.id),
    index("connections_household_provider_status_idx").on(t.householdId, t.provider, t.status),
    index("connections_owner_idx").on(t.ownerUserId),
    check("connections_key_version_ck", sql`length(${t.credentialsKeyVersion}) > 0`),
    check(
      "connections_status_ck",
      sql`${t.status} IN ('active', 'degraded', 'reauth_required', 'disabled')`,
    ),
  ],
);

export const providerInstitutions = sqliteTable(
  "provider_institutions",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    connectionId: text("connection_id").notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    url: text("url"),
    logoUrl: text("logo_url"),
    metadata: json("metadata"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("provider_institutions_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("provider_institutions_connection_external_uq").on(t.connectionId, t.externalId),
    index("provider_institutions_household_name_idx").on(t.householdId, t.name),
    foreignKey({
      columns: [t.householdId, t.connectionId],
      foreignColumns: [connections.householdId, connections.id],
      name: "provider_institutions_household_connection_fk",
    }).onDelete("cascade"),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: json("payload").notNull(),
    state: text("state", { enum: ["queued", "leased", "succeeded", "failed", "cancelled"] })
      .notNull()
      .default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    scheduledAt: text("scheduled_at").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    leaseEpoch: integer("lease_epoch").notNull().default(0),
    heartbeatAt: text("heartbeat_at"),
    idempotencyKey: text("idempotency_key"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    completedAt: text("completed_at"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("jobs_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("jobs_household_idempotency_uq").on(t.householdId, t.idempotencyKey),
    index("jobs_claim_idx").on(t.state, t.scheduledAt, t.leaseExpiresAt),
    index("jobs_household_type_state_idx").on(t.householdId, t.type, t.state),
    check(
      "jobs_state_ck",
      sql`${t.state} IN ('queued', 'leased', 'succeeded', 'failed', 'cancelled')`,
    ),
    check(
      "jobs_attempts_ck",
      sql`${t.attempts} >= 0 AND ${t.maxAttempts} > 0 AND ${t.attempts} <= ${t.maxAttempts}`,
    ),
    check("jobs_lease_epoch_ck", sql`${t.leaseEpoch} >= 0`),
  ],
);

export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    connectionId: text("connection_id").notNull(),
    jobId: text("job_id"),
    trigger: text("trigger", { enum: ["manual", "scheduled", "initial", "retry"] }).notNull(),
    state: text("state", { enum: ["queued", "running", "succeeded", "failed", "cancelled"] })
      .notNull()
      .default("queued"),
    checkpointBefore: text("checkpoint_before"),
    checkpointAfter: text("checkpoint_after"),
    accountsSeen: integer("accounts_seen").notNull().default(0),
    balancesCreated: integer("balances_created").notNull().default(0),
    transactionsCreated: integer("transactions_created").notNull().default(0),
    transactionsUpdated: integer("transactions_updated").notNull().default(0),
    transactionsRemoved: integer("transactions_removed").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("sync_runs_household_id_id_uq").on(t.householdId, t.id),
    index("sync_runs_household_connection_created_idx").on(
      t.householdId,
      t.connectionId,
      t.createdAt,
    ),
    index("sync_runs_state_created_idx").on(t.state, t.createdAt),
    foreignKey({
      columns: [t.householdId, t.connectionId],
      foreignColumns: [connections.householdId, connections.id],
      name: "sync_runs_household_connection_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.householdId, t.jobId],
      foreignColumns: [jobs.householdId, jobs.id],
      name: "sync_runs_household_job_fk",
    }).onDelete("restrict"),
    check("sync_runs_trigger_ck", sql`${t.trigger} IN ('manual', 'scheduled', 'initial', 'retry')`),
    check(
      "sync_runs_state_ck",
      sql`${t.state} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
  ],
);

export const importRuns = sqliteTable(
  "import_runs",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    jobId: text("job_id"),
    format: text("format", { enum: ["csv", "qfx", "ofx", "fixture", "manual"] }).notNull(),
    fileHash: text("file_hash").notNull(),
    originalFilename: text("original_filename"),
    mapping: json("mapping"),
    state: text("state", {
      enum: ["preview", "queued", "running", "succeeded", "failed", "cancelled"],
    })
      .notNull()
      .default("preview"),
    totalRecords: integer("total_records").notNull().default(0),
    importedRecords: integer("imported_records").notNull().default(0),
    duplicateRecords: integer("duplicate_records").notNull().default(0),
    rejectedRecords: integer("rejected_records").notNull().default(0),
    errors: json<JsonObject[]>("errors"),
    committedAt: text("committed_at"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("import_runs_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("import_runs_household_file_hash_uq").on(t.householdId, t.fileHash),
    index("import_runs_household_created_idx").on(t.householdId, t.createdAt),
    foreignKey({
      columns: [t.householdId, t.jobId],
      foreignColumns: [jobs.householdId, jobs.id],
      name: "import_runs_household_job_fk",
    }).onDelete("restrict"),
    check("import_runs_format_ck", sql`${t.format} IN ('csv', 'qfx', 'ofx', 'fixture', 'manual')`),
    check(
      "import_runs_state_ck",
      sql`${t.state} IN ('preview', 'queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
    check(
      "import_runs_counts_ck",
      sql`${t.totalRecords} >= 0 AND ${t.importedRecords} >= 0 AND ${t.duplicateRecords} >= 0 AND ${t.rejectedRecords} >= 0`,
    ),
  ],
);

export const rawImportRecords = sqliteTable(
  "raw_import_records",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    importRunId: text("import_run_id").notNull(),
    rowNumber: integer("row_number").notNull(),
    externalId: text("external_id"),
    payload: json("payload"),
    payloadCiphertext: blob("payload_ciphertext", { mode: "buffer" }),
    payloadNonce: blob("payload_nonce", { mode: "buffer" }),
    payloadAuthTag: blob("payload_auth_tag", { mode: "buffer" }),
    payloadKeyVersion: text("payload_key_version"),
    payloadAad: text("payload_aad"),
    recordHash: text("record_hash").notNull(),
    status: text("status", { enum: ["pending", "accepted", "duplicate", "rejected"] })
      .notNull()
      .default("pending"),
    errorCode: text("error_code"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("raw_import_records_run_row_uq").on(t.importRunId, t.rowNumber),
    index("raw_import_records_household_hash_idx").on(t.householdId, t.recordHash),
    foreignKey({
      columns: [t.householdId, t.importRunId],
      foreignColumns: [importRuns.householdId, importRuns.id],
      name: "raw_import_records_household_run_fk",
    }).onDelete("cascade"),
    check("raw_import_records_row_number_ck", sql`${t.rowNumber} > 0`),
    check(
      "raw_import_records_status_ck",
      sql`${t.status} IN ('pending', 'accepted', 'duplicate', 'rejected')`,
    ),
    check(
      "raw_import_records_payload_mode_ck",
      sql`(${t.payload} IS NOT NULL AND ${t.payloadCiphertext} IS NULL) OR (${t.payload} IS NULL AND ${t.payloadCiphertext} IS NOT NULL AND ${t.payloadNonce} IS NOT NULL AND ${t.payloadAuthTag} IS NOT NULL AND length(${t.payloadKeyVersion}) > 0 AND ${t.payloadAad} IS NOT NULL)`,
    ),
  ],
);

// Ledger foundations --------------------------------------------------------

export const merchants = sqliteTable(
  "merchants",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    defaultCategoryId: text("default_category_id"),
    website: text("website"),
    logoUrl: text("logo_url"),
    metadata: json("metadata"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("merchants_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("merchants_household_normalized_name_uq").on(t.householdId, t.normalizedName),
    index("merchants_household_name_idx").on(t.householdId, t.name),
  ],
);

export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    parentId: text("parent_id").references((): AnySQLiteColumn => categories.id, {
      onDelete: "restrict",
    }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    kind: text("kind", { enum: ["income", "expense", "transfer", "debt", "investment"] }).notNull(),
    color: text("color"),
    icon: text("icon"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("categories_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("categories_household_slug_uq").on(t.householdId, t.slug),
    index("categories_household_parent_sort_idx").on(t.householdId, t.parentId, t.sortOrder),
    check(
      "categories_kind_ck",
      sql`${t.kind} IN ('income', 'expense', 'transfer', 'debt', 'investment')`,
    ),
    check("categories_not_self_parent_ck", sql`${t.parentId} IS NULL OR ${t.parentId} <> ${t.id}`),
  ],
);

export const merchantAliases = sqliteTable(
  "merchant_aliases",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    merchantId: text("merchant_id").notNull(),
    alias: text("alias").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
    source: text("source", { enum: ["user", "provider", "rule", "ai"] }).notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("merchant_aliases_household_alias_uq").on(t.householdId, t.normalizedAlias),
    index("merchant_aliases_household_merchant_idx").on(t.householdId, t.merchantId),
    foreignKey({
      columns: [t.householdId, t.merchantId],
      foreignColumns: [merchants.householdId, merchants.id],
      name: "merchant_aliases_household_merchant_fk",
    }).onDelete("cascade"),
    check("merchant_aliases_source_ck", sql`${t.source} IN ('user', 'provider', 'rule', 'ai')`),
  ],
);

export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    color: text("color"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("tags_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("tags_household_normalized_name_uq").on(t.householdId, t.normalizedName),
  ],
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    connectionId: text("connection_id"),
    institutionId: text("institution_id"),
    externalId: text("external_id"),
    name: text("name").notNull(),
    officialName: text("official_name"),
    mask: text("mask"),
    group: text("group", {
      enum: [
        "cash",
        "credit",
        "loan",
        "investment",
        "property",
        "vehicle",
        "crypto",
        "rewards",
        "custom",
      ],
    }).notNull(),
    type: text("type").notNull(),
    subtype: text("subtype"),
    currency: text("currency").notNull(),
    ownership: text("ownership", { enum: ["individual", "joint", "household", "business"] })
      .notNull()
      .default("household"),
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    includeInNetWorth: integer("include_in_net_worth", { mode: "boolean" }).notNull().default(true),
    includeInBudget: integer("include_in_budget", { mode: "boolean" }).notNull().default(true),
    isLiability: integer("is_liability", { mode: "boolean" }).notNull().default(false),
    isManual: integer("is_manual", { mode: "boolean" }).notNull().default(false),
    status: text("status", { enum: ["active", "closed", "hidden", "stale"] })
      .notNull()
      .default("active"),
    providerMetadata: json("provider_metadata"),
    lastReconciledAt: text("last_reconciled_at"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("accounts_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("accounts_connection_external_uq").on(t.connectionId, t.externalId),
    index("accounts_household_group_status_idx").on(t.householdId, t.group, t.status),
    index("accounts_household_institution_idx").on(t.householdId, t.institutionId),
    index("accounts_owner_idx").on(t.ownerUserId),
    foreignKey({
      columns: [t.householdId, t.connectionId],
      foreignColumns: [connections.householdId, connections.id],
      name: "accounts_household_connection_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.householdId, t.institutionId],
      foreignColumns: [providerInstitutions.householdId, providerInstitutions.id],
      name: "accounts_household_institution_fk",
    }).onDelete("restrict"),
    check(
      "accounts_group_ck",
      sql`${t.group} IN ('cash', 'credit', 'loan', 'investment', 'property', 'vehicle', 'crypto', 'rewards', 'custom')`,
    ),
    check("accounts_currency_ck", currencyCheck(t.currency)),
    check(
      "accounts_ownership_ck",
      sql`${t.ownership} IN ('individual', 'joint', 'household', 'business')`,
    ),
    check("accounts_status_ck", sql`${t.status} IN ('active', 'closed', 'hidden', 'stale')`),
  ],
);

export const balanceSnapshots = sqliteTable(
  "balance_snapshots",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    ledgerBalance: minorUnit("ledger_balance").notNull(),
    currentBalance: minorUnit("current_balance").notNull(),
    availableBalance: minorUnit("available_balance"),
    currency: text("currency").notNull(),
    asOf: text("as_of").notNull(),
    source: text("source", { enum: ["provider", "manual", "reconciliation", "import"] }).notNull(),
    syncRunId: text("sync_run_id"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("balance_snapshots_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("balance_snapshots_account_asof_source_uq").on(t.accountId, t.asOf, t.source),
    index("balance_snapshots_household_account_asof_idx").on(t.householdId, t.accountId, t.asOf),
    foreignKey({
      columns: [t.householdId, t.accountId],
      foreignColumns: [accounts.householdId, accounts.id],
      name: "balance_snapshots_household_account_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.householdId, t.syncRunId],
      foreignColumns: [syncRuns.householdId, syncRuns.id],
      name: "balance_snapshots_household_sync_fk",
    }).onDelete("restrict"),
    check("balance_snapshots_currency_ck", currencyCheck(t.currency)),
    check(
      "balance_snapshots_source_ck",
      sql`${t.source} IN ('provider', 'manual', 'reconciliation', 'import')`,
    ),
    ...moneyChecks("balance_snapshots", {
      ledger: t.ledgerBalance,
      current: t.currentBalance,
      available: t.availableBalance,
    }),
  ],
);

export const recurringSeries = sqliteTable(
  "recurring_series",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    merchantId: text("merchant_id"),
    accountId: text("account_id"),
    categoryId: text("category_id"),
    name: text("name").notNull(),
    kind: text("kind", {
      enum: ["income", "bill", "subscription", "transfer", "spending"],
    }).notNull(),
    cadence: text("cadence").notNull(),
    cadenceConfig: json("cadence_config"),
    amountMin: minorUnit("amount_min").notNull(),
    amountMax: minorUnit("amount_max").notNull(),
    currency: text("currency").notNull(),
    nextExpectedDate: text("next_expected_date"),
    lastObservedDate: text("last_observed_date"),
    confidenceBps: integer("confidence_bps").notNull().default(0),
    status: text("status", { enum: ["active", "paused", "ended", "needs_review"] })
      .notNull()
      .default("active"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("recurring_series_household_id_id_uq").on(t.householdId, t.id),
    index("recurring_series_household_next_status_idx").on(
      t.householdId,
      t.nextExpectedDate,
      t.status,
    ),
    index("recurring_series_household_merchant_idx").on(t.householdId, t.merchantId),
    foreignKey({
      columns: [t.householdId, t.merchantId],
      foreignColumns: [merchants.householdId, merchants.id],
      name: "recurring_series_household_merchant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.householdId, t.accountId],
      foreignColumns: [accounts.householdId, accounts.id],
      name: "recurring_series_household_account_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.householdId, t.categoryId],
      foreignColumns: [categories.householdId, categories.id],
      name: "recurring_series_household_category_fk",
    }).onDelete("restrict"),
    check(
      "recurring_series_kind_ck",
      sql`${t.kind} IN ('income', 'bill', 'subscription', 'transfer', 'spending')`,
    ),
    check(
      "recurring_series_status_ck",
      sql`${t.status} IN ('active', 'paused', 'ended', 'needs_review')`,
    ),
    check("recurring_series_confidence_ck", sql`${t.confidenceBps} BETWEEN 0 AND 10000`),
    check("recurring_series_currency_ck", currencyCheck(t.currency)),
    check(
      "recurring_series_amount_order_ck",
      sql`CAST(${t.amountMin} AS INTEGER) <= CAST(${t.amountMax} AS INTEGER)`,
    ),
    ...moneyChecks("recurring_series", { min: t.amountMin, max: t.amountMax }),
  ],
);

// Cash flow and envelope foundations ----------------------------------------

export const incomeSources = sqliteTable(
  "income_sources",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    merchantId: text("merchant_id"),
    accountId: text("account_id"),
    recurringSeriesId: text("recurring_series_id"),
    cadence: text("cadence").notNull(),
    cadenceConfig: json("cadence_config"),
    typicalAmount: minorUnit("typical_amount").notNull(),
    currency: text("currency").notNull(),
    nextExpectedDate: text("next_expected_date"),
    variabilityBps: integer("variability_bps").notNull().default(0),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    detectionRule: json("detection_rule"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("income_sources_household_id_id_uq").on(t.householdId, t.id),
    index("income_sources_household_next_idx").on(t.householdId, t.nextExpectedDate, t.isActive),
    foreignKey({
      columns: [t.householdId, t.merchantId],
      foreignColumns: [merchants.householdId, merchants.id],
      name: "income_sources_household_merchant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.householdId, t.accountId],
      foreignColumns: [accounts.householdId, accounts.id],
      name: "income_sources_household_account_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.householdId, t.recurringSeriesId],
      foreignColumns: [recurringSeries.householdId, recurringSeries.id],
      name: "income_sources_household_series_fk",
    }).onDelete("restrict"),
    check("income_sources_currency_ck", currencyCheck(t.currency)),
    check("income_sources_variability_ck", sql`${t.variabilityBps} BETWEEN 0 AND 100000`),
    ...moneyChecks("income_sources", { typical: t.typicalAmount }),
  ],
);

export const payCycles = sqliteTable(
  "pay_cycles",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    incomeSourceId: text("income_source_id").notNull(),
    startsOn: text("starts_on").notNull(),
    endsOn: text("ends_on").notNull(),
    expectedIncome: minorUnit("expected_income").notNull(),
    actualIncome: minorUnit("actual_income").notNull().default(zeroMinor),
    currency: text("currency").notNull(),
    status: text("status", { enum: ["projected", "open", "closed", "skipped"] })
      .notNull()
      .default("projected"),
    closedAt: text("closed_at"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("pay_cycles_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("pay_cycles_source_start_uq").on(t.incomeSourceId, t.startsOn),
    index("pay_cycles_household_dates_idx").on(t.householdId, t.startsOn, t.endsOn),
    foreignKey({
      columns: [t.householdId, t.incomeSourceId],
      foreignColumns: [incomeSources.householdId, incomeSources.id],
      name: "pay_cycles_household_income_source_fk",
    }).onDelete("cascade"),
    check("pay_cycles_dates_ck", sql`${t.startsOn} <= ${t.endsOn}`),
    check("pay_cycles_currency_ck", currencyCheck(t.currency)),
    check("pay_cycles_status_ck", sql`${t.status} IN ('projected', 'open', 'closed', 'skipped')`),
    ...moneyChecks("pay_cycles", { expected: t.expectedIncome, actual: t.actualIncome }),
  ],
);

export const budgetPeriods = sqliteTable(
  "budget_periods",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    payCycleId: text("pay_cycle_id"),
    kind: text("kind", { enum: ["month", "pay_cycle", "custom"] }).notNull(),
    startsOn: text("starts_on").notNull(),
    endsOn: text("ends_on").notNull(),
    currency: text("currency").notNull(),
    expectedIncome: minorUnit("expected_income").notNull().default(zeroMinor),
    actualIncome: minorUnit("actual_income").notNull().default(zeroMinor),
    status: text("status", { enum: ["draft", "open", "closed", "archived"] })
      .notNull()
      .default("draft"),
    closedAt: text("closed_at"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("budget_periods_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("budget_periods_household_kind_dates_uq").on(
      t.householdId,
      t.kind,
      t.startsOn,
      t.endsOn,
    ),
    index("budget_periods_household_status_dates_idx").on(t.householdId, t.status, t.startsOn),
    foreignKey({
      columns: [t.householdId, t.payCycleId],
      foreignColumns: [payCycles.householdId, payCycles.id],
      name: "budget_periods_household_pay_cycle_fk",
    }).onDelete("restrict"),
    check("budget_periods_kind_ck", sql`${t.kind} IN ('month', 'pay_cycle', 'custom')`),
    check("budget_periods_dates_ck", sql`${t.startsOn} <= ${t.endsOn}`),
    check("budget_periods_currency_ck", currencyCheck(t.currency)),
    check("budget_periods_status_ck", sql`${t.status} IN ('draft', 'open', 'closed', 'archived')`),
    ...moneyChecks("budget_periods", { expected: t.expectedIncome, actual: t.actualIncome }),
  ],
);

export const envelopes = sqliteTable(
  "envelopes",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    parentId: text("parent_id").references((): AnySQLiteColumn => envelopes.id, {
      onDelete: "restrict",
    }),
    categoryId: text("category_id"),
    name: text("name").notNull(),
    cadence: text("cadence").notNull(),
    cadenceConfig: json("cadence_config"),
    rolloverPolicy: text("rollover_policy", { enum: ["none", "positive", "all", "cap"] })
      .notNull()
      .default("positive"),
    rolloverCap: minorUnit("rollover_cap"),
    priority: integer("priority").notNull().default(100),
    minimumAmount: minorUnit("minimum_amount").notNull().default(zeroMinor),
    targetAmount: minorUnit("target_amount").notNull().default(zeroMinor),
    currency: text("currency").notNull(),
    isRequired: integer("is_required", { mode: "boolean" }).notNull().default(false),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("envelopes_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("envelopes_household_parent_name_uq").on(t.householdId, t.parentId, t.name),
    index("envelopes_household_priority_idx").on(t.householdId, t.isActive, t.priority),
    foreignKey({
      columns: [t.householdId, t.categoryId],
      foreignColumns: [categories.householdId, categories.id],
      name: "envelopes_household_category_fk",
    }).onDelete("restrict"),
    check("envelopes_not_self_parent_ck", sql`${t.parentId} IS NULL OR ${t.parentId} <> ${t.id}`),
    check(
      "envelopes_rollover_policy_ck",
      sql`${t.rolloverPolicy} IN ('none', 'positive', 'all', 'cap')`,
    ),
    check(
      "envelopes_rollover_cap_ck",
      sql`${t.rolloverPolicy} <> 'cap' OR ${t.rolloverCap} IS NOT NULL`,
    ),
    check("envelopes_currency_ck", currencyCheck(t.currency)),
    ...moneyChecks("envelopes", {
      rollover_cap: t.rolloverCap,
      minimum: t.minimumAmount,
      target: t.targetAmount,
    }),
  ],
);

export const envelopeCategoryLinks = sqliteTable(
  "envelope_category_links",
  {
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    envelopeId: text("envelope_id").notNull(),
    categoryId: text("category_id").notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.householdId, t.envelopeId, t.categoryId] }),
    index("envelope_category_links_category_idx").on(t.householdId, t.categoryId),
    foreignKey({
      columns: [t.householdId, t.envelopeId],
      foreignColumns: [envelopes.householdId, envelopes.id],
      name: "envelope_category_links_household_envelope_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.householdId, t.categoryId],
      foreignColumns: [categories.householdId, categories.id],
      name: "envelope_category_links_household_category_fk",
    }).onDelete("cascade"),
  ],
);

export const envelopeAllocations = sqliteTable(
  "envelope_allocations",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    budgetPeriodId: text("budget_period_id").notNull(),
    envelopeId: text("envelope_id").notNull(),
    planned: minorUnit("planned").notNull().default(zeroMinor),
    funded: minorUnit("funded").notNull().default(zeroMinor),
    activity: minorUnit("activity").notNull().default(zeroMinor),
    transferredIn: minorUnit("transferred_in").notNull().default(zeroMinor),
    transferredOut: minorUnit("transferred_out").notNull().default(zeroMinor),
    availableSnapshot: minorUnit("available_snapshot").notNull().default(zeroMinor),
    currency: text("currency").notNull(),
    calculatedAt: text("calculated_at").notNull().default(now),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("envelope_allocations_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("envelope_allocations_period_envelope_uq").on(t.budgetPeriodId, t.envelopeId),
    index("envelope_allocations_household_period_idx").on(t.householdId, t.budgetPeriodId),
    foreignKey({
      columns: [t.householdId, t.budgetPeriodId],
      foreignColumns: [budgetPeriods.householdId, budgetPeriods.id],
      name: "envelope_allocations_household_period_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.householdId, t.envelopeId],
      foreignColumns: [envelopes.householdId, envelopes.id],
      name: "envelope_allocations_household_envelope_fk",
    }).onDelete("cascade"),
    check("envelope_allocations_currency_ck", currencyCheck(t.currency)),
    ...moneyChecks("envelope_allocations", {
      planned: t.planned,
      funded: t.funded,
      activity: t.activity,
      transferred_in: t.transferredIn,
      transferred_out: t.transferredOut,
      available: t.availableSnapshot,
    }),
  ],
);

export const allocationEntries = sqliteTable(
  "allocation_entries",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    budgetPeriodId: text("budget_period_id"),
    batchId: text("batch_id").notNull(),
    sequence: integer("sequence").notNull(),
    fromBucketType: text("from_bucket_type", {
      enum: ["external", "unassigned", "envelope", "goal", "debt", "investing", "released"],
    }).notNull(),
    fromBucketId: text("from_bucket_id"),
    toBucketType: text("to_bucket_type", {
      enum: ["external", "unassigned", "envelope", "goal", "debt", "investing", "released"],
    }).notNull(),
    toBucketId: text("to_bucket_id"),
    amount: minorUnit("amount").notNull(),
    currency: text("currency").notNull(),
    kind: text("kind", {
      enum: ["fund", "reserve", "transfer", "release", "contribution", "adjustment"],
    }).notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id"),
    memo: text("memo"),
    reversalOfId: text("reversal_of_id").references((): AnySQLiteColumn => allocationEntries.id, {
      onDelete: "restrict",
    }),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("allocation_entries_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("allocation_entries_batch_sequence_uq").on(t.batchId, t.sequence),
    uniqueIndex("allocation_entries_reversal_uq").on(t.reversalOfId),
    index("allocation_entries_household_period_created_idx").on(
      t.householdId,
      t.budgetPeriodId,
      t.createdAt,
    ),
    index("allocation_entries_household_from_bucket_idx").on(
      t.householdId,
      t.fromBucketType,
      t.fromBucketId,
    ),
    index("allocation_entries_household_to_bucket_idx").on(
      t.householdId,
      t.toBucketType,
      t.toBucketId,
    ),
    foreignKey({
      columns: [t.householdId, t.budgetPeriodId],
      foreignColumns: [budgetPeriods.householdId, budgetPeriods.id],
      name: "allocation_entries_household_period_fk",
    }).onDelete("restrict"),
    check(
      "allocation_entries_bucket_types_ck",
      sql`${t.fromBucketType} IN ('external', 'unassigned', 'envelope', 'goal', 'debt', 'investing', 'released') AND ${t.toBucketType} IN ('external', 'unassigned', 'envelope', 'goal', 'debt', 'investing', 'released')`,
    ),
    check(
      "allocation_entries_distinct_buckets_ck",
      sql`${t.fromBucketType} <> ${t.toBucketType} OR coalesce(${t.fromBucketId}, '') <> coalesce(${t.toBucketId}, '')`,
    ),
    check("allocation_entries_amount_positive_ck", sql`CAST(${t.amount} AS INTEGER) > 0`),
    check("allocation_entries_currency_ck", currencyCheck(t.currency)),
    check(
      "allocation_entries_kind_ck",
      sql`${t.kind} IN ('fund', 'reserve', 'transfer', 'release', 'contribution', 'adjustment')`,
    ),
    ...moneyChecks("allocation_entries", { amount: t.amount }),
  ],
);

// Transactions and ledger relationships ------------------------------------

export const transactions = sqliteTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    connectionId: text("connection_id"),
    importRunId: text("import_run_id"),
    externalId: text("external_id"),
    pendingExternalId: text("pending_external_id"),
    amount: minorUnit("amount").notNull(),
    currency: text("currency").notNull(),
    authorizedAt: text("authorized_at"),
    postedAt: text("posted_at"),
    transactedOn: text("transacted_on").notNull(),
    rawDescription: text("raw_description").notNull(),
    normalizedDescription: text("normalized_description").notNull(),
    merchantId: text("merchant_id"),
    categoryId: text("category_id"),
    categoryOrigin: text("category_origin", {
      enum: ["user", "rule", "provider", "merchant_history", "ai", "none"],
    })
      .notNull()
      .default("none"),
    envelopeId: text("envelope_id"),
    recurringSeriesId: text("recurring_series_id"),
    status: text("status", { enum: ["pending", "posted", "removed", "void"] }).notNull(),
    source: text("source", { enum: ["provider", "import", "manual", "fixture"] }).notNull(),
    reviewState: text("review_state", { enum: ["none", "needs_review", "reviewed"] })
      .notNull()
      .default("none"),
    isExcluded: integer("is_excluded", { mode: "boolean" }).notNull().default(false),
    isTransfer: integer("is_transfer", { mode: "boolean" }).notNull().default(false),
    isIncome: integer("is_income", { mode: "boolean" }).notNull().default(false),
    isReimbursement: integer("is_reimbursement", { mode: "boolean" }).notNull().default(false),
    note: text("note"),
    providerCategory: text("provider_category"),
    providerMetadata: json("provider_metadata"),
    fingerprint: text("fingerprint"),
    firstSeenAt: text("first_seen_at").notNull().default(now),
    lastSeenAt: text("last_seen_at").notNull().default(now),
    removedUpstreamAt: text("removed_upstream_at"),
    userOverrideAt: text("user_override_at"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("transactions_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("transactions_connection_account_external_uq").on(
      t.connectionId,
      t.accountId,
      t.externalId,
    ),
    index("transactions_household_date_id_idx").on(t.householdId, t.transactedOn, t.id),
    index("transactions_household_account_date_idx").on(t.householdId, t.accountId, t.transactedOn),
    index("transactions_household_review_date_idx").on(
      t.householdId,
      t.reviewState,
      t.transactedOn,
    ),
    index("transactions_household_category_date_idx").on(
      t.householdId,
      t.categoryId,
      t.transactedOn,
    ),
    index("transactions_household_merchant_date_idx").on(
      t.householdId,
      t.merchantId,
      t.transactedOn,
    ),
    index("transactions_household_recurring_date_idx").on(
      t.householdId,
      t.recurringSeriesId,
      t.transactedOn,
    ),
    index("transactions_household_fingerprint_idx").on(t.householdId, t.accountId, t.fingerprint),
    index("transactions_pending_external_idx").on(t.connectionId, t.accountId, t.pendingExternalId),
    foreignKey({
      columns: [t.householdId, t.accountId],
      foreignColumns: [accounts.householdId, accounts.id],
      name: "transactions_household_account_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.householdId, t.connectionId],
      foreignColumns: [connections.householdId, connections.id],
      name: "transactions_household_connection_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.householdId, t.importRunId],
      foreignColumns: [importRuns.householdId, importRuns.id],
      name: "transactions_household_import_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.householdId, t.merchantId],
      foreignColumns: [merchants.householdId, merchants.id],
      name: "transactions_household_merchant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.householdId, t.categoryId],
      foreignColumns: [categories.householdId, categories.id],
      name: "transactions_household_category_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.householdId, t.envelopeId],
      foreignColumns: [envelopes.householdId, envelopes.id],
      name: "transactions_household_envelope_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.householdId, t.recurringSeriesId],
      foreignColumns: [recurringSeries.householdId, recurringSeries.id],
      name: "transactions_household_recurring_fk",
    }).onDelete("restrict"),
    check("transactions_amount_nonzero_ck", sql`CAST(${t.amount} AS INTEGER) <> 0`),
    check("transactions_currency_ck", currencyCheck(t.currency)),
    check(
      "transactions_category_origin_ck",
      sql`${t.categoryOrigin} IN ('user', 'rule', 'provider', 'merchant_history', 'ai', 'none')`,
    ),
    check("transactions_status_ck", sql`${t.status} IN ('pending', 'posted', 'removed', 'void')`),
    check(
      "transactions_source_ck",
      sql`${t.source} IN ('provider', 'import', 'manual', 'fixture')`,
    ),
    check(
      "transactions_review_state_ck",
      sql`${t.reviewState} IN ('none', 'needs_review', 'reviewed')`,
    ),
    ...moneyChecks("transactions", { amount: t.amount }),
  ],
);

export const transactionSplits = sqliteTable(
  "transaction_splits",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id").notNull(),
    sequence: integer("sequence").notNull(),
    amount: minorUnit("amount").notNull(),
    categoryId: text("category_id"),
    envelopeId: text("envelope_id"),
    memo: text("memo"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("transaction_splits_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("transaction_splits_transaction_sequence_uq").on(t.transactionId, t.sequence),
    index("transaction_splits_household_category_idx").on(t.householdId, t.categoryId),
    foreignKey({
      columns: [t.householdId, t.transactionId],
      foreignColumns: [transactions.householdId, transactions.id],
      name: "transaction_splits_household_transaction_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.householdId, t.categoryId],
      foreignColumns: [categories.householdId, categories.id],
      name: "transaction_splits_household_category_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.householdId, t.envelopeId],
      foreignColumns: [envelopes.householdId, envelopes.id],
      name: "transaction_splits_household_envelope_fk",
    }).onDelete("restrict"),
    check("transaction_splits_sequence_ck", sql`${t.sequence} >= 0`),
    check("transaction_splits_amount_nonzero_ck", sql`CAST(${t.amount} AS INTEGER) <> 0`),
    ...moneyChecks("transaction_splits", { amount: t.amount }),
  ],
);

export const transactionTags = sqliteTable(
  "transaction_tags",
  {
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id").notNull(),
    tagId: text("tag_id").notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.householdId, t.transactionId, t.tagId] }),
    index("transaction_tags_tag_idx").on(t.householdId, t.tagId),
    foreignKey({
      columns: [t.householdId, t.transactionId],
      foreignColumns: [transactions.householdId, transactions.id],
      name: "transaction_tags_household_transaction_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.householdId, t.tagId],
      foreignColumns: [tags.householdId, tags.id],
      name: "transaction_tags_household_tag_fk",
    }).onDelete("cascade"),
  ],
);

export const transfers = sqliteTable(
  "transfers",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    outflowTransactionId: text("outflow_transaction_id").notNull(),
    inflowTransactionId: text("inflow_transaction_id").notNull(),
    confidenceBps: integer("confidence_bps").notNull(),
    status: text("status", { enum: ["suggested", "confirmed", "rejected", "unmatched"] })
      .notNull()
      .default("suggested"),
    matchedBy: text("matched_by", { enum: ["provider", "fingerprint", "user"] }).notNull(),
    confirmedByUserId: text("confirmed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("transfers_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("transfers_outflow_uq").on(t.outflowTransactionId),
    uniqueIndex("transfers_inflow_uq").on(t.inflowTransactionId),
    index("transfers_household_status_idx").on(t.householdId, t.status),
    foreignKey({
      columns: [t.householdId, t.outflowTransactionId],
      foreignColumns: [transactions.householdId, transactions.id],
      name: "transfers_household_outflow_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.householdId, t.inflowTransactionId],
      foreignColumns: [transactions.householdId, transactions.id],
      name: "transfers_household_inflow_fk",
    }).onDelete("cascade"),
    check(
      "transfers_distinct_sides_ck",
      sql`${t.outflowTransactionId} <> ${t.inflowTransactionId}`,
    ),
    check("transfers_confidence_ck", sql`${t.confidenceBps} BETWEEN 0 AND 10000`),
    check(
      "transfers_status_ck",
      sql`${t.status} IN ('suggested', 'confirmed', 'rejected', 'unmatched')`,
    ),
    check("transfers_matched_by_ck", sql`${t.matchedBy} IN ('provider', 'fingerprint', 'user')`),
  ],
);

export const refundLinks = sqliteTable(
  "refund_links",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    refundTransactionId: text("refund_transaction_id").notNull(),
    purchaseTransactionId: text("purchase_transaction_id").notNull(),
    amount: minorUnit("amount").notNull(),
    confidenceBps: integer("confidence_bps").notNull(),
    status: text("status", { enum: ["suggested", "confirmed", "rejected"] })
      .notNull()
      .default("suggested"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("refund_links_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("refund_links_pair_uq").on(t.refundTransactionId, t.purchaseTransactionId),
    index("refund_links_household_status_idx").on(t.householdId, t.status),
    foreignKey({
      columns: [t.householdId, t.refundTransactionId],
      foreignColumns: [transactions.householdId, transactions.id],
      name: "refund_links_household_refund_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.householdId, t.purchaseTransactionId],
      foreignColumns: [transactions.householdId, transactions.id],
      name: "refund_links_household_purchase_fk",
    }).onDelete("cascade"),
    check(
      "refund_links_distinct_transactions_ck",
      sql`${t.refundTransactionId} <> ${t.purchaseTransactionId}`,
    ),
    check("refund_links_amount_positive_ck", sql`CAST(${t.amount} AS INTEGER) > 0`),
    check("refund_links_confidence_ck", sql`${t.confidenceBps} BETWEEN 0 AND 10000`),
    check("refund_links_status_ck", sql`${t.status} IN ('suggested', 'confirmed', 'rejected')`),
    ...moneyChecks("refund_links", { amount: t.amount }),
  ],
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id"),
    uploadedByUserId: text("uploaded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    objectPath: text("object_path").notNull(),
    originalFilename: text("original_filename").notNull(),
    contentHash: text("content_hash").notNull(),
    mediaType: text("media_type").notNull(),
    byteLength: integer("byte_length").notNull(),
    isEncrypted: integer("is_encrypted", { mode: "boolean" }).notNull().default(true),
    encryptionKeyVersion: integer("encryption_key_version"),
    metadata: json("metadata"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("attachments_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("attachments_household_content_hash_uq").on(t.householdId, t.contentHash),
    index("attachments_household_transaction_idx").on(t.householdId, t.transactionId),
    foreignKey({
      columns: [t.householdId, t.transactionId],
      foreignColumns: [transactions.householdId, transactions.id],
      name: "attachments_household_transaction_fk",
    }).onDelete("cascade"),
    check("attachments_byte_length_ck", sql`${t.byteLength} >= 0`),
    check(
      "attachments_encryption_key_ck",
      sql`${t.isEncrypted} = 0 OR (${t.encryptionKeyVersion} IS NOT NULL AND ${t.encryptionKeyVersion} > 0)`,
    ),
  ],
);

// Automation ----------------------------------------------------------------

export const rules = sqliteTable(
  "rules",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    priority: integer("priority").notNull().default(100),
    isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),
    origin: text("origin", { enum: ["user", "system", "ai"] })
      .notNull()
      .default("user"),
    conditions: json("conditions").notNull(),
    actions: json("actions").notNull(),
    specificityScore: integer("specificity_score").notNull().default(0),
    matchCount: integer("match_count").notNull().default(0),
    lastMatchedAt: text("last_matched_at"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("rules_household_id_id_uq").on(t.householdId, t.id),
    index("rules_household_evaluation_idx").on(
      t.householdId,
      t.isEnabled,
      t.priority,
      t.specificityScore,
      t.updatedAt,
    ),
    check("rules_origin_ck", sql`${t.origin} IN ('user', 'system', 'ai')`),
    check("rules_match_count_ck", sql`${t.matchCount} >= 0`),
  ],
);

export const envelopeRuleLinks = sqliteTable(
  "envelope_rule_links",
  {
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    envelopeId: text("envelope_id").notNull(),
    ruleId: text("rule_id").notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.householdId, t.envelopeId, t.ruleId] }),
    index("envelope_rule_links_rule_idx").on(t.householdId, t.ruleId),
    foreignKey({
      columns: [t.householdId, t.envelopeId],
      foreignColumns: [envelopes.householdId, envelopes.id],
      name: "envelope_rule_links_household_envelope_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.householdId, t.ruleId],
      foreignColumns: [rules.householdId, rules.id],
      name: "envelope_rule_links_household_rule_fk",
    }).onDelete("cascade"),
  ],
);

export const ruleRuns = sqliteTable(
  "rule_runs",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id").notNull(),
    winningRuleId: text("winning_rule_id"),
    competingRuleIds: json<string[]>("competing_rule_ids").notNull(),
    beforeSnapshot: json("before_snapshot").notNull(),
    afterSnapshot: json("after_snapshot").notNull(),
    explanation: text("explanation").notNull(),
    reversibleBatchId: text("reversible_batch_id"),
    revertedAt: text("reverted_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("rule_runs_household_id_id_uq").on(t.householdId, t.id),
    index("rule_runs_household_transaction_created_idx").on(
      t.householdId,
      t.transactionId,
      t.createdAt,
    ),
    index("rule_runs_household_rule_created_idx").on(t.householdId, t.winningRuleId, t.createdAt),
    index("rule_runs_reversible_batch_idx").on(t.householdId, t.reversibleBatchId),
    foreignKey({
      columns: [t.householdId, t.transactionId],
      foreignColumns: [transactions.householdId, transactions.id],
      name: "rule_runs_household_transaction_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.householdId, t.winningRuleId],
      foreignColumns: [rules.householdId, rules.id],
      name: "rule_runs_household_winning_rule_fk",
    }).onDelete("restrict"),
  ],
);

export const aiSuggestions = sqliteTable(
  "ai_suggestions",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id").notNull(),
    inputFingerprint: text("input_fingerprint").notNull(),
    suggestedMerchantName: text("suggested_merchant_name"),
    suggestedMerchantId: text("suggested_merchant_id"),
    suggestedCategoryId: text("suggested_category_id"),
    proposedRule: json("proposed_rule"),
    confidenceBps: integer("confidence_bps").notNull(),
    rationale: text("rationale").notNull(),
    status: text("status", { enum: ["pending", "accepted", "rejected", "expired", "invalid"] })
      .notNull()
      .default("pending"),
    model: text("model").notNull(),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: text("reviewed_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("ai_suggestions_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("ai_suggestions_transaction_fingerprint_uq").on(
      t.transactionId,
      t.inputFingerprint,
    ),
    index("ai_suggestions_household_status_created_idx").on(t.householdId, t.status, t.createdAt),
    foreignKey({
      columns: [t.householdId, t.transactionId],
      foreignColumns: [transactions.householdId, transactions.id],
      name: "ai_suggestions_household_transaction_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.householdId, t.suggestedMerchantId],
      foreignColumns: [merchants.householdId, merchants.id],
      name: "ai_suggestions_household_merchant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.householdId, t.suggestedCategoryId],
      foreignColumns: [categories.householdId, categories.id],
      name: "ai_suggestions_household_category_fk",
    }).onDelete("restrict"),
    check("ai_suggestions_confidence_ck", sql`${t.confidenceBps} BETWEEN 0 AND 10000`),
    check(
      "ai_suggestions_status_ck",
      sql`${t.status} IN ('pending', 'accepted', 'rejected', 'expired', 'invalid')`,
    ),
  ],
);

export const bills = sqliteTable(
  "bills",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    recurringSeriesId: text("recurring_series_id"),
    envelopeId: text("envelope_id"),
    autopayAccountId: text("autopay_account_id"),
    dueRule: json("due_rule").notNull(),
    amountMin: minorUnit("amount_min").notNull(),
    amountMax: minorUnit("amount_max").notNull(),
    currency: text("currency").notNull(),
    recurrenceConfidenceBps: integer("recurrence_confidence_bps").notNull().default(0),
    nextDueDate: text("next_due_date"),
    isRequired: integer("is_required", { mode: "boolean" }).notNull().default(true),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("bills_household_id_id_uq").on(t.householdId, t.id),
    index("bills_household_next_active_idx").on(t.householdId, t.nextDueDate, t.isActive),
    foreignKey({
      columns: [t.householdId, t.recurringSeriesId],
      foreignColumns: [recurringSeries.householdId, recurringSeries.id],
      name: "bills_household_recurring_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.householdId, t.envelopeId],
      foreignColumns: [envelopes.householdId, envelopes.id],
      name: "bills_household_envelope_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.householdId, t.autopayAccountId],
      foreignColumns: [accounts.householdId, accounts.id],
      name: "bills_household_autopay_account_fk",
    }).onDelete("restrict"),
    check(
      "bills_amount_order_ck",
      sql`CAST(${t.amountMin} AS INTEGER) <= CAST(${t.amountMax} AS INTEGER)`,
    ),
    check("bills_currency_ck", currencyCheck(t.currency)),
    check("bills_confidence_ck", sql`${t.recurrenceConfidenceBps} BETWEEN 0 AND 10000`),
    ...moneyChecks("bills", { min: t.amountMin, max: t.amountMax }),
  ],
);

// Goals and wealth -----------------------------------------------------------

export const goals = sqliteTable(
  "goals",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type", {
      enum: ["emergency_fund", "purchase", "debt_payoff", "investment_milestone", "custom"],
    }).notNull(),
    targetAmount: minorUnit("target_amount").notNull(),
    fundedAmount: minorUnit("funded_amount").notNull().default(zeroMinor),
    currency: text("currency").notNull(),
    targetDate: text("target_date"),
    priority: integer("priority").notNull().default(100),
    fundingAccountId: text("funding_account_id"),
    linkedDebtAccountId: text("linked_debt_account_id"),
    contributionPolicy: json("contribution_policy").notNull(),
    bufferPolicy: json("buffer_policy"),
    liquidityConstraint: text("liquidity_constraint", {
      enum: ["cash", "liquid", "investable", "any"],
    })
      .notNull()
      .default("liquid"),
    status: text("status", { enum: ["active", "paused", "completed", "cancelled"] })
      .notNull()
      .default("active"),
    completedAt: text("completed_at"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("goals_household_id_id_uq").on(t.householdId, t.id),
    index("goals_household_status_priority_idx").on(t.householdId, t.status, t.priority),
    foreignKey({
      columns: [t.householdId, t.fundingAccountId],
      foreignColumns: [accounts.householdId, accounts.id],
      name: "goals_household_funding_account_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.householdId, t.linkedDebtAccountId],
      foreignColumns: [accounts.householdId, accounts.id],
      name: "goals_household_debt_account_fk",
    }).onDelete("restrict"),
    check(
      "goals_type_ck",
      sql`${t.type} IN ('emergency_fund', 'purchase', 'debt_payoff', 'investment_milestone', 'custom')`,
    ),
    check("goals_target_positive_ck", sql`CAST(${t.targetAmount} AS INTEGER) > 0`),
    check("goals_currency_ck", currencyCheck(t.currency)),
    check(
      "goals_liquidity_ck",
      sql`${t.liquidityConstraint} IN ('cash', 'liquid', 'investable', 'any')`,
    ),
    check("goals_status_ck", sql`${t.status} IN ('active', 'paused', 'completed', 'cancelled')`),
    ...moneyChecks("goals", { target: t.targetAmount, funded: t.fundedAmount }),
  ],
);

export const goalContributions = sqliteTable(
  "goal_contributions",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    goalId: text("goal_id").notNull(),
    transactionId: text("transaction_id"),
    allocationEntryId: text("allocation_entry_id"),
    amount: minorUnit("amount").notNull(),
    currency: text("currency").notNull(),
    contributedOn: text("contributed_on").notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("goal_contributions_household_id_id_uq").on(t.householdId, t.id),
    index("goal_contributions_household_goal_date_idx").on(
      t.householdId,
      t.goalId,
      t.contributedOn,
    ),
    foreignKey({
      columns: [t.householdId, t.goalId],
      foreignColumns: [goals.householdId, goals.id],
      name: "goal_contributions_household_goal_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.householdId, t.transactionId],
      foreignColumns: [transactions.householdId, transactions.id],
      name: "goal_contributions_household_transaction_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.householdId, t.allocationEntryId],
      foreignColumns: [allocationEntries.householdId, allocationEntries.id],
      name: "goal_contributions_household_allocation_fk",
    }).onDelete("restrict"),
    check(
      "goal_contributions_provenance_ck",
      sql`(${t.transactionId} IS NOT NULL AND ${t.allocationEntryId} IS NULL) OR (${t.transactionId} IS NULL AND ${t.allocationEntryId} IS NOT NULL)`,
    ),
    check("goal_contributions_amount_positive_ck", sql`CAST(${t.amount} AS INTEGER) > 0`),
    check("goal_contributions_currency_ck", currencyCheck(t.currency)),
    ...moneyChecks("goal_contributions", { amount: t.amount }),
  ],
);

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type", {
      enum: ["property", "vehicle", "collectible", "business", "custom"],
    }).notNull(),
    liquidityClass: text("liquidity_class", { enum: ["illiquid", "restricted", "liquid"] })
      .notNull()
      .default("illiquid"),
    currency: text("currency").notNull(),
    linkedLiabilityAccountId: text("linked_liability_account_id"),
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    metadata: json("metadata"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("assets_household_id_id_uq").on(t.householdId, t.id),
    index("assets_household_type_active_idx").on(t.householdId, t.type, t.isActive),
    foreignKey({
      columns: [t.householdId, t.linkedLiabilityAccountId],
      foreignColumns: [accounts.householdId, accounts.id],
      name: "assets_household_liability_account_fk",
    }).onDelete("restrict"),
    check(
      "assets_type_ck",
      sql`${t.type} IN ('property', 'vehicle', 'collectible', 'business', 'custom')`,
    ),
    check(
      "assets_liquidity_class_ck",
      sql`${t.liquidityClass} IN ('illiquid', 'restricted', 'liquid')`,
    ),
    check("assets_currency_ck", currencyCheck(t.currency)),
  ],
);

export const assetValuations = sqliteTable(
  "asset_valuations",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    assetId: text("asset_id").notNull(),
    amount: minorUnit("amount").notNull(),
    currency: text("currency").notNull(),
    valuedOn: text("valued_on").notNull(),
    source: text("source", { enum: ["manual", "provider", "appraisal", "import"] }).notNull(),
    confidenceBps: integer("confidence_bps").notNull().default(10000),
    providerReference: text("provider_reference"),
    metadata: json("metadata"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("asset_valuations_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("asset_valuations_asset_date_source_uq").on(t.assetId, t.valuedOn, t.source),
    index("asset_valuations_household_asset_date_idx").on(t.householdId, t.assetId, t.valuedOn),
    foreignKey({
      columns: [t.householdId, t.assetId],
      foreignColumns: [assets.householdId, assets.id],
      name: "asset_valuations_household_asset_fk",
    }).onDelete("cascade"),
    check("asset_valuations_amount_nonnegative_ck", sql`CAST(${t.amount} AS INTEGER) >= 0`),
    check("asset_valuations_currency_ck", currencyCheck(t.currency)),
    check(
      "asset_valuations_source_ck",
      sql`${t.source} IN ('manual', 'provider', 'appraisal', 'import')`,
    ),
    check("asset_valuations_confidence_ck", sql`${t.confidenceBps} BETWEEN 0 AND 10000`),
    ...moneyChecks("asset_valuations", { amount: t.amount }),
  ],
);

export const holdings = sqliteTable(
  "holdings",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    externalId: text("external_id"),
    securityId: text("security_id").notNull(),
    symbol: text("symbol"),
    name: text("name").notNull(),
    securityType: text("security_type").notNull(),
    currency: text("currency").notNull(),
    providerMetadata: json("provider_metadata"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("holdings_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("holdings_account_security_uq").on(t.accountId, t.securityId),
    index("holdings_household_account_active_idx").on(t.householdId, t.accountId, t.isActive),
    foreignKey({
      columns: [t.householdId, t.accountId],
      foreignColumns: [accounts.householdId, accounts.id],
      name: "holdings_household_account_fk",
    }).onDelete("cascade"),
    check("holdings_currency_ck", currencyCheck(t.currency)),
  ],
);

export const holdingSnapshots = sqliteTable(
  "holding_snapshots",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    holdingId: text("holding_id").notNull(),
    quantity: text("quantity").notNull(),
    price: minorUnit("price").notNull(),
    marketValue: minorUnit("market_value").notNull(),
    costBasis: minorUnit("cost_basis"),
    currency: text("currency").notNull(),
    asOf: text("as_of").notNull(),
    source: text("source", { enum: ["provider", "manual", "import"] }).notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("holding_snapshots_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("holding_snapshots_holding_asof_source_uq").on(t.holdingId, t.asOf, t.source),
    index("holding_snapshots_household_holding_asof_idx").on(t.householdId, t.holdingId, t.asOf),
    foreignKey({
      columns: [t.householdId, t.holdingId],
      foreignColumns: [holdings.householdId, holdings.id],
      name: "holding_snapshots_household_holding_fk",
    }).onDelete("cascade"),
    check("holding_snapshots_quantity_ck", positiveDecimalCheck(t.quantity)),
    check("holding_snapshots_price_nonnegative_ck", sql`CAST(${t.price} AS INTEGER) >= 0`),
    check("holding_snapshots_value_nonnegative_ck", sql`CAST(${t.marketValue} AS INTEGER) >= 0`),
    check("holding_snapshots_currency_ck", currencyCheck(t.currency)),
    check("holding_snapshots_source_ck", sql`${t.source} IN ('provider', 'manual', 'import')`),
    ...moneyChecks("holding_snapshots", {
      price: t.price,
      market_value: t.marketValue,
      cost_basis: t.costBasis,
    }),
  ],
);

export const exchangeRates = sqliteTable(
  "exchange_rates",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    baseCurrency: text("base_currency").notNull(),
    quoteCurrency: text("quote_currency").notNull(),
    rate: text("rate").notNull(),
    effectiveAt: text("effective_at").notNull(),
    source: text("source").notNull(),
    providerReference: text("provider_reference"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("exchange_rates_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("exchange_rates_pair_effective_source_uq").on(
      t.householdId,
      t.baseCurrency,
      t.quoteCurrency,
      t.effectiveAt,
      t.source,
    ),
    index("exchange_rates_household_pair_effective_idx").on(
      t.householdId,
      t.baseCurrency,
      t.quoteCurrency,
      t.effectiveAt,
    ),
    check("exchange_rates_base_currency_ck", currencyCheck(t.baseCurrency)),
    check("exchange_rates_quote_currency_ck", currencyCheck(t.quoteCurrency)),
    check("exchange_rates_distinct_pair_ck", sql`${t.baseCurrency} <> ${t.quoteCurrency}`),
    check("exchange_rates_rate_ck", positiveDecimalCheck(t.rate)),
  ],
);

// Forecasting ---------------------------------------------------------------

export const forecastScenarios = sqliteTable(
  "forecast_scenarios",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    preset: text("preset", { enum: ["conservative", "baseline", "ambitious", "custom"] }).notNull(),
    assumptions: json("assumptions").notNull(),
    seed: text("seed").notNull(),
    horizonMonths: integer("horizon_months").notNull(),
    reportingCurrency: text("reporting_currency").notNull(),
    isBase: integer("is_base", { mode: "boolean" }).notNull().default(false),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("forecast_scenarios_household_id_id_uq").on(t.householdId, t.id),
    index("forecast_scenarios_household_active_idx").on(t.householdId, t.isActive, t.isBase),
    uniqueIndex("forecast_scenarios_one_base_uq").on(t.householdId).where(sql`${t.isBase} = 1`),
    check(
      "forecast_scenarios_preset_ck",
      sql`${t.preset} IN ('conservative', 'baseline', 'ambitious', 'custom')`,
    ),
    check("forecast_scenarios_horizon_ck", sql`${t.horizonMonths} BETWEEN 1 AND 1200`),
    check("forecast_scenarios_currency_ck", currencyCheck(t.reportingCurrency)),
  ],
);

export const forecastRuns = sqliteTable(
  "forecast_runs",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    scenarioId: text("scenario_id").notNull(),
    jobId: text("job_id"),
    inputVersionHash: text("input_version_hash").notNull(),
    engineVersion: text("engine_version").notNull(),
    state: text("state", { enum: ["queued", "running", "succeeded", "failed"] })
      .notNull()
      .default("queued"),
    runCount: integer("run_count").notNull().default(0),
    outputs: json("outputs"),
    percentileSeries: json("percentile_series"),
    readiness: json("readiness"),
    errorCode: text("error_code"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("forecast_runs_household_id_id_uq").on(t.householdId, t.id),
    index("forecast_runs_household_scenario_created_idx").on(
      t.householdId,
      t.scenarioId,
      t.createdAt,
    ),
    index("forecast_runs_input_version_idx").on(t.scenarioId, t.inputVersionHash, t.engineVersion),
    foreignKey({
      columns: [t.householdId, t.scenarioId],
      foreignColumns: [forecastScenarios.householdId, forecastScenarios.id],
      name: "forecast_runs_household_scenario_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.householdId, t.jobId],
      foreignColumns: [jobs.householdId, jobs.id],
      name: "forecast_runs_household_job_fk",
    }).onDelete("restrict"),
    check(
      "forecast_runs_state_ck",
      sql`${t.state} IN ('queued', 'running', 'succeeded', 'failed')`,
    ),
    check("forecast_runs_run_count_ck", sql`${t.runCount} >= 0 AND ${t.runCount} <= 100000`),
  ],
);

// Audit and settings ---------------------------------------------------------

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorType: text("actor_type", { enum: ["user", "system", "job", "token"] }).notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    requestId: text("request_id"),
    ipAddress: text("ip_address"),
    metadata: json("metadata").notNull(),
    occurredAt: text("occurred_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("audit_events_household_id_id_uq").on(t.householdId, t.id),
    index("audit_events_household_time_idx").on(t.householdId, t.occurredAt),
    index("audit_events_household_entity_idx").on(t.householdId, t.entityType, t.entityId),
    index("audit_events_actor_time_idx").on(t.actorUserId, t.occurredAt),
    check("audit_events_actor_type_ck", sql`${t.actorType} IN ('user', 'system', 'job', 'token')`),
  ],
);

export const settings = sqliteTable(
  "settings",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    scopeKey: text("scope_key").notNull(),
    key: text("key").notNull(),
    value: json<unknown>("value").notNull(),
    isSecret: integer("is_secret", { mode: "boolean" }).notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("settings_household_id_id_uq").on(t.householdId, t.id),
    uniqueIndex("settings_household_scope_key_uq").on(t.householdId, t.scopeKey, t.key),
    index("settings_user_idx").on(t.userId, t.key),
    check(
      "settings_scope_user_ck",
      sql`(${t.userId} IS NULL AND ${t.scopeKey} = 'household') OR (${t.userId} IS NOT NULL AND ${t.scopeKey} = ${t.userId})`,
    ),
  ],
);

export type User = typeof users.$inferSelect;
export type Household = typeof households.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type Envelope = typeof envelopes.$inferSelect;
export type Goal = typeof goals.$inferSelect;
export type ForecastScenario = typeof forecastScenarios.$inferSelect;
