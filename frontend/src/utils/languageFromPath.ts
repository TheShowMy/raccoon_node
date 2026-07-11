const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  jsx: "jsx",
  tsx: "tsx",
  json: "json",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "svg",
  css: "css",
  scss: "scss",
  less: "less",
  py: "python",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  php: "php",
  hack: "hack",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  markdown: "markdown",
};

export function getLanguageFromPath(path: string): string {
  const lastDot = path.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === path.length - 1) {
    return "plaintext";
  }
  const extension = path.slice(lastDot + 1).toLowerCase();
  return LANGUAGE_BY_EXTENSION[extension] ?? "plaintext";
}
