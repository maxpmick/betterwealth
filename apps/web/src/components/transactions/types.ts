import type { ApiRefundLinkMatch, ApiRule, ApiTransaction, ApiTransferMatch } from "../../api";
import type { LedgerItem } from "../../data";

export interface TransactionView extends LedgerItem {
  accountId: string;
  effectiveDate: string;
  amountMinorUnits: string;
  currency: string;
  status: ApiTransaction["status"];
  source: ApiTransaction["source"];
  tags: string[];
  isTransfer: boolean;
  isIncome: boolean;
  hasSplits: boolean;
  transferId?: string;
  refundLinkIds: string[];
  transferMatch?: ApiTransferMatch;
  refundLinkMatches: ApiRefundLinkMatch[];
}

export interface LedgerRangeFilters {
  minimum: string;
  maximum: string;
  fromDate: string;
  toDate: string;
}

export type TransactionAction = "split" | "transfer" | "refund" | "rule";

export interface SplitDraft {
  amountMinorUnits: string;
  categoryId?: string;
  envelopeId?: string;
  memo?: string;
}

export type RuleCreateInput = Omit<ApiRule, "id" | "matchCount">;

export interface RulePreview {
  matchCount: number;
  aggregateAmount: { minorUnits: string; currency: string };
  samples: ApiTransaction[];
  conflicts: ApiRule[];
}
