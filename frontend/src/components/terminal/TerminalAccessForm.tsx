import type { FormEvent } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";

export interface TerminalAccessFormProps {
  accessKey: string;
  accessError: string | null;
  accessBusy: boolean;
  helperText?: string;
  submitLabel?: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLElement>) => void;
}

export default function TerminalAccessForm({
  accessKey,
  accessError,
  accessBusy,
  helperText = "授权有效期为 12 小时",
  submitLabel = "启用终端",
  onChange,
  onSubmit,
}: TerminalAccessFormProps) {
  return (
    <VStack
      as="form"
      gap={2}
      align="center"
      onSubmit={(event) => void onSubmit(event)}
    >
      <HStack gap={2} align="end" wrap="wrap" justify="center">
        <TextInput
          label="终端密钥"
          isLabelHidden
          type="password"
          value={accessKey}
          placeholder="输入启动密钥"
          onChange={onChange}
        />
        <Button
          type="submit"
          label={submitLabel}
          isLoading={accessBusy}
          isDisabled={!accessKey.trim()}
        />
      </HStack>
      <Text type="supporting" color="secondary">
        {accessError ?? helperText}
      </Text>
    </VStack>
  );
}
