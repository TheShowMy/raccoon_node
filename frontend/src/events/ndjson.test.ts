import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "../api/types";
import { createEventApplier } from "./applier";
import { createNdjsonDecoder } from "./ndjson";

const encoder = new TextEncoder();

function collectLines() {
  const lines: string[] = [];
  const decoder = createNdjsonDecoder({ onLine: (line) => lines.push(line) });
  return { lines, decoder };
}

describe("NDJSON 流式解析（FE-EVENT-002）", () => {
  it("一个事件跨多个 chunk", () => {
    const { lines, decoder } = collectLines();
    decoder.write(encoder.encode('{"a":1,"b"'));
    expect(lines).toEqual([]);
    decoder.write(encoder.encode(':"x"}\n{"c":2'));
    expect(lines).toEqual(['{"a":1,"b":"x"}']);
    decoder.write(encoder.encode("}\n"));
    expect(lines).toEqual(['{"a":1,"b":"x"}', '{"c":2}']);
  });

  it("多个事件同一 chunk", () => {
    const { lines, decoder } = collectLines();
    decoder.write(encoder.encode('{"a":1}\n{"b":2}\n{"c":3}\n'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("CRLF 换行", () => {
    const { lines, decoder } = collectLines();
    decoder.write(encoder.encode('{"a":1}\r\n{"b":2}\r\n'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("UTF-8 多字节字符跨 chunk 边界", () => {
    const { lines, decoder } = collectLines();
    const bytes = encoder.encode('{"msg":"汉字🦝"}\n');
    // 逐字节写入，强制多字节序列被切断
    for (const byte of bytes) {
      decoder.write(new Uint8Array([byte]));
    }
    expect(lines).toEqual(['{"msg":"汉字🦝"}']);
  });

  it("flush 丢弃尾部半行（可恢复截断）", () => {
    const { lines, decoder } = collectLines();
    decoder.write(encoder.encode('{"a":1}\n{"b":2'));
    decoder.flush();
    expect(lines).toEqual(['{"a":1}']);
  });

  it("空行被忽略", () => {
    const { lines, decoder } = collectLines();
    decoder.write(encoder.encode('{"a":1}\n\n\n{"b":2}\n'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});

function envelope(
  sequence: number,
  eventType = "notification.resolved",
): EventEnvelope {
  return {
    schema_version: 1,
    sequence,
    event_id: `e-${sequence}`,
    occurred_at: "2026-01-01T00:00:00Z",
    aggregate_type: "system",
    aggregate_id: "sys",
    event_type: eventType as EventEnvelope["event_type"],
    payload: { notification_id: "n", resolved_at: "now" },
  };
}

describe("全局 sequence 对账（FE-EVENT-003/006/007）", () => {
  it("重复事件按 sequence 去重", () => {
    const applied: number[] = [];
    const applier = createEventApplier(10, {
      apply: (e) => applied.push(e.sequence),
      onResyncNeeded: () => undefined,
    });
    applier.handle(envelope(11));
    applier.handle(envelope(11));
    applier.handle(envelope(10));
    applier.handle(envelope(12));
    expect(applied).toEqual([11, 12]);
    expect(applier.halted).toBe(false);
  });

  it("序号缺口：停止应用并触发 resync，不猜测缺失状态", () => {
    const applied: number[] = [];
    const reasons: string[] = [];
    const applier = createEventApplier(10, {
      apply: (e) => applied.push(e.sequence),
      onResyncNeeded: (reason) => reasons.push(reason),
    });
    applier.handle(envelope(11));
    applier.handle(envelope(13)); // 缺 12
    applier.handle(envelope(14)); // 已停止
    expect(applied).toEqual([11]);
    expect(reasons).toEqual(["gap"]);
    expect(applier.halted).toBe(true);
    expect(applier.expectedSequence).toBe(12);
  });

  it("system.resync_required：停止并触发 resync", () => {
    const reasons: string[] = [];
    const applier = createEventApplier(10, {
      apply: () => undefined,
      onResyncNeeded: (reason) => reasons.push(reason),
    });
    applier.handle(envelope(11, "system.resync_required"));
    expect(reasons).toEqual(["resync_required"]);
    expect(applier.halted).toBe(true);
  });

  it("未知 schema_version：版本不兼容路径", () => {
    const reasons: string[] = [];
    const applier = createEventApplier(10, {
      apply: () => undefined,
      onResyncNeeded: (reason) => reasons.push(reason),
    });
    applier.handle({ ...envelope(11), schema_version: 99 });
    expect(reasons).toEqual(["version"]);
    expect(applier.halted).toBe(true);
  });
});
