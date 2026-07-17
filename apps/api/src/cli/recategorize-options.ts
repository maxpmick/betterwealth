export type RecategorizeMode = "dry-run" | "apply" | "resume" | "preflight-only";

export type RecategorizeOptions = {
  mode: RecategorizeMode;
  batches: number;
  aiLimit: number;
  userEmail?: string;
  householdId?: string;
  help: boolean;
};

function integerArgument(value: string | undefined, name: string, maximum: number) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

export function parseRecategorizeArgs(args: string[]): RecategorizeOptions {
  const options: RecategorizeOptions = {
    mode: "dry-run",
    batches: 40,
    aiLimit: 25,
    help: false,
  };
  let explicitMode: RecategorizeMode | undefined;
  const selectMode = (mode: RecategorizeMode) => {
    if (explicitMode && explicitMode !== mode) {
      throw new Error("Choose exactly one of --dry-run, --preflight-only, --apply, or --resume");
    }
    explicitMode = mode;
    options.mode = mode;
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (argument === "--apply") selectMode("apply");
    else if (argument === "--resume") selectMode("resume");
    else if (argument === "--dry-run") selectMode("dry-run");
    else if (argument === "--preflight-only") selectMode("preflight-only");
    else if (argument === "--batches") {
      options.batches = integerArgument(args[++index], "--batches", 100);
    } else if (argument.startsWith("--batches=")) {
      options.batches = integerArgument(argument.split("=")[1], "--batches", 100);
    } else if (argument === "--ai-limit") {
      options.aiLimit = integerArgument(args[++index], "--ai-limit", 50);
    } else if (argument.startsWith("--ai-limit=")) {
      options.aiLimit = integerArgument(argument.split("=")[1], "--ai-limit", 50);
    } else if (argument === "--user-email") {
      const value = args[++index]?.trim().toLowerCase();
      if (!value) throw new Error("--user-email requires a value");
      options.userEmail = value;
    } else if (argument.startsWith("--user-email=")) {
      const value = argument.slice("--user-email=".length).trim().toLowerCase();
      if (!value) throw new Error("--user-email requires a value");
      options.userEmail = value;
    } else if (argument === "--household") {
      const value = args[++index]?.trim();
      if (!value) throw new Error("--household requires a value");
      options.householdId = value;
    } else if (argument.startsWith("--household=")) {
      const value = argument.slice("--household=".length).trim();
      if (!value) throw new Error("--household requires a value");
      options.householdId = value;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (options.mode === "resume" && !options.userEmail && !options.householdId) {
    throw new Error("--resume requires an explicit --user-email or --household target");
  }
  return options;
}
