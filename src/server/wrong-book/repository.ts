import { persistenceSql as getSql } from "../persistence/request-scope";
import type { Timeframe } from "../../types/market";

export const WRONG_BOOK_TAGS = [
  "入场过早", "逆势交易", "假突破判断错误", "止损位置错误", "盈亏比问题", "追涨杀跌", "其他",
] as const;

export type WrongBookRow = {
  id: string;
  user_id: string;
  product_session_id: string;
  training_session_id: string;
  question_id: string;
  trade_id: string;
  symbol: string;
  timeframe: Timeframe;
  direction: "LONG" | "SHORT";
  entry: string;
  stop_loss: string;
  take_profit: string;
  exit_price: string;
  result_r: string;
  result_pnl: string;
  exit_reason: string;
  reveal_start_time: Date;
  reveal_end_time: Date;
  screenshot_path: string | null;
  thumbnail_path: string | null;
  storage_metadata: Record<string, unknown>;
  note: string;
  tags: string[];
  created_at: Date;
  updated_at: Date;
};

export async function reserveWrongBookEntry(input: {
  userId: string;
  productSessionId: string;
  trainingSessionId: string;
  timeframe: Timeframe;
  revealStartTime: number;
  revealEndTime: number;
}): Promise<{ row: WrongBookRow; alreadyUploaded: boolean }> {
  const sql = getSql();
  const [eligible] = await sql<(WrongBookRow & { runtime_mode: string; reveal_authorized_at: Date | null })[]>`
    select w.*, ts.runtime_mode, ts.reveal_authorized_at
    from training_sessions ts
    join sessions s on s.session_id = ts.product_session_id
    join question_pool q on q.question_id = ts.question_id
    join trades t on t.training_session_id = ts.session_id and t.session_id = s.session_id
    left join wrong_book_entries w on w.user_id = s.user_id and w.training_session_id = ts.session_id and w.trade_id = t.trade_id
    where s.user_id = ${input.userId}::uuid
      and s.session_id = ${input.productSessionId}::uuid
      and ts.session_id = ${input.trainingSessionId}::uuid
      and s.session_mode = 'RISK_TRAINING'
      and ts.runtime_mode = 'REVIEW'
      and ts.reveal_authorized_at is not null
      and t.exit_reason = 'STOP_LOSS'
    order by t.created_at desc limit 1
  `;
  if (!eligible) throw new Error("Wrong Book entry is not eligible.");
  if (eligible.id) return { row: eligible, alreadyUploaded: Boolean(eligible.screenshot_path) };

  const [row] = await sql<WrongBookRow[]>`
    insert into wrong_book_entries (
      id, user_id, product_session_id, training_session_id, question_id, trade_id,
      symbol, timeframe, direction, entry, stop_loss, take_profit, exit_price,
      result_r, result_pnl, exit_reason, reveal_start_time, reveal_end_time
    )
    select ${crypto.randomUUID()}::uuid, s.user_id, s.session_id, ts.session_id, ts.question_id, t.trade_id,
      q.symbol, ${input.timeframe}::market_timeframe, t.direction, t.entry_price, t.stop_loss, t.take_profit,
      t.exit_price, t.result_r, t.pnl, t.exit_reason,
      ${new Date(input.revealStartTime * 1000)}, ${new Date(input.revealEndTime * 1000)}
    from training_sessions ts
    join sessions s on s.session_id = ts.product_session_id
    join question_pool q on q.question_id = ts.question_id
    join trades t on t.training_session_id = ts.session_id and t.session_id = s.session_id
    where s.user_id = ${input.userId}::uuid and s.session_id = ${input.productSessionId}::uuid
      and ts.session_id = ${input.trainingSessionId}::uuid and s.session_mode = 'RISK_TRAINING'
      and ts.runtime_mode = 'REVIEW' and ts.reveal_authorized_at is not null and t.exit_reason = 'STOP_LOSS'
      and t.entry_price is not null and t.stop_loss is not null and t.take_profit is not null
      and t.exit_price is not null and t.result_r is not null and t.pnl is not null
    order by t.created_at desc limit 1
    on conflict (user_id, training_session_id, trade_id) do update set updated_at = wrong_book_entries.updated_at
    returning *
  `;
  if (!row) throw new Error("Wrong Book entry is not eligible.");
  return { row, alreadyUploaded: Boolean(row.screenshot_path) };
}

export async function completeWrongBookImage(userId: string, id: string, path: string, thumbnailPath: string, metadata: Record<string, unknown>): Promise<WrongBookRow> {
  const [row] = await getSql()<WrongBookRow[]>`
    update wrong_book_entries set screenshot_path = ${path}, thumbnail_path = ${thumbnailPath},
      storage_metadata = ${JSON.stringify(metadata)}::jsonb, updated_at = now()
    where id = ${id}::uuid and user_id = ${userId}::uuid returning *
  `;
  if (!row) throw new Error("Wrong Book entry not found.");
  return row;
}

export async function listWrongBookEntries(userId: string, page: number, pageSize = 20): Promise<{ rows: WrongBookRow[]; total: number }> {
  const sql = getSql();
  const offset = (page - 1) * pageSize;
  const [rows, count] = await Promise.all([
    sql<WrongBookRow[]>`select * from wrong_book_entries where user_id = ${userId}::uuid and screenshot_path is not null order by created_at desc limit ${pageSize} offset ${offset}`,
    sql<{ count: string }[]>`select count(*)::text as count from wrong_book_entries where user_id = ${userId}::uuid and screenshot_path is not null`,
  ]);
  return { rows, total: Number(count[0]?.count ?? 0) };
}

export async function getWrongBookEntry(userId: string, id: string): Promise<WrongBookRow | null> {
  const [row] = await getSql()<WrongBookRow[]>`select * from wrong_book_entries where id = ${id}::uuid and user_id = ${userId}::uuid`;
  return row ?? null;
}

export async function updateWrongBookReview(userId: string, id: string, note: string, tags: string[]): Promise<WrongBookRow | null> {
  const [row] = await getSql()<WrongBookRow[]>`
    update wrong_book_entries set note = ${note}, tags = ${getSql().json(tags)}, updated_at = now()
    where id = ${id}::uuid and user_id = ${userId}::uuid returning *
  `;
  return row ?? null;
}

export function serializeWrongBook(row: WrongBookRow) {
  return {
    id: row.id, symbol: row.symbol, timeframe: row.timeframe, direction: row.direction,
    entry: Number(row.entry), stopLoss: Number(row.stop_loss), takeProfit: Number(row.take_profit),
    exitPrice: Number(row.exit_price), resultR: Number(row.result_r), resultPnl: Number(row.result_pnl),
    exitReason: row.exit_reason, revealStartTime: row.reveal_start_time, revealEndTime: row.reveal_end_time,
    screenshotReady: Boolean(row.screenshot_path), note: row.note, tags: row.tags,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
