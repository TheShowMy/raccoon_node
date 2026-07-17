import type { FileTreeSeed } from "../files";

/**
 * 演示文件树（FE-FILE-001/002 走查素材）：
 * 3–4 层目录、文本/二进制/过大/非 UTF-8/受限路径各占一例。
 */
export const DEMO_FILE_TREE: FileTreeSeed[] = [
  {
    path: "src",
    kind: "directory",
    children: [
      {
        path: "src/main.rs",
        kind: "file",
        content: [
          "fn main() {",
          '    println!("raccoon-node demo");',
          "    raccoon::bootstrap::run();",
          "}",
        ].join("\n"),
      },
      {
        path: "src/workflow.rs",
        kind: "file",
        content: [
          "pub struct WorkPlan {",
          "    pub items: Vec<WorkItem>,",
          "}",
          "",
          "impl WorkPlan {",
          "    pub fn merge_tasks(&self) -> Vec<&WorkItem> {",
          "        self.items.iter().filter(|i| i.is_merge()).collect()",
          "    }",
          "}",
        ].join("\n"),
      },
      {
        path: "src/agent",
        kind: "directory",
        children: [
          {
            path: "src/agent/mod.rs",
            kind: "file",
            content: ["pub mod runtime;", "pub mod tools;"].join("\n"),
          },
          {
            path: "src/agent/tools.rs",
            kind: "file",
            content: [
              "pub enum Tool {",
              "    ListFiles,",
              "    ReadFile,",
              "    SearchText,",
              "    ApplyPatch,",
              "    RunCommand,",
              "    GitInspect,",
              "}",
            ].join("\n"),
          },
          {
            path: "src/agent/runtime",
            kind: "directory",
            children: [
              {
                path: "src/agent/runtime/loop.rs",
                kind: "file",
                content: [
                  "// Agent 工具循环：上下文从业务投影重建",
                  "pub fn run(request: AgentRunRequest) -> AgentRunResult {",
                  "    todo!()",
                  "}",
                ].join("\n"),
              },
            ],
          },
        ],
      },
    ],
  },
  {
    path: "docs",
    kind: "directory",
    children: [
      {
        path: "docs/rewrite",
        kind: "directory",
        children: [
          {
            path: "docs/rewrite/01-product-requirements.md",
            kind: "file",
            content: [
              "# Raccoon Node 产品需求文档",
              "",
              "单仓库、本地优先、完全节点化的需求到代码自动交付产品。",
              "五种模型角色：qa / clarifier / planner / implementer / reviewer。",
            ].join("\n"),
          },
          {
            path: "docs/rewrite/02-frontend-requirements.md",
            kind: "file",
            content: [
              "# Raccoon Node 前端开发需求",
              "",
              "中央对话节点图 + 射线外侧工作台。",
            ].join("\n"),
          },
        ],
      },
      {
        path: "docs/big-spec.md",
        kind: "file",
        size: 210 * 1024,
        preview: "too_large",
      },
    ],
  },
  {
    path: "frontend",
    kind: "directory",
    children: [
      {
        path: "frontend/package.json",
        kind: "file",
        content: [
          "{",
          '  "name": "raccoon-node-frontend",',
          '  "private": true',
          "}",
        ].join("\n"),
      },
      {
        path: "frontend/src",
        kind: "directory",
        children: [
          {
            path: "frontend/src/App.tsx",
            kind: "file",
            content: [
              "export function App() {",
              "  return <MainCanvas />;",
              "}",
            ].join("\n"),
          },
          {
            path: "frontend/src/theme",
            kind: "directory",
            children: [
              {
                path: "frontend/src/theme/tokens.css",
                kind: "file",
                content: [":root {", "  --px-primary: #2e9e5b;", "}"].join(
                  "\n",
                ),
              },
            ],
          },
        ],
      },
    ],
  },
  {
    path: "assets",
    kind: "directory",
    children: [
      {
        path: "assets/logo.png",
        kind: "file",
        size: 24_108,
        preview: "binary",
      },
    ],
  },
  {
    path: "data",
    kind: "directory",
    children: [
      {
        path: "data/legacy.bin",
        kind: "file",
        size: 4096,
        preview: "non_utf8",
      },
    ],
  },
  { path: ".git", kind: "directory", restricted: true },
  { path: ".raccoon-node", kind: "directory", restricted: true },
  { path: "node_modules", kind: "directory", restricted: true },
  {
    path: "Cargo.toml",
    kind: "file",
    content: ["[package]", 'name = "raccoon-node"', 'version = "2.0.0"'].join(
      "\n",
    ),
  },
  {
    path: "README.md",
    kind: "file",
    content: ["# raccoon-node demo", "", "演示仓库：文件工作台假数据。"].join(
      "\n",
    ),
  },
];
