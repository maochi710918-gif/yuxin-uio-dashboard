"use client";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function apiGet<T>(path: string, params: Record<string, string | number | boolean | undefined | null> = {}): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "" && value !== false) query.set(key, String(value));
  const response = await fetch(`${path}${query.size ? `?${query}` : ""}`, { cache: "no-store" });
  return parse<T>(response);
}

export async function apiPost<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return parse<T>(response);
}

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: "伺服器回應格式錯誤" }; }
  if (!response.ok) throw new ApiError(response.status, (data as { error?: string })?.error || `請求失敗（${response.status}）`);
  return data as T;
}

export function download(path: string, params: Record<string, string> = {}) {
  const link = document.createElement("a");
  link.href = `${path}?${new URLSearchParams(params)}`;
  link.download = "";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** SHA-256 of a file, used for 重複匯入防護. */
export async function fileHash(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Reads CSV/XLSX into header + rows of text (codes stay text; leading zeros are kept). */
export async function readSheet(file: File): Promise<{ header: string[]; rows: string[][] }> {
  const XLSX = await import("xlsx");
  const isCsv = /\.csv$/i.test(file.name);
  const book = isCsv ? XLSX.read(await file.text(), { type: "string", raw: true }) : XLSX.read(await file.arrayBuffer(), { type: "array", raw: false, cellDates: false });
  const sheet = book.Sheets[book.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "", blankrows: false });
  const [header = [], ...rows] = matrix.map((row) => row.map((cell) => String(cell ?? "").trim()));
  return { header, rows: rows.filter((row) => row.some(Boolean)) };
}

export const fmtNumber = (value: unknown) => (value === null || value === undefined || value === "" ? "資料不足" : new Intl.NumberFormat("zh-TW").format(Number(value)));
export const fmtMoney = (value: unknown) => (value === null || value === undefined || value === "" ? "資料不足" : new Intl.NumberFormat("zh-TW", { style: "currency", currency: "TWD", maximumFractionDigits: 0 }).format(Number(value)));
export const fmtPct = (value: unknown) => (value === null || value === undefined ? "資料不足" : `${Number(value).toFixed(1)}%`);
