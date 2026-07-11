import type { FormEvent } from "react";
import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { KeyRound } from "lucide-react";

interface TerminalAccessFormProps {
  busy: boolean;
  error: string | null;
  onAuthorize: (key: string) => Promise<boolean>;
  className?: string;
}

export default function TerminalAccessForm({
  busy,
  error,
  onAuthorize,
  className,
}: TerminalAccessFormProps) {
  const [accessKey, setAccessKey] = useState("");

  async function handleSubmit(event: FormEvent<HTMLElement>) {
    event.preventDefault();
    const unlocked = await onAuthorize(accessKey);
    if (unlocked) setAccessKey("");
  }

  return (
    <HStack
      as="form"
      className={className}
      gap={2}
      padding={3}
      align="center"
      onSubmit={(event) => void handleSubmit(event)}
    >
      <KeyRound size={16} />
      <TextInput
        label="终端密钥"
        value={accessKey}
        type="password"
        placeholder="输入启动密钥"
        onChange={setAccessKey}
      />
      <Button
        label="启用终端"
        type="submit"
        variant="primary"
        isLoading={busy}
        isDisabled={!accessKey.trim()}
      />
      <Text type="supporting" size="2xs">
        {error ?? "验证通过后可启动 Pi 登录终端"}
      </Text>
    </HStack>
  );
}
