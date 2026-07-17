import type { RaccoonApi } from "./client";
import { FakeBackend } from "./mock/backend";

/**
 * 业务组件唯一入口（02 §2.2：只依赖 src/api，不直接拼接 URL）。
 * 后端阶段把 FakeBackend 换成 OpenAPI 生成客户端即可。
 */
let instance: RaccoonApi | null = null;

export function getApi(): RaccoonApi {
  instance ??= new FakeBackend();
  return instance;
}
