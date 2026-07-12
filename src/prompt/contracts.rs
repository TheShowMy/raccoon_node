#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PromptContract {
    ExecutionPlan,
    TaskResultImplementation,
    TaskResultReview,
    TaskResultReviewSummary,
    TaskResultBranchMerge,
    TaskResultMergeReview,
    RecoveryGuidance,
}

impl PromptContract {
    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::ExecutionPlan => "execution_plan",
            Self::TaskResultImplementation => "task_result_implementation",
            Self::TaskResultReview => "task_result_review",
            Self::TaskResultReviewSummary => "task_result_review_summary",
            Self::TaskResultBranchMerge => "task_result_branch_merge",
            Self::TaskResultMergeReview => "task_result_merge_review",
            Self::RecoveryGuidance => "recovery_guidance",
        }
    }
}

pub(crate) fn contract_text(contract: PromptContract) -> &'static str {
    match contract {
        PromptContract::ExecutionPlan => {
            include_str!("../../prompts/contracts/execution_plan.schema.json")
        }
        PromptContract::TaskResultImplementation => {
            include_str!("../../prompts/contracts/task_result_implementation.schema.json")
        }
        PromptContract::TaskResultReview => {
            include_str!("../../prompts/contracts/task_result_review.schema.json")
        }
        PromptContract::TaskResultReviewSummary => {
            include_str!("../../prompts/contracts/task_result_review_summary.schema.json")
        }
        PromptContract::TaskResultBranchMerge => {
            include_str!("../../prompts/contracts/task_result_branch_merge.schema.json")
        }
        PromptContract::TaskResultMergeReview => {
            include_str!("../../prompts/contracts/task_result_merge_review.schema.json")
        }
        PromptContract::RecoveryGuidance => {
            include_str!("../../prompts/contracts/recovery_guidance.schema.json")
        }
    }
}

/// 包装后的输出契约文本，用于直接作为 prompt source，避免裸 JSON 出现在模型输入中。
pub(crate) fn contract_source_text(contract: PromptContract) -> String {
    format!("## 输出契约（JSON 格式参考）\n{}", contract_text(contract))
}
