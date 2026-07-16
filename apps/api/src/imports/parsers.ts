import { AppError } from "../lib/errors";

export type ImportedTransaction = {
  externalId?: string;
  postedAt: string;
  amount: string;
  description: string;
  memo?: string;
  pending?: boolean;
};

function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(value.trim());
      value = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(value.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      value = "";
    } else value += character;
  }
  if (quoted)
    throw new AppError("CSV contains an unterminated quoted field", 400, "invalid_import");
  row.push(value.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function parseCsvTransactions(input: string): ImportedTransaction[] {
  const rows = parseCsvRows(input.replace(/^\uFEFF/, ""));
  const header = rows.shift()?.map((column) => column.toLowerCase().replace(/[ _-]+/g, ""));
  if (!header) return [];
  const findIndex = (...names: string[]) => header.findIndex((column) => names.includes(column));
  const dateIndex = findIndex("date", "posted", "posteddate", "transactiondate");
  const amountIndex = findIndex("amount", "transactionamount");
  const debitIndex = findIndex("debit", "withdrawal");
  const creditIndex = findIndex("credit", "deposit");
  const descriptionIndex = findIndex("description", "merchant", "name", "payee");
  const memoIndex = findIndex("memo", "notes");
  const idIndex = findIndex("id", "transactionid", "fitid");
  if (
    dateIndex < 0 ||
    descriptionIndex < 0 ||
    (amountIndex < 0 && debitIndex < 0 && creditIndex < 0)
  ) {
    throw new AppError(
      "CSV needs date, description, and amount/debit/credit columns",
      400,
      "invalid_import",
    );
  }
  return rows.map((row, index) => {
    const rawDate = row[dateIndex] ?? "";
    const date = new Date(rawDate);
    if (Number.isNaN(date.getTime()))
      throw new AppError(`CSV row ${index + 2} has an invalid date`, 400, "invalid_import");
    let amount = row[amountIndex] ?? "";
    if (!amount) {
      const debit = (row[debitIndex] ?? "").replace(/[$,()]/g, "");
      const credit = (row[creditIndex] ?? "").replace(/[$,()]/g, "");
      amount = credit ? credit : debit ? `-${debit}` : "";
    }
    amount = amount.replace(/[$,]/g, "").replace(/^\((.*)\)$/, "-$1");
    if (!/^-?\d+(?:\.\d+)?$/.test(amount)) {
      throw new AppError(`CSV row ${index + 2} has an invalid amount`, 400, "invalid_import");
    }
    const externalId = row[idIndex];
    const memo = row[memoIndex];
    return {
      ...(externalId ? { externalId } : {}),
      postedAt: date.toISOString(),
      amount,
      description: row[descriptionIndex] || "Imported transaction",
      ...(memo ? { memo } : {}),
    };
  });
}

function firstTag(block: string, tag: string): string | undefined {
  const xmlMatch = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (xmlMatch?.[1]) return xmlMatch[1].trim();
  const sgmlMatch = block.match(new RegExp(`<${tag}>([^<\\r\\n]+)`, "i"));
  return sgmlMatch?.[1]?.trim();
}

export function parseOfxTransactions(input: string): ImportedTransaction[] {
  const blocks =
    input.match(/<STMTTRN>[\s\S]*?(?:<\/STMTTRN>|(?=<STMTTRN>|<\/BANKTRANLIST>))/gi) ?? [];
  if (blocks.length === 0)
    throw new AppError("No transactions were found in this OFX/QFX file", 400, "invalid_import");
  return blocks.map((block, index) => {
    const dateValue = firstTag(block, "DTPOSTED");
    const amount = firstTag(block, "TRNAMT");
    const description = firstTag(block, "NAME") ?? firstTag(block, "MEMO");
    if (!dateValue || !amount || !description) {
      throw new AppError(`OFX transaction ${index + 1} is incomplete`, 400, "invalid_import");
    }
    const match = dateValue.match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/);
    if (!match)
      throw new AppError(`OFX transaction ${index + 1} has an invalid date`, 400, "invalid_import");
    const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
    const postedAt = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`).toISOString();
    if (!/^-?\d+(?:\.\d+)?$/.test(amount)) {
      throw new AppError(
        `OFX transaction ${index + 1} has an invalid amount`,
        400,
        "invalid_import",
      );
    }
    const externalId = firstTag(block, "FITID");
    const memo = firstTag(block, "MEMO");
    return {
      ...(externalId ? { externalId } : {}),
      postedAt,
      amount,
      description,
      ...(memo ? { memo } : {}),
    };
  });
}

export function parseTransactionFile(name: string, content: string): ImportedTransaction[] {
  const extension = name.toLowerCase().split(".").pop();
  if (extension === "csv") return parseCsvTransactions(content);
  if (["ofx", "qfx"].includes(extension ?? "")) return parseOfxTransactions(content);
  throw new AppError("Use a CSV, OFX, or QFX file", 400, "unsupported_import");
}
