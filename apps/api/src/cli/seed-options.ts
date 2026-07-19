export const SEED_DEMO_OVERRIDE_FLAG = "--i-know-this-is-demo-data";

export type SeedOptions = {
  allowProductionDemoData: boolean;
  help: boolean;
};

export function parseSeedArgs(args: string[]): SeedOptions {
  const options: SeedOptions = { allowProductionDemoData: false, help: false };
  for (const argument of args) {
    if (!argument) continue;
    if (argument === SEED_DEMO_OVERRIDE_FLAG) options.allowProductionDemoData = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

export function assertSeedAllowed(isProduction: boolean, options: SeedOptions): void {
  if (isProduction && !options.allowProductionDemoData) {
    throw new Error(
      "Refusing to seed the demo account (alex@example.com / publicly documented password) " +
        `into a production database. Re-run with ${SEED_DEMO_OVERRIDE_FLAG} only if this is a demo install.`,
    );
  }
}
