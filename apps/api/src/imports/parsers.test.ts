import { describe, expect, test } from "bun:test";
import { AppError } from "../lib/errors";
import { parseCsvTransactions, parseOfxTransactions, parseTransactionFile } from "./parsers";

function expectAppError(
  run: () => unknown,
  expected: { message: string; code: string; status: number },
) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.message).toBe(expected.message);
    expect(appError.code).toBe(expected.code);
    expect(appError.status).toBe(expected.status);
    return;
  }
  throw new Error(`Expected an AppError: ${expected.message}`);
}

const INVALID_IMPORT = { code: "invalid_import", status: 400 } as const;

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

  test("rejects a CSV with an unterminated quoted field", () => {
    expectAppError(
      () => parseCsvTransactions('Date,Description,Amount\n2026-07-01,"Coffee, Inc,5.25'),
      {
        message: "CSV contains an unterminated quoted field",
        ...INVALID_IMPORT,
      },
    );
  });

  test("rejects a CSV without the required date, description, and amount columns", () => {
    const expected = {
      message: "CSV needs date, description, and amount/debit/credit columns",
      ...INVALID_IMPORT,
    };
    // No recognizable columns at all.
    expectAppError(() => parseCsvTransactions("When,What\n2026-07-01,Coffee\n"), expected);
    // Date and amount but no description column.
    expectAppError(() => parseCsvTransactions("Date,Amount\n2026-07-01,5.25\n"), expected);
    // Date and description but no amount, debit, or credit column.
    expectAppError(() => parseCsvTransactions("Date,Description\n2026-07-01,Coffee\n"), expected);
  });

  test("rejects a CSV row with an invalid date and reports its line number", () => {
    expectAppError(
      () => parseCsvTransactions("Date,Description,Amount\nnot-a-date,Coffee,5.25\n"),
      { message: "CSV row 2 has an invalid date", ...INVALID_IMPORT },
    );
    expectAppError(
      () =>
        parseCsvTransactions(
          "Date,Description,Amount\n2026-07-01,Coffee,5.25\ntomorrow,Bakery,3.50\n",
        ),
      { message: "CSV row 3 has an invalid date", ...INVALID_IMPORT },
    );
  });

  test("rejects a CSV row with an invalid amount", () => {
    expectAppError(() => parseCsvTransactions("Date,Description,Amount\n2026-07-01,Coffee,abc\n"), {
      message: "CSV row 2 has an invalid amount",
      ...INVALID_IMPORT,
    });
    // An empty amount with no debit/credit fallback is invalid too.
    expectAppError(() => parseCsvTransactions("Date,Description,Amount\n2026-07-01,Coffee,\n"), {
      message: "CSV row 2 has an invalid amount",
      ...INVALID_IMPORT,
    });
  });

  test("normalizes currency symbols, thousands separators, and parenthesized negatives", () => {
    const rows = parseCsvTransactions(
      'Date,Description,Amount\n2026-07-01,Salary,"$2,400.50"\n2026-07-02,Refund,(123.45)\n',
    );
    expect(rows.map((row) => row.amount)).toEqual(["2400.50", "-123.45"]);

    const debitCredit = parseCsvTransactions(
      'Date,Description,Debit,Credit\n2026-07-03,Purchase,(45.00),\n2026-07-04,Deposit,,"$1,000.25"\n',
    );
    expect(debitCredit.map((row) => row.amount)).toEqual(["-45.00", "1000.25"]);
  });

  test("strips a byte-order mark before reading the CSV header", () => {
    const rows = parseCsvTransactions("\uFEFFDate,Description,Amount\n2026-07-01,Coffee,5.25\n");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: "5.25", description: "Coffee" });
  });

  test("returns no transactions for an empty or header-only CSV", () => {
    expect(parseCsvTransactions("")).toEqual([]);
    expect(parseCsvTransactions("Date,Description,Amount\n")).toEqual([]);
  });

  test("handles CRLF line endings and skips blank lines", () => {
    const rows = parseCsvTransactions(
      "Date,Description,Amount\r\n2026-07-01,Coffee,5.25\r\n\r\n2026-07-02,Bakery,3.50\r\n",
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]?.description).toBe("Bakery");
  });

  test("rejects an OFX file without any transactions", () => {
    expectAppError(
      () => parseOfxTransactions("OFXHEADER:100\n<OFX><BANKTRANLIST></BANKTRANLIST></OFX>"),
      {
        message: "No transactions were found in this OFX/QFX file",
        ...INVALID_IMPORT,
      },
    );
  });

  test("rejects an OFX transaction missing required fields", () => {
    // Missing TRNAMT.
    expectAppError(
      () => parseOfxTransactions("<STMTTRN><DTPOSTED>20260701120000<NAME>GROCERY</STMTTRN>"),
      { message: "OFX transaction 1 is incomplete", ...INVALID_IMPORT },
    );
    // Missing DTPOSTED.
    expectAppError(() => parseOfxTransactions("<STMTTRN><TRNAMT>-42.19<NAME>GROCERY</STMTTRN>"), {
      message: "OFX transaction 1 is incomplete",
      ...INVALID_IMPORT,
    });
    // Missing both NAME and MEMO (the description fallback).
    expectAppError(
      () => parseOfxTransactions("<STMTTRN><DTPOSTED>20260701120000<TRNAMT>-42.19</STMTTRN>"),
      { message: "OFX transaction 1 is incomplete", ...INVALID_IMPORT },
    );
    // The error reports the 1-based position of the offending transaction.
    expectAppError(
      () =>
        parseOfxTransactions(
          "<STMTTRN><DTPOSTED>20260701120000<TRNAMT>-1.00<NAME>A</STMTTRN>" +
            "<STMTTRN><DTPOSTED>20260701120000<NAME>B</STMTTRN>",
        ),
      { message: "OFX transaction 2 is incomplete", ...INVALID_IMPORT },
    );
  });

  test("rejects an OFX transaction with a malformed date", () => {
    expectAppError(
      () => parseOfxTransactions("<STMTTRN><DTPOSTED>not-a-date<TRNAMT>-1.00<NAME>A</STMTTRN>"),
      { message: "OFX transaction 1 has an invalid date", ...INVALID_IMPORT },
    );
    // Too few digits to satisfy YYYYMMDD.
    expectAppError(
      () => parseOfxTransactions("<STMTTRN><DTPOSTED>2026<TRNAMT>-1.00<NAME>A</STMTTRN>"),
      { message: "OFX transaction 1 has an invalid date", ...INVALID_IMPORT },
    );
  });

  test("rejects an OFX transaction with an invalid amount", () => {
    expectAppError(
      () => parseOfxTransactions("<STMTTRN><DTPOSTED>20260701120000<TRNAMT>abc<NAME>A</STMTTRN>"),
      { message: "OFX transaction 1 has an invalid amount", ...INVALID_IMPORT },
    );
  });

  test("parses XML-style OFX with closing tags", () => {
    const rows = parseOfxTransactions(
      "<OFX><BANKTRANLIST><STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20260702093000</DTPOSTED>" +
        "<TRNAMT>1200.00</TRNAMT><FITID>txn-2</FITID><NAME>PAYROLL</NAME></STMTTRN>" +
        "</BANKTRANLIST></OFX>",
    );
    expect(rows).toEqual([
      {
        externalId: "txn-2",
        postedAt: "2026-07-02T09:30:00.000Z",
        amount: "1200.00",
        description: "PAYROLL",
      },
    ]);
  });

  test("falls back to the OFX MEMO when NAME is missing", () => {
    const rows = parseOfxTransactions(
      "<STMTTRN><DTPOSTED>20260701<TRNAMT>-9.99<FITID>x<MEMO>Card purchase</STMTTRN>",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      postedAt: "2026-07-01T00:00:00.000Z",
      amount: "-9.99",
      description: "Card purchase",
      memo: "Card purchase",
    });
  });

  test("dispatches on the file extension and rejects unsupported types", () => {
    const unsupported = {
      message: "Use a CSV, OFX, or QFX file",
      code: "unsupported_import",
      status: 400,
    };
    expectAppError(() => parseTransactionFile("statement.pdf", "whatever"), unsupported);
    expectAppError(() => parseTransactionFile("no-extension", "whatever"), unsupported);

    // Extension matching is case-insensitive, and QFX is an accepted OFX dialect.
    expect(
      parseTransactionFile("UPPER.CSV", "Date,Description,Amount\n2026-07-01,Coffee,5.25"),
    ).toHaveLength(1);
    expectAppError(() => parseTransactionFile("empty.qfx", "nothing here"), {
      message: "No transactions were found in this OFX/QFX file",
      ...INVALID_IMPORT,
    });
  });
});
