/**
 * 简易 diff 视图（等宽单色 + 增删行高亮）。
 * P2 合并 Diff 与 P3 Git 工作台 Diff 节点共用（FE-GIT-002）。
 */
export function DiffView({
  diff,
  ariaLabel,
}: {
  diff: string;
  ariaLabel: string;
}) {
  return (
    <pre className="dnode__diff nodrag nowheel" aria-label={ariaLabel}>
      {diff.split("\n").map((line, index) => (
        <code
          key={index}
          data-kind={
            line.startsWith("+")
              ? "add"
              : line.startsWith("-")
                ? "del"
                : line.startsWith("@@") ||
                    line.startsWith("diff") ||
                    line.startsWith("<<<<<<<") ||
                    line.startsWith("=======") ||
                    line.startsWith(">>>>>>>")
                  ? "hunk"
                  : undefined
          }
        >
          {line}
          {"\n"}
        </code>
      ))}
    </pre>
  );
}
