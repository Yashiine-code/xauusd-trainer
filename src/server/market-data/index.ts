import { FileMarketDataService, FileQuestionPoolService } from "./file-service";
import { PostgresMarketDataService, PostgresQuestionPoolService } from "./postgres-service";
import {
  hasSupabaseHttpConfiguration,
  SupabaseRestMarketDataService,
  SupabaseRestQuestionPoolService,
} from "./supabase-rest-service";
import { R2MarketDataService } from "./r2-service";
import type { MarketDataService, QuestionPoolService } from "./types";
import { createDatabaseDiagnostics, type DatabaseDiagnostics } from "./diagnostics.ts";

export type MarketDataMode = "file" | "postgres" | "r2";

export function getMarketDataMode(): MarketDataMode {
  if (process.env.MARKET_DATA_MODE === "postgres") return "postgres";
  if (process.env.MARKET_DATA_MODE === "r2") return "r2";
  return "file";
}

export function usesPersistentProductState(): boolean {
  return getMarketDataMode() !== "file";
}

let marketDataService: MarketDataService | undefined;
let questionPoolService: QuestionPoolService | undefined;
let adapterLogged = false;

export type MarketDataAdapter = "FILE" | "R2_PRIVATE_CACHE" | "SUPABASE_HTTP" | "POSTGRES_PROCESS_POOL" | "POSTGRES_REQUEST_TCP";

function shouldUseSupabaseHttpMarketData(): boolean {
  return process.env.PERSISTENCE_MODE !== "tcp" && hasSupabaseHttpConfiguration();
}

export function getMarketDataAdapter(): MarketDataAdapter {
  if (getMarketDataMode() === "file") return "FILE";
  if (getMarketDataMode() === "r2") return "R2_PRIVATE_CACHE";
  if (shouldUseSupabaseHttpMarketData()) return "SUPABASE_HTTP";
  return shouldReuseProcessClient() ? "POSTGRES_PROCESS_POOL" : "POSTGRES_REQUEST_TCP";
}

function logMarketDataAdapter(): void {
  if (adapterLogged) return;
  adapterLogged = true;
  console.info(`MARKET DATA ADAPTER = ${getMarketDataAdapter()}`);
}

export type MarketDataRequestContext = {
  market: MarketDataService;
  questions: QuestionPoolService;
  diagnostics: DatabaseDiagnostics;
};

function createDatabaseQuestionPool(diagnostics?: DatabaseDiagnostics): QuestionPoolService {
  if (shouldUseSupabaseHttpMarketData()) return new SupabaseRestQuestionPoolService(diagnostics);
  if (shouldReuseProcessClient()) return new PostgresQuestionPoolService(undefined, diagnostics);
  return new PostgresQuestionPoolService(createRequestSqlClient(), diagnostics);
}

class LazyDatabaseQuestionPool implements QuestionPoolService {
  private delegate?: QuestionPoolService;
  private readonly diagnostics?: DatabaseDiagnostics;

  constructor(diagnostics?: DatabaseDiagnostics) {
    this.diagnostics = diagnostics;
  }

  allocate(symbol: string) {
    this.delegate ??= createDatabaseQuestionPool(this.diagnostics);
    return this.delegate.allocate(symbol);
  }
}

export function getMarketDataRequestContext(diagnostics = createDatabaseDiagnostics()): MarketDataRequestContext {
  logMarketDataAdapter();
  if (getMarketDataMode() === "file") {
    return { market: getMarketDataService(), questions: getQuestionPoolService(), diagnostics };
  }
  if (getMarketDataMode() === "r2") {
    return {
      market: new R2MarketDataService(),
      questions: new LazyDatabaseQuestionPool(diagnostics),
      diagnostics,
    };
  }
  if (shouldUseSupabaseHttpMarketData()) {
    return {
      market: new SupabaseRestMarketDataService(diagnostics),
      questions: new SupabaseRestQuestionPoolService(diagnostics),
      diagnostics,
    };
  }
  if (shouldReuseProcessClient()) {
    return {
      market: new PostgresMarketDataService(undefined, diagnostics),
      questions: new PostgresQuestionPoolService(undefined, diagnostics),
      diagnostics,
    };
  }
  const sql = createRequestSqlClient();
  return {
    market: new PostgresMarketDataService(sql, diagnostics),
    questions: new PostgresQuestionPoolService(sql, diagnostics),
    diagnostics,
  };
}

export function getMarketDataService(): MarketDataService {
  logMarketDataAdapter();
  marketDataService ??= getMarketDataMode() === "r2"
    ? new R2MarketDataService()
    : getMarketDataMode() === "postgres"
      ? shouldUseSupabaseHttpMarketData()
        ? new SupabaseRestMarketDataService()
        : new PostgresMarketDataService()
      : new FileMarketDataService();
  return marketDataService;
}

export function getQuestionPoolService(): QuestionPoolService {
  logMarketDataAdapter();
  questionPoolService ??= getMarketDataMode() === "file"
    ? new FileQuestionPoolService()
    : createDatabaseQuestionPool();
  return questionPoolService;
}

export type { MarketDataQuery, MarketDataService, QuestionCandidate } from "./types";
import { createRequestSqlClient, shouldReuseProcessClient } from "../../../db/index.ts";
