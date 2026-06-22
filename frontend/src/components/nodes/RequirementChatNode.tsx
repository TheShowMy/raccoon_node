import type { StartNodeData } from "../../types/api";
import RequirementConversationWorkbench from "../requirements/RequirementConversation";

export default function RequirementChatNode({
  data,
}: {
  data: Extract<StartNodeData, { kind: "requirement-chat" }>;
}) {
  const conversation =
    data.conversation?.id === data.requirement?.id ? data.conversation : null;
  const prompt = data.promptDismissed ? null : (conversation?.prompt ?? null);

  return (
    <RequirementConversationWorkbench
      conversation={conversation}
      requirement={data.requirement}
      projectName={data.project.name}
      prompt={prompt}
      promptDismissed={data.promptDismissed}
      input={data.input}
      busy={data.busy}
      error={data.error}
      streamEvents={data.streamEvents}
      answers={data.answers}
      onInputChange={data.onInputChange}
      onSend={data.onSend}
      onAnswerChange={data.onAnswerChange}
      onSubmitClarifications={data.onSubmitClarifications}
      onConfirm={data.onConfirm}
      onContinueEditing={data.onContinueEditing}
    />
  );
}
