import { Skeleton, VStack } from "@astryxdesign/core";

export default function PanelSkeleton() {
  return (
    <VStack
      gap={3}
      padding={4}
      height="100%"
      aria-busy="true"
      aria-label="正在加载工作台"
    >
      <Skeleton width="40%" height={24} radius={2} />
      <Skeleton width="100%" height={16} index={1} />
      <Skeleton width="100%" height={16} index={2} />
      <Skeleton width="100%" height={16} index={3} />
      <Skeleton width="80%" height={16} index={4} />
      <Skeleton width="60%" height={16} index={5} />
    </VStack>
  );
}
