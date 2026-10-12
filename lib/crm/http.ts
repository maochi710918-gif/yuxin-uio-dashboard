import { type Actor, errorResponse, requireActor } from "./auth";

/** Wraps a CRM handler: resolves the signed-in actor server-side and maps errors to JSON. */
export function handler(fn: (actor: Actor, request: Request, url: URL) => Promise<unknown>) {
  return async (request: Request) => {
    try {
      const actor = await requireActor(request);
      const result = await fn(actor, request, new URL(request.url));
      return result instanceof Response ? result : Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- request bodies are validated field by field in each handler
export async function body<T = Record<string, any>>(request: Request) {
  try { return (await request.json()) as T; } catch { return {} as T; }
}

export function pageParams(url: URL, fallback = 25) {
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const pageSize = Math.min(200, Math.max(5, Number(url.searchParams.get("pageSize")) || fallback));
  return { page, pageSize };
}

export function csvResponse(name: string, header: string[], rows: unknown[][]) {
  const escape = (value: unknown) => { const text = value === null || value === undefined ? "" : String(value); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
  const content = "﻿" + [header, ...rows].map((row) => row.map(escape).join(",")).join("\r\n");
  return new Response(content, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, "Cache-Control": "no-store" } });
}

export async function xlsxResponse(name: string, sheetName: string, header: string[], rows: unknown[][]) {
  const XLSX = await import("xlsx");
  // Every cell is written as text so codes keep their leading zeros.
  const sheet = XLSX.utils.aoa_to_sheet([header, ...rows.map((row) => row.map((value) => (value === null || value === undefined ? "" : String(value))))]);
  sheet["!cols"] = header.map((key) => ({ wch: Math.min(36, Math.max(12, key.length * 2 + 4)) }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName);
  const bytes = XLSX.write(book, { bookType: "xlsx", type: "array", compression: true }) as ArrayBuffer;
  return new Response(bytes, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, "Cache-Control": "no-store" } });
}
