import {
  closeDatabase,
  householdMembers,
  households,
  openDatabase,
  runMigrations,
  users,
} from "@betterwealth/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { loadConfig } from "../config";
import { personalizeHousehold } from "../personalization/service";

type Options = {
  apply: boolean;
  aiBatches: number;
  aiBatchLimit: number;
  employerHint: string;
  starterProfile: boolean;
  rebaseManagedBudget: boolean;
  userEmail?: string;
  householdId?: string;
};

function integerArgument(value: string | undefined, name: string, maximum: number) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 0 to ${maximum}`);
  }
  return parsed;
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    apply: false,
    aiBatches: 12,
    aiBatchLimit: 25,
    employerHint: "Park Place Tech",
    starterProfile: true,
    rebaseManagedBudget: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--apply") options.apply = true;
    else if (argument === "--dry-run") options.apply = false;
    else if (argument === "--no-starter-profile") options.starterProfile = false;
    else if (argument === "--starter-profile") options.starterProfile = true;
    else if (argument === "--rebase-managed-budget") options.rebaseManagedBudget = true;
    else if (argument === "--ai-batches") {
      options.aiBatches = integerArgument(args[++index], "--ai-batches", 20);
    } else if (argument.startsWith("--ai-batches=")) {
      options.aiBatches = integerArgument(argument.split("=")[1], "--ai-batches", 20);
    } else if (argument === "--ai-limit") {
      options.aiBatchLimit = integerArgument(args[++index], "--ai-limit", 50);
    } else if (argument.startsWith("--ai-limit=")) {
      options.aiBatchLimit = integerArgument(argument.split("=")[1], "--ai-limit", 50);
    } else if (argument === "--employer") {
      options.employerHint = args[++index]?.trim() ?? "";
    } else if (argument.startsWith("--employer=")) {
      options.employerHint = argument.slice("--employer=".length).trim();
    } else if (argument === "--user-email") {
      const value = args[++index]?.trim().toLowerCase();
      if (value === undefined) throw new Error("--user-email requires a value");
      options.userEmail = value;
    } else if (argument.startsWith("--user-email=")) {
      options.userEmail = argument.slice("--user-email=".length).trim().toLowerCase();
    } else if (argument === "--household") {
      const value = args[++index]?.trim();
      if (value === undefined) throw new Error("--household requires a value");
      options.householdId = value;
    } else if (argument.startsWith("--household=")) {
      options.householdId = argument.slice("--household=".length).trim();
    } else if (argument === "--help" || argument === "-h") {
      console.log(
        [
          "BetterWealth personal plan generator",
          "",
          "  bun run personalize:dry-run",
          "  bun run personalize:apply",
          "",
          "Options:",
          "  --dry-run                 Analyze only (default)",
          "  --apply                   Apply the idempotent plan",
          "  --ai-batches <0-20>       Bounded AI batches (default 12)",
          "  --ai-limit <0-50>         Calls per batch (default 25)",
          "  --employer <name>         Payroll hint (default Park Place Tech)",
          "  --user-email <email>      Explicit active owner/admin user target",
          "  --household <id>          Explicit active household target",
          "  --no-starter-profile      Do not apply the editable age-22/30 starter assumptions",
          "  --rebase-managed-budget   Replace preserved generated allocation amounts with the latest evidence",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!options.employerHint) throw new Error("--employer must not be empty");
  if (options.userEmail === "") throw new Error("--user-email must not be empty");
  if (options.householdId === "") throw new Error("--household must not be empty");
  return options;
}

const options = parseArgs(process.argv.slice(2));
const config = loadConfig();
const db = openDatabase(config.databasePath);
try {
  runMigrations(db);
  const normalizedEmail =
    options.userEmail ?? config.BOOTSTRAP_USER_EMAIL?.trim().toLowerCase() ?? undefined;
  const targetConditions = [
    eq(users.status, "active"),
    eq(households.status, "active"),
    eq(householdMembers.status, "active"),
    inArray(householdMembers.role, ["owner", "admin"]),
  ];
  if (normalizedEmail) targetConditions.push(eq(users.normalizedEmail, normalizedEmail));
  if (options.householdId) targetConditions.push(eq(households.id, options.householdId));
  const targets = await db
    .select({
      userId: users.id,
      householdId: households.id,
      normalizedEmail: users.normalizedEmail,
      role: householdMembers.role,
    })
    .from(householdMembers)
    .innerJoin(users, eq(users.id, householdMembers.userId))
    .innerJoin(households, eq(households.id, householdMembers.householdId))
    .where(and(...targetConditions))
    .orderBy(asc(users.normalizedEmail), asc(households.id));
  if (targets.length === 0) {
    throw new Error("No active owner/admin personalization target matched the explicit selection");
  }
  if (targets.length !== 1) {
    throw new Error(
      "Personalization target is ambiguous; pass --user-email and --household to select exactly one active owner/admin membership",
    );
  }
  const target = targets[0]!;
  const result = await personalizeHousehold({
    db,
    config,
    householdId: target.householdId,
    userId: target.userId,
    apply: options.apply,
    aiBatches: options.apply ? options.aiBatches : 0,
    aiBatchLimit: options.aiBatchLimit,
    employerHint: options.employerHint,
    starterProfile: options.starterProfile,
    rebaseManagedBudget: options.rebaseManagedBudget,
  });
  // This contract intentionally contains only aggregate counts, ratios, and cadence. It never
  // prints account names, merchant names, transaction descriptions, balances, or credentials.
  console.log(JSON.stringify(result, null, 2));
} finally {
  closeDatabase(db);
}
