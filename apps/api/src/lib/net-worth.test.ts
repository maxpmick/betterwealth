import { expect, test } from "bun:test";
import {
  isRetirementAccount,
  liquidAccountContribution,
  liquidAssetContribution,
} from "./net-worth";

const baseAccount = {
  name: "Account",
  officialName: null,
  type: "checking",
  subtype: null,
  includeInNetWorth: true,
  isLiability: false,
  status: "active" as const,
};

test("liquid planning and reports share one retirement and liability invariant", () => {
  expect(liquidAccountContribution({ ...baseAccount, group: "cash" }, 250_000n)).toBe(250_000n);
  expect(
    liquidAccountContribution(
      { ...baseAccount, name: "Taxable brokerage", type: "brokerage", group: "investment" },
      123_400n,
    ),
  ).toBe(123_400n);

  const roth = { ...baseAccount, name: "Roth IRA", type: "ira", group: "investment" };
  expect(isRetirementAccount(roth)).toBeTrue();
  expect(liquidAccountContribution(roth, 4_831_300n)).toBe(0n);

  expect(
    liquidAccountContribution(
      { ...baseAccount, group: "credit", type: "credit_card", isLiability: true },
      20_000n,
    ),
  ).toBe(-20_000n);
  expect(
    liquidAccountContribution(
      { ...baseAccount, group: "loan", type: "student_loan", isLiability: true },
      70_000n,
    ),
  ).toBe(0n);
  expect(liquidAssetContribution({ liquidityClass: "liquid", isActive: true }, 45_000n)).toBe(
    45_000n,
  );
});

test("hidden and closed accounts contribute nothing without changing inclusion intent", () => {
  expect(
    liquidAccountContribution({ ...baseAccount, group: "cash", status: "hidden" }, 900_000n),
  ).toBe(0n);
  expect(
    liquidAccountContribution({ ...baseAccount, group: "cash", status: "closed" }, 700_000n),
  ).toBe(0n);
  expect(
    liquidAccountContribution({ ...baseAccount, group: "cash", status: "stale" }, 100_000n),
  ).toBe(100_000n);
});
