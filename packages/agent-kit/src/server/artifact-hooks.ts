import type { HookCallback, Options } from "@tencent-ai/agent-sdk";

/** Hooks run even when the CLI bypasses permission prompts. Keep them turn-local. */
export function createArtifactTrackingHooks(
  tracker: {
    before(name: string, input: Record<string, unknown>, id?: string): Promise<void>;
    after(name: string, input: Record<string, unknown>, id?: string): Promise<void>;
  },
  mapInput: (input: unknown) => Record<string, unknown>,
): NonNullable<Options["hooks"]> {
  const before: HookCallback = async (event, id) => {
    if (event.hook_event_name !== "PreToolUse") return { continue: true };
    const input = mapInput(event.tool_input);
    try {
      await tracker.before(event.tool_name, input, event.tool_use_id || id);
    } catch (error) {
      console.warn("[agent-kit] 文件变更快照采集失败:", error);
    }
    // Apply aliases here too: bypassPermissions does not invoke canUseTool.updatedInput.
    return {
      continue: true,
      hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: input },
    };
  };
  const after: HookCallback = async (event, id) => {
    if (event.hook_event_name !== "PostToolUse" && event.hook_event_name !== "PostToolUseFailure") {
      return { continue: true };
    }
    try {
      // Failed tools may have partially written files; inspect actual disk state.
      await tracker.after(event.tool_name, mapInput(event.tool_input), event.tool_use_id || id);
    } catch (error) {
      console.warn("[agent-kit] 文件变更登记失败:", error);
    }
    return { continue: true };
  };
  return {
    PreToolUse: [{ hooks: [before] }],
    PostToolUse: [{ hooks: [after] }],
    PostToolUseFailure: [{ hooks: [after] }],
  };
}
