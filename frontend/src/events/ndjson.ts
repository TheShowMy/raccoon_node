/**
 * NDJSON 流式解析（FE-EVENT-002）：TextDecoder 保留未完成尾串，
 * 覆盖事件跨 chunk、多事件同 chunk、CRLF、UTF-8 多字节边界。
 */

export type NdjsonSink = {
  onLine: (line: string) => void;
};

export type NdjsonDecoder = {
  write: (chunk: Uint8Array) => void;
  /** 流结束时冲刷解码器与尾串（尾半行视为可恢复截断并丢弃） */
  flush: () => void;
};

export function createNdjsonDecoder(sink: NdjsonSink): NdjsonDecoder {
  const decoder = new TextDecoder("utf-8");
  let tail = "";

  const emitLines = (text: string) => {
    tail += text;
    let index = tail.indexOf("\n");
    while (index >= 0) {
      let line = tail.slice(0, index);
      tail = tail.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) sink.onLine(line);
      index = tail.indexOf("\n");
    }
  };

  return {
    write(chunk) {
      emitLines(decoder.decode(chunk, { stream: true }));
    },
    flush() {
      // 解码器内部可能滞留多字节序列的尾部字节
      emitLines(decoder.decode());
      // 尾部半行不是完整事件：丢弃，等待重连后按 sequence 重放（PRD-EVENT-008）
      tail = "";
    },
  };
}
