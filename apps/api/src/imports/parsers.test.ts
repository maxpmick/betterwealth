import { describe, expect, test } from "bun:test";
import { parseCsvTransactions, parseOfxTransactions } from "./parsers";

describe("transaction imports", () => {
  test("parses quoted CSV and debit/credit columns", () => {
    const rows = parseCsvTransactions(
      'Date,Description,Debit,Credit,Transaction ID\n2026-07-01,"Coffee, Inc",5.25,,abc\n2026-07-02,Payroll,,2200.00,def\n',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      amount: "-5.25",
      description: "Coffee, Inc",
      externalId: "abc",
    });
    expect(rows[1]?.amount).toBe("2200.00");
  });

  test("parses OFX SGML transactions", () => {
    const rows = parseOfxTransactions(`OFXHEADER:100\n<OFX><BANKTRANLIST>
      <STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260701120000<TRNAMT>-42.19<FITID>txn-1<NAME>GROCERY<MEMO>weekly</STMTTRN>
      </BANKTRANLIST></OFX>`);
    expect(rows).toEqual([
      {
        externalId: "txn-1",
        postedAt: "2026-07-01T12:00:00.000Z",
        amount: "-42.19",
        description: "GROCERY",
        memo: "weekly",
      },
    ]);
  });
});
