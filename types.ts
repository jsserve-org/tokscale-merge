// Mirror of the TsTokenContributionData shape the tokscale CLI submits

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface SourceContribution {
  client: string;
  modelId: string;
  providerId?: string;
  tokens: TokenBreakdown;
  cost: number;
  messages: number;
}

export interface DailyTotals {
  tokens: number;
  cost: number;
  messages: number;
}

export interface DailyContribution {
  date: string; // "YYYY-MM-DD"
  totals: DailyTotals;
  intensity: number;
  tokenBreakdown: TokenBreakdown;
  clients: SourceContribution[];
}

export interface DateRange {
  start: string;
  end: string;
}

export interface YearSummary {
  year: string;
  totalTokens: number;
  totalCost: number;
  range: DateRange;
}

export interface DataSummary {
  totalTokens: number;
  totalCost: number;
  totalDays: number;
  activeDays: number;
  averagePerDay: number;
  maxCostInSingleDay: number;
  clients: string[];
  models: string[];
}

export interface ExportMeta {
  generatedAt: string;
  version: string;
  dateRange: DateRange;
}

export interface TokenContributionData {
  meta: ExportMeta;
  summary: DataSummary;
  years: YearSummary[];
  contributions: DailyContribution[];
}

// Internal store format: keyed by deviceId
export interface DeviceSubmission {
  deviceId: string;
  receivedAt: string;
  data: TokenContributionData;
}

export interface HubStore {
  submissions: Record<string, DeviceSubmission>;
  lastPushedAt: string | null;
}
